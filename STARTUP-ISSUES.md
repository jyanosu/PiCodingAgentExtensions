# Startup Issues — PiCodingAgentExtensions

## Startup pass 2026-08-21 (read-only, 3rd — `main` @ f5b847b, **Windows machine**)

Typecheck passes (`npm run typecheck`, strict, exit 0). Working tree clean on
`main` (PR #9 merged; local `guard` branch has no commits ahead). All 11
README extensions present. All 15 fixes from the 2026-08-20 pass verified
present in code (spot-checked: git timeout, WAV cleanup hoisting,
`parseMaxDuration` n>=1, rm long flags, `homedir()`, POSIX path check,
`{{PREVIOUS_SUMMARY}}` placeholder, `readmeChecked` reset, dead `STATE_KEY`
gone, custom-entry restore).

### New finding: test suites are not Windows-portable (fail on this machine)

Previous passes ran in a Linux container where both suites passed. On this
Windows box (Node v26.2.0, real ffmpeg at
`C:\ProgramData\chocolatey\bin\ffmpeg.exe`) both fail:

1. **tests/danger-guard.test.mjs — 4 POSIX-only expectations.**
   - `["cd /", "/"]` → `findOutsideNavigation` returns `C:\` on Windows
     (`pathResolve(cwd, "/")` = drive root).
   - `["cd /tmp", "/tmp"]` → returns `C:\tmp`.
   - `['cd "/tmp/dots..name"', "/tmp/dots..name"]` → returns `C:\tmp\dots..name`.
   - Root-cwd test `findOutsideNavigation("cd /tmp", "/")` → returns
     `C:\tmp`, expected `null` (`pathResolve("/", "/tmp")` = `C:\tmp`,
     which does not start with `/`).
   - The runtime function itself is platform-correct (uses `pathResolve` +
     `pathSep`, handles `C:\` root boundary) — only the test expectations are
     POSIX-only. Fix: derive expectations via `pathResolve` like the
     home-dependent cases already do, or skip the absolute-`/` cases on
     `win32`.
2. **tests/voice-input.test.mjs — fake ffmpeg is a bash script.**
   - Fake `ffmpeg` written as `#!/usr/bin/env bash` with PATH joined by `:`
     → unexecutable on Windows. Real ffmpeg (chocolatey) is spawned instead,
     fails to open `audio=any-device`, exits → `recordAudio` resolves via the
     `close` path with `silenceEnd: undefined` → assertion fails at line 135
     ("silenceEnd ≈ 4.0s (speech end), got undefined").
   - The file aborts there, so the Alt+Q state-machine groups below it never
     run on Windows.
   - Fix: make the fake ffmpeg a Node script with a platform-correct PATH
     separator (`path.delimiter`) and a `.cmd`/direct-node invocation, or gate
     the two fake-ffmpeg groups to `process.platform !== "win32"`.

### Minor / smells

1. **README install command incomplete** — `cp extensions/*.ts
   ~/.pi/agent/extensions/` does not copy the `voice-input/` and
   `obsidian-logger/` directories (the live-install drift in the 2026-08-20
   pass was exactly this). README should add the two `cp -r` lines.
2. **auto-continue.ts:63** — 800ms `setTimeout` callback calls
   `ctx.isIdle()` unguarded; a session reload inside the window throws
   "stale" → unhandled rejection (same class as the intentionally-unfixed
   response-latency stale-ctx timer). Wrap in try/catch or check staleness.
3. **working-indicator.ts** — only file tab-indented (rest of repo: 2
   spaces). Cosmetic; a prettier pass would normalize it.

### What looks good

- danger-guard nav guard (PR #9) is clean: pure exported `findOutsideNavigation` / `matchGuard`, virtual-cwd chaining, root-cwd boundary edge handled, pattern-precedence documented (R4) and tested.
- voice-input cleanup discipline is now consistent across `/voice` and Alt+Q (files hoisted, trimmed file pushed before trim, idempotent stop, busy guard).
- obsidian-logger frontmatter creation is race-safe (per-file `wx` open serialized through `fileCreations` map).
- No secrets in repo; `.env` gitignored; look.ts PowerShell is a fixed string (no injection).

## Startup pass 2026-08-20 (read-only, 2nd — branch `guard-updates` == `main` @ 2a10399)

Typecheck passes (`npm run typecheck`, strict, exit 0). Both test suites pass:
`node tests/voice-input.test.mjs` (8 groups), `node tests/danger-guard.test.mjs`
(all patterns). Working tree clean. All 11 README extensions present.

Since the 1st pass of this date, PR #8 (voice-toggle) landed: Alt+Q early-stop,
`busy` guard, `MIN_RECORD_MS` discard, Alt+Q trim parity, trailing-period strip
in `voiceTextToInput`, `recordAudio` now returns `{promise, stop}` (idempotent
stop), plus a prettier formatting pass. **Fixed since 1st pass:** voice-input
README stale duration docs (now "default max 20s / capped at 60s", matches code).

### Still open from 1st pass (re-verified against current code)

1. **voice-input/index.ts — Alt+Q error path leaks temp WAV** (unchanged).
   `const filesToDelete = [tempFile]` is declared inside the `try` in the
   Alt+Q handler; the `catch` only notifies, never unlinks. If `trimAudio` or
   `transcribe` throws, `voice-*.wav` (+ trimmed file when trim succeeded)
   leak. The `/voice` handler hoists the array and cleans up in `catch` —
   the Alt+Q handler was missed again.
2. **obsidian-logger/index.ts — `readmeChecked` not reset on `session_start`**
   (unchanged). Second project in same process never gets its README.md.
3. **auto-continue.ts** — dead `const STATE_KEY = "auto-continue:enabled"`
   (actual customType is literal `"auto-continue-state"`).
4. **working-indicator.ts** — `process.env.HOME || "/root"`: Windows `HOME`
   usually unset → config lands at `/root/.pi/agent`.
5. **look.ts** — explicit-path arg requires backslash (`first.includes("\\")`);
   Linux `/tmp/img.png` falls through to clipboard → temp-file fallback.
6. **compaction-model.ts** — `SUMMARY_PROMPT.replace("\n1. The main goals", …)`
   fragile string hack for previous-summary injection; models.json fallback
   branch hardcodes `maxTokens: 8192`, ignoring `COMPACTION_MODEL_MAX_TOKENS`.
7. **highlight-footer.ts** — `gitLines` spawns git with no timeout; non-stale
   errors re-thrown from async `fetchGitData` → unhandled rejection (called
   from `setInterval`).
8. **voice-input/index.ts** — `detectDefaultMic()` uses `execSync` (blocks
   event loop at `session_start` when `MIC_DEVICE` unset); hardcoded fallback
   whisper URL `https://whisper.local.johnyan.net` used silently when no
   `.env`/env var (audio sent there with no notice).
9. **response-latency.ts** — stale-ctx `setTimeout` (2s) — intentionally
   unfixed per earlier decision.
10. **docs/tmp-log-toggle/plan.md line 103** — still claims `.env` "is tracked";
    it is gitignored.
11. **Live install drift** — `/root/.pi/agent/extensions/`: all 5 files present
    there DIFFER from repo (dated Jul 28 / Aug 12), and auto-continue,
    clipboard-cleanup, danger-guard, look, obsidian-logger/, voice-input/ are
    missing entirely. Repo is source of truth; live needs re-copy.

### New findings (this pass)

1. **package.json lacks `"type": "module"`** — tests import `.ts` files
   directly via node, which prints a `MODULE_TYPELESS_PACKAGE_JSON` warning
   ("Reparsing as ES module") on every run. Extensions are ESM
   (`import.meta.url`); adding `"type": "module"` would silence it.
2. **voice-input — partial trimmed WAV can leak** (both handlers): `trimAudio`
   is awaited *before* `filesToDelete.push(trimmedFile)`. If ffmpeg trim fails
   after writing a partial `voice-trimmed-*.wav`, that file is never unlinked
   (in `/voice` the catch cleans up the list, which lacks it; in Alt+Q
   nothing is cleaned up — see still-open #1).
3. **`parseMaxDuration` quirk** — `/voice 1` and `/voice 2` (`n <= 2`) silently
   fall back to the 20s default instead of honoring the requested value.
    Undocumented.
4. **danger-guard rm pattern misses long-flag form** —
   `rm --recursive file` / `rm --force file` do not match
   `/\brm\s+(?:-\w+\s+)*-\w*[rf]\w*(?:\s|$)/i` (only single-dash `-r`/`-f`
   combos). GNU rm accepts the long forms.

### Security review

- No secrets in repo (`.env` gitignored; only `.env.example` tracked).
- look.ts PowerShell script is a fixed string — no user input in the command,
  no injection path.
- danger-guard: `sudo` pattern matches *all* sudo (broad by design, tests
  assert it); `git push` force pattern correctly catches `-f`, `--force`,
  `--force-with-lease` and multi-command lines. Long-flag rm gap above is the
  one real miss.
- voice-input: unconfigured default sends audio to a personal hardcoded URL —
  privacy-relevant, already flagged as smell #8.

### Tech stack (unchanged)

TypeScript strict ESM (es2022, bundler resolution, `tsc --noEmit`), Pi
Extension API (`@earendil-works/pi-coding-agent` ^0.84.2 + `pi-ai`), node:
builtins only, no framework. Tests: plain `node` + `assert` in `.mjs` files
importing `.ts` directly (node type-stripping). Config via `.env` next to
extension or process env.

### Fixed (2026-08-20, same day, uncommitted on `guard-updates`)

All of the above addressed except the intentionally-unfixed items:

1. voice-input Alt+Q temp-WAV leak — `filesToDelete` hoisted outside `try`,
   `catch` now unlinks (both handlers).
2. obsidian-logger `readmeChecked` reset on `session_start`.
3. auto-continue dead `STATE_KEY` removed.
4. working-indicator `homedir()` instead of `HOME || "/root"`.
5. look.ts path check accepts `/` and `\\` (POSIX paths now work).
6. compaction-model: `{{PREVIOUS_SUMMARY}}` placeholder replaces the
   `SUMMARY_PROMPT.replace("\n1. The main goals", …)` hack; `parseMaxTokens()`
   honors `COMPACTION_MODEL_MAX_TOKENS` in both config branches.
7. highlight-footer: `gitLines` has a 5s timeout (kills hung git); non-stale
   errors logged instead of re-thrown (no more unhandled rejections).
8. voice-input: `detectDefaultMic` now async `execFile` (no event-loop block);
   `getConfig` async + awaited at `session_start`.
9. response-latency: stale-ctx `setTimeout` callback wrapped in try/catch.
10. docs/tmp-log-toggle/plan.md `.env` "tracked" wording corrected.
11. Live install re-copied: all 10 files + voice-input/ + obsidian-logger/
    synced to `/root/.pi/agent/extensions/` (verified byte-identical).
12. package.json `"type": "module"` (kills the typeless-package warning).
13. Partial trimmed-WAV leak: trimmed file pushed to `filesToDelete` BEFORE
    `trimAudio` (both handlers).
14. `parseMaxDuration` honors `n >= 1` (`/voice 1`/`/voice 2` no longer
    silently become 20s); tests updated.
15. danger-guard rm pattern now catches `rm --recursive` / `rm --force`;
    `rm file.txt` still does NOT match (verified in tests, 3 new cases).

Not changed (deliberate): hardcoded fallback whisper URL (user's own server),
voice-input Alt+Q fixed 20s max (by design).

Extra hardening found while validating: `recordAudio.settle()` now skips
`proc.kill()` when the spawn never produced a pid (ffmpeg-missing case) —
kill on a never-spawned child was the one suspicious path in the test env.

**Test-env note:** intermittent multi-second process freezes observed in this
container/tmux (pure-JS test groups stalling 30-55s, thread state S, no CPU
throttling) — environmental, not code. Both suites pass cleanly when the env
cooperates: voice-input 8/8 groups (×3 consecutive runs), danger-guard 53+
config tests, `tsc --noEmit` exit 0. No new temp-file orphans after the
cleanup fixes.

## Startup pass 2026-08-20 (read-only, fresh)

Typecheck passes (`npm run typecheck`, strict, exit 0). Working tree clean on
branch `updates`. `.env` files untracked. All 10 README extensions present.
`tmp-log-toggle` feature (docs/tmp-log-toggle) fully implemented per spec.

### Confirmed bugs

1. **voice-input/index.ts — Alt+Q error path leaks temp WAV**
   `let filesToDelete = [tempFile]` is block-scoped inside the `try`; the
   `catch` does no cleanup. If `recordAudio` succeeds but `transcribe` throws,
   `voice-*.wav` is never unlinked. The `/voice` handler had the same bug fixed
   (array hoisted outside `try`) — the Alt+Q handler was missed.
2. **obsidian-logger/index.ts — `readmeChecked` not reset on `session_start`**
   If the project (cwd) changes between sessions in the same process, the
   second project's folder never gets its `README.md` (flag stays `true` from
   the first session). Minor: README is cosmetic.

### Stale docs

1. **voice-input/README.md** — says `/voice` = "5 seconds (default)" and
   "/voice 30 | Up to 120 seconds". Code: `parseMaxDuration` defaults to **20s**
   and caps at **60s** (`Math.min(n, 60)`). Main README says "default max 20s" —
   extension README is the outlier.
2. **docs/tmp-log-toggle/plan.md Task 2 step 2** — claims `.env` "is tracked";
   it is now untracked/gitignored (fixed in `16f4bb2`).

### Minor / code smells

1. **auto-continue.ts** — `const STATE_KEY = "auto-continue:enabled"` declared
   but never used (dead constant; actual customType is literal
   `"auto-continue-state"`).
2. **working-indicator.ts** — `CONFIG_DIR = ... process.env.HOME || "/root"`:
   on Windows `HOME` is usually unset → config lands at `/root/.pi/agent`
   instead of `%USERPROFILE%\.pi\agent`.
3. **look.ts** — explicit-path arg requires a backslash
   (`first.includes("\\")`), so on Linux `/tmp/img.png` is not treated as a
   path (falls through to clipboard → temp-file fallback). Windows-first by
   design, but README implies cross-platform path support.
4. **compaction-model.ts** — previous-summary inserted via fragile string hack
   `SUMMARY_PROMPT.replace("\n1. The main goals", ...)`; models.json fallback
   branch ignores `COMPACTION_MODEL_MAX_TOKENS` env (hardcodes 8192).
5. **highlight-footer.ts** — `gitLines` spawns with no timeout (hung git =
   dangling promise); non-stale errors are re-thrown from async
   `fetchGitData` → unhandled rejection.
6. **voice-input/index.ts** — `detectDefaultMic()` uses `execSync` (blocks
    event loop at `session_start` when `MIC_DEVICE` unset); hardcoded fallback
    whisper URL `https://whisper.local.johnyan.net` used silently when no
    `.env`/env var present.
7. **response-latency.ts** — known stale-ctx `setTimeout` (2s delay captures
    `ctx`; stale `ctx.ui.setStatus` can crash a later session). Intentionally
    unfixed per earlier decision — re-listed for completeness.

### Environment

 1. **Live install stale** — `/root/.pi/agent/extensions/` holds 5 files dated
    Jul 28 (all differ from repo) and is missing auto-continue, clipboard-
    cleanup, look, obsidian-logger/, voice-input/. Live `search-browser.ts` is
    the old dead-code-restore version (`e.category === "extension"`). Repo is
    source of truth; live needs re-copy (`cp extensions/*.ts` + the two
    directories) to pick up all fixes.

## Startup pass 2026-07-28 (read-only)

Reviewed 2026-07-28 (startup pass, read-only). Claims verified against Pi
`dist/core/extensions/types.d.ts` and `dist/core/session-manager.d.ts`
(@earendil-works/pi-coding-agent).

**Status: all confirmed bugs fixed on branch `updates`** (verified with
typecheck: `tsc --noEmit --strict` against pi package types, exit 0).
Typecheck also surfaced additional bugs, fixed alongside:

- `session_end` is not a valid event (correct: `session_shutdown`) —
  highlight-footer.ts and response-latency.ts cleanup handlers never fired → timer leaks.
- Invalid notify types: `"warn"` (auto-continue), `"success"` (obsidian-logger ×2) —
  valid set is `"info" | "warning" | "error"`.

**Follow-up (same branch): all minor code smells + repo hygiene items below fixed.**
Repo now has `package.json` + `tsconfig.json` with `npm run typecheck`.

## Confirmed bugs

### 1. auto-continue.ts — state persistence broken (throws on shutdown) [FIXED]

- `session_shutdown` handler calls `ctx.sessionManager.appendEntry({ role, customType, content, timestamp })`.
  `SessionManager` has **no** `appendEntry` method (it's private `_appendEntry`).
  Public APIs are `pi.appendEntry(customType, data?)` or `sessionManager.appendCustomEntry(customType, data?)`.
  → TypeError on every session shutdown.
- Restore side reads `e.content`, but custom entries store the value in `e.data`
  (`CustomEntry { type: "custom", customType, data }`). → Restore would read `undefined` even if the write worked.

### 2. search-browser.ts — state restore is dead code [FIXED]

- Restores from `e.category === "extension" && e.data?.key === "searchBrowserMode"`.
  `SessionEntry` has no `category` field, and nothing ever writes such an entry —
  the `/search-browser` command only mutates in-memory `openBrowser`.
  → Mode silently resets to OFF every session; startup notify always says OFF.

### 3. highlight-footer.ts — `~modified` / `-deleted` counters always 0 [FIXED]

- Porcelain parse: `line.substring(0, 2).replace(/[ DCMR]/g, "").trim()`.
  The regex strips `M` and `D` from **both** XY columns, so worktree-modified
  (`M`) and worktree-deleted (`D`) collapse to `""` and are never counted.
  Effectively: `added` = untracked + staged-adds, `modified` = always 0, `deleted` = always 0.
- Fix: parse columns separately — `Y = line[1]`; count `Y === "M"` / `Y === "D"`, and `X === "A"` or `line.startsWith("??")` for added.

### 4. voice-input/index.ts — temp WAV files leak on error path (`/voice`) [FIXED]

- `let filesToDelete = [tempFile]` is declared **inside** the `try` block.
  The `catch` block references it via `typeof filesToDelete !== "undefined"`,
  but the identifier is out of scope in `catch` → evaluates `"undefined"` → cleanup silently skipped.
  → On transcription/record failure, `voice-*.wav` files remain in tmpdir.
- (The Alt+Q handler declares `filesToDelete` in its own try scope, so it cleans up correctly.)

### 5. Duplicate compaction extensions [FIXED — compact-model.ts deleted]

- Both `compact-model.ts` (older: hardcoded `llama-cpp`, requires API key, no branch summary)
  and `compaction-model.ts` (newer: env-configured, dynamic provider registration, branch summary) exist.
- README documents only `compaction-model`, but install command `cp extensions/*.ts ~/.pi/agent/extensions/`
  copies **both** → both hook `session_before_compact`, double-compaction conflict.
- Suggest deleting `compact-model.ts` (or excluding it from the install glob).

## Minor issues / code smells (all FIXED on branch `updates`)

### compaction-model.ts [FIXED]

- Empty if block after auth check (dead, unfinished API-key check) — removed.
- Fallback assumed first provider in models.json is litellm — now prefers the
  provider literally named `"litellm"`, falls back to first.
- `require("node:fs")` inside an ESM file — moved to top-level imports.

### voice-input/index.ts [FIXED]

- `require("node:child_process")` inside a function — moved to top-level import.
- `recordAudio`: max-duration `setTimeout` now cleared when silence settles early.

### obsidian-logger/index.ts [FIXED]

- Doc comment path mismatch — now documents `{vault}/Projects/{project}/{sessionId}/...`.
- `appendToDailyFile` full read + rewrite per message (O(n²), race-prone) — now `appendFile`.
- Dead if/else (both branches identical) — collapsed.
- ~~Tool-result capture bloat~~ — **not a bug**: tool results arrive as
  `role: "toolResult"` messages, already excluded by the role filter, and
  `extractUserText` only takes `type: "text"` blocks.

### working-indicator.ts [FIXED]

- Config moved from `~/.pi/extensions/` to the Pi config dir
  (`$PI_CODING_AGENT_DIR || ~/.pi/agent`), consistent with compaction-model.

### highlight-footer.ts [FIXED]

- `setWidget("token-budget", ...)` cross-extension coupling — documented in comment.

### look.ts / voice-input [FIXED]

- Windows-only nature noted in README table rows.

## Repo / hygiene (all FIXED on branch `updates`)

- `.env` git-tracked — removed from index (`git rm --cached`); `.gitignore` keeps it out.
- README table now lists auto-continue, search-browser, obsidian-logger (+ config sections).
- Typecheck added: `package.json` (devDeps: pi-coding-agent, pi-ai, typescript, @types/node)
  - `tsconfig.json` (strict) + `npm run typecheck`.

## What looks good

- `event.input` mutation in search-browser matches documented `tool_call` contract (`event.input` is mutable).
- `pi.on("input")` returning `{ action: "handled" | "transform" }` in voice-input matches `InputEventResult`.
- `pi.registerShortcut`, `pi.sendUserMessage({ deliverAs })`, `ctx.isIdle()`, `pi.registerProvider(name, config)` all match the ExtensionAPI surface.
- highlight-footer pauses git polling during streaming/tool execution and disposes on stale ctx — good hygiene.
- clipboard-cleanup is small, safe, idempotent.
- `.gitignore` covers `.env` (except the already-tracked file above).
