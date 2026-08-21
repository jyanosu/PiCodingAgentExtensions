# Plan: obsidian-logger temp-dir logging toggle

Source: `docs/tmp-log-toggle/spec.md`
Code: `extensions/obsidian-logger/index.ts` (single file, ~180 lines)

## Shared decisions (apply to all tasks)

- **D1**: New in-memory state `logTarget: "vault" | "tmp"`, default `"vault"`
  at session start. Never persisted (no `appendEntry`).
- **D2**: `TMP_ROOT = join(tmpdir(), "pi-obsidian-logger")` from `node:os`.
- **D3**: Both targets share the identical layout
  `{root}/Projects/{project}/{sessionId}/{MM-DD-YYYY}.md`, so
  `appendToDailyFile` is unchanged — it already takes the root as a parameter.
- **D4**: No-arg `/obsidian-logger` keeps its current toggle-on/off behavior.
  Every notification includes the current target, e.g.
  `Obsidian logger: ON (target: tmp)`.

## Task 1: Implement temp target switch (core + command)

**Goal** — Session-level switch: `/obsidian-logger tmp` redirects the current
session's log writes to the temp root; `/obsidian-logger vault` restores the
configured vault.

**Context** — Current state: `enabled: boolean`, `vaultPath`, `projectName`,
`sessionId`, `readmeChecked`. `message_end` guards on
`!enabled || !vaultPath || !sessionId` (this guard must change — it would
break R5, tmp without vault). Command handler accepts `on|off|` (no arg =
toggle). Full design in spec §Design.

**Proposed approach**

1. Add `import { tmpdir } from "node:os"`; module-level `TMP_ROOT` constant
   and `let logTarget: "vault" | "tmp" = "vault";`.
2. `session_start`: reset `logTarget = "vault"` on every start (covers
   `/reload` too).
3. `message_end`: replace guard with
   `if (!enabled || !sessionId) return;` then
   `const root = logTarget === "tmp" ? TMP_ROOT : vaultPath; if (!root) return;`
   Pass `root` to `appendToDailyFile`. Gate `ensureProjectReadme` on
   `logTarget === "vault"`.
4. Command handler: add `tmp` and `vault` branches before the on/off logic:
   - `tmp`: set target, notify `Logging to ${TMP_ROOT}`.
   - `vault`: if `!vaultPath` → warn `No vault configured — staying in tmp
     mode`, no state change; else set target, notify resolved vault folder.
   - Append `(target: ${logTarget})` to all notifications.

**Acceptance criteria** (outcomes; R-numbers = spec requirements)

- New session writes to vault exactly as before (R1).
- After `/obsidian-logger tmp`, subsequent user + assistant messages land in
  `{tmpdir}/pi-obsidian-logger/Projects/{project}/{sessionId}/{MM-DD-YYYY}.md`
  (R2); after `/obsidian-logger vault`, they land in the vault again (R3).
- Switch is in-memory only; a new session starts at vault (R4).
- `tmp` mode works with no `OBSIDIAN_VAULT_PATH` at all (R5); switching to
  `vault` without a vault warns and stays in tmp (R6).
- No `README.md` is ever created under the temp root (R7).
- Switch notifications show the resolved absolute target folder (R8).
- `on`/`off`/no-arg behavior unchanged (R9).

**Spec** — `full` (exists at `docs/tmp-log-toggle/spec.md`).

**Verify**

1. `npm run typecheck` exits 0.
2. Happy path: from repo root,
   `pi -e ./extensions/obsidian-logger/index.ts` (vault already set in
   `extensions/obsidian-logger/.env`). Send a prompt → confirm a file
   appears under the vault (`cat extensions/obsidian-logger/.env` for the
   path). Run `/obsidian-logger tmp` → send a prompt → confirm the new entry
   is in `{tmpdir}/pi-obsidian-logger/Projects/<project>/<session>/*.md`.
   Run `/obsidian-logger vault` → send a prompt → confirm back in vault.

**Out of scope** — no-vault edge verification (Task 2), README update
(Task 2), any persistence.

## Task 2: No-vault edge verification + README update

**Goal** — Prove the no-vault scenarios behave per spec, and document the
new subcommands in the extension README.

**Context** — Vault path resolution order: process env var
`OBSIDIAN_VAULT_PATH` first, then `.env` next to the extension
(`extensions/obsidian-logger/.env`). To simulate "no vault", the `.env`
file must be moved aside (env var is not set in this environment).

**Proposed approach**

1. `mv extensions/obsidian-logger/.env extensions/obsidian-logger/.env.bak`.
2. Run `pi -e ./extensions/obsidian-logger/index.ts`; `/obsidian-logger tmp`
   → prompt → confirm file lands in temp root. `/obsidian-logger vault` →
   confirm warning `No vault configured — staying in tmp mode` and that the
   next prompt still lands in temp.
3. Restore: `mv extensions/obsidian-logger/.env.bak extensions/obsidian-logger/.env`.
4. Update `extensions/obsidian-logger/README.md`: document `tmp` / `vault`
   subcommands, the temp root location (`os.tmpdir()/pi-obsidian-logger`),
   session-only scope, and that tmp mode works without a vault configured.

**Acceptance criteria**

- No-vault + `tmp` logs successfully to the temp root (R5 verified live).
- No-vault + `vault` warns and leaves target unchanged (R6 verified live).
- README documents both subcommands, temp location, and session-only scope.

**Spec** — `none`.

**Verify**

1. Step 2 observations above (notifications + file locations).
2. `git diff` shows `.env` restored byte-identical (it was tracked at the time;
   since then it has been gitignored — `git status` clean for that path after
   the rename-back).
3. README renders sensibly (`git diff extensions/obsidian-logger/README.md`).

**Ordering & risk** — Task 2 depends on Task 1. Risk low: single file, no
schema/config/contract changes, rollback = `git revert` of the feature
commit.
