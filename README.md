# Pi Coding Agent Extensions

Custom extensions for [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent).

## Extensions

| Extension | Description |
| ----------- | ------------- |
| [highlight-footer](./extensions/highlight-footer.ts) | Custom footer with git status, model name, and gradient context usage bar |
| [compaction-model](./extensions/compaction-model.ts) | Uses a separate smaller model for session compaction and branch summarization |
| [working-indicator](./extensions/working-indicator.ts) | Context-aware working indicator that changes based on what Pi is doing |
| [response-latency](./extensions/response-latency.ts) | Shows response latency with color-coded speed phases |
| [voice-input](./extensions/voice-input/) | Voice-to-text prompts via FFmpeg + faster-whisper (`/voice`, `Alt+Q`) — Windows (DirectShow) |
| [clipboard-cleanup](./extensions/clipboard-cleanup.ts) | Deletes stale `pi-clipboard-*` screenshot temp files on session start |
| [look](./extensions/look.ts) | `/look` — send clipboard screenshot (or image path) to the model as an attached image — Windows clipboard, falls back to `pi-clipboard-*` temp files elsewhere |
| [auto-continue](./extensions/auto-continue.ts) | Auto-sends "continue" when the model leaks unexecuted tool-call XML as text (toggle: `/autocontinue`) |
| [search-browser](./extensions/search-browser.ts) | Toggle browser curator for `web_search` calls (`/search-browser on\|off`), persisted per session |
| [obsidian-logger](./extensions/obsidian-logger/) | Logs prompts + responses to an Obsidian vault as Markdown (`/obsidian-logger`) |
| [danger-guard](./extensions/danger-guard.ts) | Confirms before destructive bash commands (`rm -rf`, `git push --force`, `DROP TABLE`, …); blocks without UI (`/danger-guard`) |
| [file-tree](./extensions/file-tree.ts) | Live file tree panel on the right side (toggle: `/tree` or `Ctrl+Alt+T`) with git status colors/markers + branch header, name filter (`/tree <pattern>`), scroll (`Ctrl+Alt+↑/↓`), optional key-focus mode (`/tree focus on` → `Ctrl+Alt+L` panel keys, type to filter, `Esc` back) |

## Installation

Copy extensions to your Pi extensions directory:

```bash
# Default location
cp extensions/*.ts ~/.pi/agent/extensions/
```

Or enable individually:

```bash
pi --extension /path/to/PiCodingAgentExtensions/extensions/highlight-footer.ts
```

## Configuration

### highlight-footer

No configuration needed. Displays:

- Line 1: project name / git branch with staged/unstaged file counts
- Line 2: model name with gradient context usage bar (green → yellow → red)

### compaction-model

Environment variables:

```bash
COMPACTION_MODEL_PROVIDER=litellm
COMPACTION_MODEL_ID=Qwen3.5-8B
COMPACTION_MODEL_BASE_URL=http://localhost:4000/v1
COMPACTION_MODEL_API_KEY=your-key
COMPACTION_MODEL_MAX_TOKENS=8192
```

### working-indicator

Commands:

- `/working-indicator` — show current mode
- `/working-indicator dot` — static dot
- `/working-indicator pulse` — animated pulse
- `/working-indicator spinner` — rainbow spinner
- `/working-indicator auto` — context-aware (default)
- `/working-indicator none` — hide indicator
- `/working-indicator reset` — restore Pi default

### response-latency

No configuration needed. Shows two timings in the status bar: **response latency** (⚡) and the **whole-turn timer** (◷), e.g. `⚡ 1.2s ✓ | ◷ 2m05s`.

- **⚡ response latency** — the wait from when a model request is dispatched (prompt sent, or tool results handed back) until the response starts coming back. Each model call in a turn is measured separately, and the value freezes with a ✓ when the response arrives. Phases scaled for local AI (60s is still normal):
  - `< 30s` — ⚡ fast (green)
  - `30-60s` — ◉ normal (yellow)
  - `60-120s` — ◈ slow (orange)
  - `> 120s` — ✖ stalling (red)
- **◷ whole-turn timer** — total time for the current turn (prompt through completion, including tool execution and streaming). A plain stopwatch without phase coloring, since a long tool-heavy turn is normal.

Both values freeze with ✓ when the turn ends and stay in the status bar until the next prompt is sent.

### voice-input

Voice-to-text: records your microphone until silence, transcribes via a faster-whisper server, and sends the text as your prompt.

Commands:

- `/voice` — record until ~2s silence (default max 20s)
- `/voice 30` — allow up to 30s of speech
- `/voice mic` — show the active microphone and where it came from (env/.env, auto-detected, or fallback)
- `Alt+Q` — toggle: press once to start recording, press again to stop early (works for `/voice`-started recordings too)

Voice slash commands: say **"slash" + command** (e.g. "slash look what's wrong with this") to trigger any slash command by voice — rewritten to `/look ...` and dispatched automatically.

Footer state (via highlight-footer): 🎙 ready → 🔴 recording → ⏳ transcribing → 🎙 ready.

Config via `.env` next to the extension (see [extensions/voice-input/README.md](./extensions/voice-input/README.md)):

```bash
WHISPER_URL=https://{server}   # OpenAI-compatible /v1/audio/transcriptions
MIC_DEVICE=Microphone (Your Mic)                # optional — auto-detects first hardware mic if omitted
SILENCE_DURATION=3                              # seconds of silence before stopping
```

Requires: FFmpeg in PATH, a running faster-whisper server.

### clipboard-cleanup

No configuration needed. On session start, deletes `pi-clipboard-*` temp files (created by `Alt+V` image paste) older than 1 hour. Notifies when files are removed.

### auto-continue

On by default. Detects raw tool-call XML in assistant output (unparsed `<function=...>` blocks) and auto-sends `continue` so the model retries. Toggle with `/autocontinue`; state persists across sessions.

### search-browser

Controls whether `web_search` opens the interactive browser curator. `/search-browser on|off|toggle`. Choice persists in the session file.

### obsidian-logger

Appends user prompts and assistant responses (no thinking blocks, no tool output) to `{vault}/Projects/{project}/{sessionId}/MM-DD-YYYY.md`. Images attached to a prompt (e.g. `/look` screenshots) are saved to `{session}/images/` and embedded under the prompt entry. Toggle with `/obsidian-logger on|off`.

Config via `.env` next to the extension or environment variables:

```bash
OBSIDIAN_VAULT_PATH=/path/to/vault
OBSIDIAN_LOGGER_ENABLED=true   # optional, default true
```

### danger-guard

Intercepts `bash` tool calls and asks for confirmation before destructive commands. Also asks when a command navigates (`cd`/`pushd`) outside the working-dir tree — moving into subdirectories is fine, leaving the tree (parents, `/tmp`, home, …) prompts. Without a UI (non-interactive mode) matching commands are blocked outright. On by default every session — state is in-memory, never persisted.

Commands:

- `/danger-guard` — show state + active patterns
- `/danger-guard on|off|toggle`

Default patterns: `rm -r/-f`, `sudo`, `chmod 777`, Windows `del/rd /s`, `format <drive>:`/`diskpart`, PowerShell `Remove-Item -Recurse`/`Clear-Disk`/`Format-Volume`, `git push --force|-f|--force-with-lease`, `git reset --hard`, `git clean -d…`, `git checkout --`, `git branch -D`, SQL `DROP`/`TRUNCATE`, `mkfs`/`dd of=/dev/…`/`shred`.

Environment variables:

```bash
DANGER_GUARD_PATTERNS='["\\bgit\\s+push\\b"]'  # JSON array of regex strings, replaces defaults
DANGER_GUARD_TIMEOUT_MS=120000                  # confirm timeout (default 120s; timeout = block)
DANGER_GUARD_NAV=off                            # optional: disable the cd-outside-working-dir check (default on)
```

### look

Sends a screenshot or image directly to the model as an attached image. Requires a vision-capable model (`"input": ["text", "image"]` in `models.json`).

Workflow:

1. Take a screenshot: `Win+Shift+S`
2. Type the command below and submit — the Windows clipboard is read directly (no `Alt+V` needed)

Commands:

- `/look` — analyze the current clipboard screenshot (default: describe + analyze)
- `/look what's wrong with this error?` — custom question about the screenshot
- `/look C:\path\to\img.png describe this` — explicit image file + prompt

Source priority: explicit path → Windows clipboard → newest `pi-clipboard-*` temp file (last hour). Supported formats: png, jpg/jpeg, gif, webp, bmp.

## Development

Extensions use Pi's Extension API. See [Pi Extensions Docs](https://github.com/earendil-works/pi-coding-agent/docs/extensions.md) for the full API reference.

Typecheck (strict, against the pi package types):

```bash
npm install
npm run typecheck
```

## Agents

Global agent instructions for Pi Coding Agent. See [agents/AGENTS.md](./agents/AGENTS.md).

Install:

```bash
cp agents/AGENTS.md ~/.pi/agent/AGENTS.md
```

## Skills

Reusable procedures and patterns for Pi Coding Agent.

### Built-in Skills (Pi Core)

| Skill | Description |
| ------- | ------------- |
| [build](./skills/build/SKILL.md) | Implement one task or scoped change |
| [coverage](./skills/coverage/SKILL.md) | Evaluate test coverage and fill gaps |
| [plan](./skills/plan/SKILL.md) | Break work into agent-ready tasks |
| [review](./skills/review/SKILL.md) | Review code changes for bugs and risks |
| [spec](./skills/spec/SKILL.md) | Write implementation specs |
| [startup](./skills/startup/SKILL.md) | Read and understand a project |

Install:

```bash
# Install all
cp -r skills/* ~/.pi/agent/skills/

# Individual
cp -r skills/build ~/.pi/agent/skills/
```

## License

MIT
