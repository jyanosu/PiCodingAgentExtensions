# Plan: Working-Dir Navigation Guard (danger-guard)

Source spec: `docs/parent-dir-guard/spec.md` (decision-complete).

**Locked decision (D1):** flag any `cd`/`pushd` target that resolves outside
the `ctx.cwd` subtree (ancestors, root, siblings, home, `/tmp`). Allowed =
`cwd` itself or a descendant. No other open decisions — D2–D5 are defaulted
in the spec.

**Shared contract (spans tasks 1→2):**

- Function: `findOutsideNavigation(command: string, cwd: string): string | null`
  — returns the first offending target string, or `null`.
- Flag name string: `cd outside working dir` (used in dialog + block reason).
- New imports needed in `extensions/danger-guard.ts`:
  `import { homedir } from "node:os";` and `import { resolve as pathResolve, sep as pathSep } from "node:path";`

Order: Task 1 → Task 2 → Task 3 (strict dependency).

---

## Task 1 — Detection core + unit tests

**Goal**
Add the exported pure function `findOutsideNavigation` to
`extensions/danger-guard.ts` and its unit tests, with zero changes to the
existing handler or patterns.

**Context**

- Pure function, no `pi`/`ctx`/UI dependency — must be importable and
  testable in isolation (like the existing `matchDangerousCommand`).
- Algorithm (spec §Design): scan for `cd`/`pushd` at command position
  (start, or after `;` `&&` `||` `|` `(` newline `$(`); take first arg (stop
  at `;` `&&` `||` `|` `)` newline/end), strip matching quotes; no-arg or
  `cd -` → `~`; expand leading `~`/`~/…` via `homedir()`; track a virtual cwd
  starting at `cwd` (`v = pathResolve(v, target)`); flag when
  `v !== cwd && !v.startsWith(cwd + pathSep)`.
- Prefix safety is the `+ pathSep` boundary: `cd /projects/xy` vs cwd
  `/projects/x` must flag (sibling), while `cd /projects/x/src` must not.

**Proposed Approach**

1. Add the two `node:` imports at the top.
2. Implement `findOutsideNavigation` as an exported function near
   `matchDangerousCommand`. Tokenize on the command-position rule; a small
   helper to extract + quote-strip the first arg.
3. Do NOT touch `DEFAULT_PATTERNS`, `matchDangerousCommand`, the handler, or
   the command handler yet.

**Acceptance Criteria**

- `findOutsideNavigation` is exported and returns `string | null`.
- Handles every row of the spec §Testing Strategy table correctly
  (flag vs no-flag), including the chain cases (`cd src && cd ..` no,
  `cd src && cd ../..` yes) and the prefix-safety case.
- No existing exported symbol's signature changed.

**Spec:** none (spec exists).

**Verify**

- Add the spec table as unit tests to `tests/danger-guard.test.mjs`
  (new `findOutsideNavigation` block, `cwd = /home/u/proj`, `home = /home/u`).
- `node tests/danger-guard.test.mjs` → all pass (existing matcher/config
  tests still green).
- `npx tsc --noEmit` → exit 0.

**Out of Scope**
Handler wiring, dialog, env kill-switch, `/danger-guard` output (Task 2).

---

## Task 2 — Integration into the handler

**Goal**
Wire `findOutsideNavigation` into the `tool_call` flow so outside-tree
navigation confirms (or blocks non-interactively), gated by config, and
visible in `/danger-guard`.

**Context**

- Depends on Task 1's function + contract.
- Existing handler: `pi.on("tool_call", …)` matches patterns first via
  `matchDangerousCommand`, confirms via `ctx.ui.confirm`, blocks when
  `!ctx.hasUI`. Nav check must run **only when no pattern matched** (D4) so
  existing behavior is byte-identical.
- Config: `navEnabled = enabled && (env DANGER_GUARD_NAV !== "off")`,
  evaluated at `session_start` alongside existing config.

**Proposed Approach**

1. Add a module-level `let navEnabled = true;` (or read env once at
   session_start) mirroring how `enabled`/`patterns`/`timeoutMs` are set.
2. In the handler, after `const hit = matchDangerousCommand(…)` is null:
   if `navEnabled` and `ctx.cwd` defined and
   `const navHit = findOutsideNavigation(command, ctx.cwd)` → build the
   dialog (`Matched: cd outside working dir (→ ${navHit})` + the spec dialog
   text) and run the same confirm/block path as patterns.
3. Block reason on decline / no-UI: `Blocked by danger guard (cd outside working dir)`.
4. Update `/danger-guard` state output to list the nav check with on/off.
5. Update the file header doc comment (Commands/Config) to mention
   `DANGER_GUARD_NAV` and the nav check.

**Acceptance Criteria**

- A command that only trips the nav check (e.g. `cd ..`) prompts in UI mode
  and blocks in no-UI mode.
- A command matching a regex pattern reports the **pattern** name, not the
  nav name (precedence, D4).
- `/danger-guard off` disables the nav check; `DANGER_GUARD_NAV=off` disables
  it independently of the main toggle.
- `/danger-guard` (no args) shows the nav check's on/off state.
- All existing pattern dialog text and block reasons unchanged.

**Spec:** none (spec exists).

**Verify**

- Add integration assertions to `tests/danger-guard.test.mjs`: pattern
  precedence (a `cd ..` command that also matches a pattern reports the
  pattern), and `loadNavEnabled`-style config if you extract a helper for the
  env kill-switch (test `DANGER_GUARD_NAV=off` → disabled, unset → enabled).
- `node tests/danger-guard.test.mjs` → all pass.
- `npx tsc --noEmit` → exit 0.

**Out of Scope**
Full-suite run + live install (Task 3).

---

## Task 3 — Validation + live-install rollout

**Goal**
Prove the whole change is green and ship it to the live install.

**Context**

- This project keeps a live copy at `/root/.pi/agent/extensions/`;
  `danger-guard.ts` is one of the `extensions/*.ts` files copied there.
- Both test suites must pass: `tests/danger-guard.test.mjs` and
  `tests/voice-input.test.mjs` (the latter is unrelated but is the repo's
  other suite and guards against accidental breakage).

**Proposed Approach**

1. Run typecheck + both suites.
2. Re-copy the changed file to the live install and confirm byte-identical.

**Acceptance Criteria**

- `tsc --noEmit` exit 0.
- `node tests/danger-guard.test.mjs` → all pass.
- `node tests/voice-input.test.mjs` → all groups pass.
- Live `danger-guard.ts` byte-identical to the repo copy.

**Spec:** none.

**Verify**

```
npx tsc --noEmit
node tests/danger-guard.test.mjs
node tests/voice-input.test.mjs
cp extensions/danger-guard.ts /root/.pi/agent/extensions/
diff -q extensions/danger-guard.ts /root/.pi/agent/extensions/danger-guard.ts
```

All must succeed; `diff` reports no difference.

**Out of Scope**
Committing (leave uncommitted on current branch unless asked).
