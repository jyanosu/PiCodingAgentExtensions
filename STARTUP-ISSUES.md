# Startup Issues — PiCodingAgentExtensions

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
  (` M`) and worktree-deleted (` D`) collapse to `""` and are never counted.
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

## Minor issues / code smells

### compaction-model.ts
- Empty if block after auth check:
  `if (!auth.apiKey && !config.baseUrl.includes("localhost") && ...) { // Allow non-localhost without key only if explicitly configured }`
  — dead logic, does nothing (unfinished API-key check).
- Fallback config takes `Object.values(models.providers)[0]` and assumes it's the litellm endpoint — fragile. (Typed the parsed JSON on branch `updates`; still assumes first provider is litellm.)
- `require("node:fs")` inside `loadConfig()` in an ESM file (works under jiti, inconsistent with the rest).

### voice-input/index.ts
- `require("node:child_process")` inside `detectDefaultMic()` in an ESM file.
- `recordAudio`: max-duration `setTimeout` is never cleared when silence settles early → pending timer kept (harmless in TUI, sloppy).

### obsidian-logger/index.ts
- Doc comment says structure `{vault}/{projectName}/{sessionId}/MM-DD-YYYY.md`; code writes `{vault}/Projects/{projectName}/{sessionId}/...` — doc mismatch.
- `appendToDailyFile` does full read + rewrite on every message → O(n²) I/O in long sessions; concurrent `message_end` events could race (lost entries).
- Dead if/else: both branches do `entry += text`.
- `message_end` for role `user` also captures tool-result messages (tool results arrive as user-role messages) → vault can bloat with raw tool output.

### working-indicator.ts
- Persists mode to `~/.pi/extensions/working-indicator.json` — drops config JSON into the extensions directory alongside `.ts` files. Works, but pollutes that folder.

### highlight-footer.ts
- `ctx.ui.setWidget("token-budget", undefined)` — cross-extension coupling to `token-budget.ts`, which is not in this repo. Undocumented dependency.

### look.ts / voice-input
- Windows-only by design (powershell / DirectShow). Degrade gracefully on Linux (clipboard step fails → fallbacks). Fine, but worth noting for the README.

## Repo / hygiene

- `extensions/obsidian-logger/.env` is **git-tracked** despite `.gitignore` containing `.env`
  (was committed before the ignore rule). Currently only empty values (no secrets),
  but the pattern is a future leak vector. Consider `git rm --cached extensions/obsidian-logger/.env`.
- README extensions table omits: auto-continue, search-browser, obsidian-logger, compact-model (the duplicate).
- No tests, no lint/typecheck config — extensions are only validated at load time by jiti.
  A `tsc --noEmit` pass against the pi package types would have caught bugs #1 and #2.

## What looks good

- `event.input` mutation in search-browser matches documented `tool_call` contract (`event.input` is mutable).
- `pi.on("input")` returning `{ action: "handled" | "transform" }` in voice-input matches `InputEventResult`.
- `pi.registerShortcut`, `pi.sendUserMessage({ deliverAs })`, `ctx.isIdle()`, `pi.registerProvider(name, config)` all match the ExtensionAPI surface.
- highlight-footer pauses git polling during streaming/tool execution and disposes on stale ctx — good hygiene.
- clipboard-cleanup is small, safe, idempotent.
- `.gitignore` covers `.env` (except the already-tracked file above).
