# Spec: Working-Dir Navigation Guard (danger-guard)

## What

Extend `danger-guard` so that a bash command which navigates (`cd`/`pushd`)
to any directory **outside the session working-dir tree** triggers the same
confirm-then-run flow as destructive patterns. Allowed without prompting:
staying in `ctx.cwd` or moving into a descendant (child) of it. Everything
else — parents, root, siblings, home, `/tmp`, any unrelated path — flags.

## Context

- `extensions/danger-guard.ts` intercepts `tool_call` for `bash`, matches
  `event.input.command` against regex patterns, confirms via
  `ctx.ui.confirm` (or blocks when `!ctx.hasUI`).
- pi's bash tool spawns a **fresh shell per call** with fixed `cwd` = session
  dir; `cd` does not persist between calls. So a lone `cd ..` is harmless by
  itself — the risk is in-command navigation: `cd ../.. && rm -rf *`,
  `(cd / && find ... )`, etc.
- The base directory is `ctx.cwd` (available in the `tool_call` handler).

## Requirements

1. **R1** — A bash command is flagged when any `cd`/`pushd` in it resolves
   (see Design) to a path that is **not** `ctx.cwd` and **not** a descendant
   of `ctx.cwd`. Flag name: `cd outside working dir`.
2. **R2** — `cd`/`pushd` resolving to `ctx.cwd` itself or a descendant never
   flags (e.g. `cd src`, `cd .`, `cd sub && cd ..`).
3. **R3** — Flagged commands go through the existing flow: `ctx.ui.confirm`
   with the same timeout (`DANGER_GUARD_TIMEOUT_MS`); on decline or
   `!ctx.hasUI` → `{ block: true, reason }` (safe default, same as patterns).
4. **R4** — The nav check runs **only when no regex pattern matched** (existing
   pattern behavior stays byte-identical; a command matching both reports the
   pattern name).
5. **R5** — Gated by the main `enabled` toggle (`/danger-guard on|off|toggle`)
   and an env kill-switch `DANGER_GUARD_NAV=off` (default on).
6. **R6** — `/danger-guard` state output lists the nav check with its on/off
   state.
7. **R7** — Pure, exported, unit-testable:
   `findOutsideNavigation(command: string, cwd: string): string | null`
   returning the offending target (for the dialog) or `null`.

## Design

### Detection algorithm (pure function)

1. Scan the command for navigation tokens at **command position**: `cd` or
   `pushd` (word-boundary, case-sensitive) appearing at start of command or
   after any of `;`, `&&`, `||`, `|`, `(`, newline, `$(`. Not after a word
   (so `echo "cd .."`, `find . -name cd` do not match).
2. Take the token's first argument (stop at `;`, `&&`, `||`, `|`, `)`,
   newline, or end). Strip matching surrounding quotes. No argument (or `cd -`)
   → target = `~` (shell default: home).
3. Expand a leading `~`, `~/...`, `$HOME`, `${HOME}` (with optional `/<sub>`)
   to `os.homedir()` — bash expands `$HOME` the same way.
4. **Track a virtual cwd** through the command, starting at `cwd`:
   `v = path.resolve(v, target)`. After each `cd`, `v` becomes the resolved
   target. (Handles chains: `cd src && cd ../..` correctly resolves to the
   parent.)
5. After each resolution, if `v !== cwd && !v.startsWith(boundary)` → the
   target left the working-dir tree → return the target string, where
   `boundary = cwd + sep` — except when `cwd` is root itself ("/" or "C:\"),
   where appending sep ("//") would match nothing, so `boundary = cwd` and
   everything is a descendant (nothing can flag). The `cwd + sep` boundary
   prevents prefix false-negatives (`/projects/xy` is NOT inside
   `/projects/x`).
6. First offending target wins (returned for the dialog).

### Integration

- In the `tool_call` handler, after `matchDangerousCommand` returns null:
  if `navEnabled && (hit2 = findOutsideNavigation(command, ctx.cwd))` →
  same confirm dialog with `Matched: cd outside working dir (→ <target>)`.
- `navEnabled = enabled && env DANGER_GUARD_NAV !== "off"` (evaluated at
  session_start like other config).

### Dialog text

```
⚠️ Danger guard
Matched: cd outside working dir → /projects
<command, truncated to 600 chars>

Command changes directory outside the working dir (/projects/...).
Run anyway? (auto-blocks when timer ends)
```

## Decisions

- **D1 (confirmed: flag any target outside the cwd subtree).** Allowed =
  `cwd` itself or a descendant. Flagged = ancestors, root, siblings, home,
  `/tmp`, anything unrelated. User-chosen over the strict-ancestor variant.
- **D2 (default: `cd` + `pushd`, bash only).** PowerShell `Set-Location ..`
  not covered (bash tool here is bash; existing patterns already skew
  bash-first).
- **D3 (consequence of D1: bare `cd` / `cd -` / `cd ~` resolve to `$HOME`
  and flag whenever home is outside the cwd subtree)** — which is the normal
  case, so bare `cd` will prompt. Accepted: leaving the tree to home is
  exactly what this guard is for.
- **D4 (default: regex patterns take precedence over nav check)** — keeps all
  existing behavior and dialog names unchanged.
- **D5 (default: virtual-cwd tracking is linear).** Subshells `(cd .. && x)`
  are scanned with the same running virtual cwd (no reset on `(`) — may
  over-flag, never under-flags. `bash -c "cd .. && ..."` inner shell is a
  known limitation (rare; see Out of Scope).

## Invariants

- No false positives on: `cd .`, `cd` into descendants, `cd` to cwd itself,
  `..` appearing inside strings/quotes/paths that aren't a `cd` argument
  (`echo "cd .."`, `git commit -m "cd .."`, `cd "/tmp/dots..name"`), `cd` as
  a non-command word (`find . -name cd`, `x=cd; $x ..`).
- Prefix safety: `cd /projects/xy` with cwd `/projects/x` **flags** (sibling,
  not descendant) — the `cwd + sep` boundary check guarantees this.
- Existing pattern matching is untouched: same patterns, same order, same
  dialog, same block reasons. All current tests pass unchanged.
- Non-interactive mode never prompts: nav violations block (safe default).
- Check cost: string scan + path resolves — negligible per tool call.

## Error Behavior

- Unresolvable/odd targets (empty after quote-strip, `cd ""`) → treat as
  `.` (no flag).
- `ctx.cwd` missing/undefined (shouldn't happen) → skip nav check silently.
- Dialog declined/timed out → block with reason
  `Blocked by danger guard (cd outside working dir)`.

## Testing Strategy

Unit tests in `tests/danger-guard.test.mjs` for `findOutsideNavigation(cmd, cwd)`
with `cwd = /home/u/proj`, `home = /home/u`:

| command | result |
| --- | --- |
| `cd ..` | flag (→ `/home/u`) |
| `cd ../..` | flag (→ `/home`) |
| `cd /` | flag |
| `cd /home/u` | flag (parent) |
| `cd /tmp` | flag (unrelated) |
| `cd /home/u2` | flag (sibling) |
| `cd /home/u/proj2` | flag (sibling of proj) |
| `cd .` / `cd src` / `cd src/components` | no |
| `cd /home/u/proj` | no (cwd itself) |
| `cd src && cd ..` | no (net cwd) |
| `cd src && cd ../..` | flag (resolves to `/home/u`) |
| `cd .. && ls` | flag |
| `cd` (bare) | flag (→ home, outside) |
| `cd -` | flag (→ home) |
| `cd ~` | flag; `cd ~/..` flag |
| `cd ~/proj` | no (resolves to cwd) |
| `cd $HOME` / `cd ${HOME}` | flag (→ home) |
| `cd $HOME/x` | flag (→ home/x) |
| `cd ${HOME}/proj` | no (resolves to cwd) |
| `cd /tmp` (with cwd = `/`) | no (root: everything is a descendant) |
| `echo "cd .."` | no |
| `x=cd; $x ..` | no (not a token we parse) |
| `(cd .. && rm -rf *)` | flag |
| `cd "/tmp/dots..name"` | no (literal name, resolves outside? → it's unrelated → **flag**; see note) |
| `git commit -m "cd .."` | no |

Note on `cd "/tmp/dots..name"`: after quote-strip the target is the literal
path `/tmp/dots..name`, which is outside cwd → **flags** (correct: it really
does leave the tree). The earlier "no" intuition applied only to `..` inside
a *name* while the base stays inside cwd (e.g. `cd src/my..dir` → no flag).

Plus: env kill-switch (`DANGER_GUARD_NAV=off` → off), `/danger-guard` output
mentions nav check, and one integration assertion that the handler order
keeps pattern precedence (D4).

## Out of Scope

- Non-`cd` operations on outside paths (`ls ../`, `cat ../../x`) — those are
  reads; destructive ones already hit existing patterns.
- PowerShell `Set-Location`, `popd`, aliases/functions, `bash -c` nested
  shells, `env`/`nice`-wrapped cd.
- Persisting per-directory allowlists ("always allow this directory").
- Changing the bash tool's cwd or persisting shell state.
- Windows path semantics — the check resolves via `path.resolve`/`path.sep`,
  so it is POSIX-oriented; git-bash POSIX paths (`/c/...`) do not resolve
  correctly on Windows. Fine on Linux/macOS (this environment).
