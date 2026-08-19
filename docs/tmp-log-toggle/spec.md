# Spec: obsidian-logger temp-dir logging toggle

Feature: `tmp-log-toggle` — session-level switch to log to the OS temp
directory instead of the configured Obsidian vault.

## What

Add a per-session target switch to obsidian-logger: default writes go to the
configured vault; `/obsidian-logger tmp` redirects the current session's
writes to a temp folder (OS-cleared); `/obsidian-logger vault` switches back.

## Context

`extensions/obsidian-logger/index.ts` currently has one in-memory state axis
(`enabled: boolean`) and a fixed write root (`vaultPath` from
`OBSIDIAN_VAULT_PATH`). `message_end` guards on `!enabled || !vaultPath ||
!sessionId` and writes to `{vaultPath}/Projects/{project}/{sessionId}/{MM-DD-YYYY}.md`
via `appendToDailyFile`. The `/obsidian-logger` command accepts
`on|off|` (no arg = toggle).

User want: scratch sessions (experiments, tests) shouldn't pollute the vault.

## Requirements

- R1: Default target at session start is `vault` — existing behavior unchanged.
- R2: `/obsidian-logger tmp` redirects subsequent writes of the current
  session to `{tmpdir}/pi-obsidian-logger/Projects/{project}/{sessionId}/{MM-DD-YYYY}.md`.
- R3: `/obsidian-logger vault` restores writes to the configured vault.
- R4: Target is in-memory only. A new session always starts at `vault`.
  Never persisted to the session file (no `appendEntry`).
- R5: `tmp` mode works even when `OBSIDIAN_VAULT_PATH` is unset.
- R6: `/obsidian-logger vault` with no vault configured → warning notify,
  target stays `tmp`.
- R7: No `README.md` is created in temp mode (`ensureProjectReadme` is
  vault-only).
- R8: Switch notifications show the resolved absolute target folder.
- R9: Existing `on|off|` (no-arg toggle) behavior is unchanged.

## Design

One new in-memory variable, one helper, command extension. No new files.

```ts
let logTarget: "vault" | "tmp" = "vault";
const TMP_ROOT = join(tmpdir(), "pi-obsidian-logger"); // from node:os
```

- `message_end`: compute the write root at call time so mid-session switches
  take effect on the next message:
  ```ts
  if (!enabled || !sessionId) return;
  const root = logTarget === "tmp" ? TMP_ROOT : vaultPath;
  if (!root) return;
  ```
  (Replaces the current `!vaultPath` guard, which would break R5.)
- `ensureProjectReadme`: call only when `logTarget === "vault"`.
- `appendToDailyFile(ctx, root, ...)`: unchanged — it already takes the root
  as a parameter, so both targets share the identical
  `Projects/{project}/{sessionId}/{date}.md` layout.
- Command handler: add two branches before the existing on/off logic:
  - `tmp` → if `logTarget !== "tmp"`: set it, notify `Logging to {TMP_ROOT}`.
  - `vault` → if `vaultPath` missing: warn `No vault configured — staying in tmp mode`,
    no state change. Else set it, notify `Logging to {vaultPath}/Projects/{project}`.
  - No-arg / `on` / `off` / unknown: unchanged (unknown still falls through to
    the toggle — preserve that).
  - All notifications include the current target: `Obsidian logger: ON (target: tmp)`.

## Decisions

- **Extend `/obsidian-logger` rather than a new command** — one command owns
  logger state; `tmp`/`vault` are just another axis.
- **Temp root = `join(tmpdir(), "pi-obsidian-logger")`** — `os.tmpdir()` is
  `%TEMP%` on Windows, `/tmp` on Linux. Single subfolder keeps the layout
  recognizable and avoids scattering files. Distinct from `pi-clipboard-*`
  (different prefix; clipboard-cleanup extension won't touch it).
- **Mirror the vault layout under the temp root** — zero changes to
  `appendToDailyFile`, and files moved later are drop-in compatible.
- **No retroactive effect** — entries already written stay where they were;
  the switch affects subsequent `message_end` events only.
- **No-arg keeps its current toggle-on/off meaning** — no breaking change to
  muscle memory; status is visible in every notification instead.

## Invariants

- Write layout is byte-identical for both targets:
  `{root}/Projects/{project}/{sessionId}/{MM-DD-YYYY}.md`.
- Session start always begins at `vault` target with `readmeChecked = false`.
- No new session-file entries are written by this feature.

## Error Behavior

- Switch to `vault` without `OBSIDIAN_VAULT_PATH` → warning notify, state
  unchanged (R6).
- Write failure in temp mode → same path as today: `console.error` + warning
  notify from `appendToDailyFile`.
- Unknown command arg → falls through to toggle (existing behavior, R9).

## Testing Strategy

No test framework in repo. Verify:

1. `npm run typecheck` passes.
2. Manual (vault configured): prompt → file in vault; `/obsidian-logger tmp`
   → prompt → file in `{tmpdir}/pi-obsidian-logger/Projects/...`;
   `/obsidian-logger vault` → prompt → file in vault again.
3. Manual (unset `OBSIDIAN_VAULT_PATH`): `/obsidian-logger tmp` → prompt →
   file in temp; `/obsidian-logger vault` → warning, stays in tmp.
4. New session starts at vault target (no persistence).

## Out of Scope

- Persisting the target across sessions.
- Per-project or per-session preconfigured targets.
- Deleting temp logs on session end (OS reclaims them; see note below).
- Any vault-side changes (config format, README content).

## Note on OS temp behavior (assumption check)

The user's mental model — "temp folders get cleared when the system needs
space" — is close but not exact: Windows clears `%TEMP%` via Storage Sense /
Disk Cleanup (age- and space-based); Linux clears `/tmp` on reboot or via
`systemd-tmpfiles`/tmpwatch age policies (files untouched for ~10 days may
survive longer). Practical effect: temp logs are best-effort garbage, not a
guaranteed purge. If hard cleanup is ever needed, that's a separate feature
(e.g., delete the session's temp folder on `session_shutdown`).
