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
  + `tsconfig.json` (strict) + `npm run typecheck`.

## What looks good

- `event.input` mutation in search-browser matches documented `tool_call` contract (`event.input` is mutable).
- `pi.on("input")` returning `{ action: "handled" | "transform" }` in voice-input matches `InputEventResult`.
- `pi.registerShortcut`, `pi.sendUserMessage({ deliverAs })`, `ctx.isIdle()`, `pi.registerProvider(name, config)` all match the ExtensionAPI surface.
- highlight-footer pauses git polling during streaming/tool execution and disposes on stale ctx — good hygiene.
- clipboard-cleanup is small, safe, idempotent.
- `.gitignore` covers `.env` (except the already-tracked file above).
