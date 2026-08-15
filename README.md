# Pi Coding Agent Extensions

Custom extensions for [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent).

## Extensions

| Extension | Description |
|-----------|-------------|
| [highlight-footer](./extensions/highlight-footer.ts) | Custom footer with git status, model name, and gradient context usage bar |
| [compaction-model](./extensions/compaction-model.ts) | Uses a separate smaller model for session compaction and branch summarization |
| [working-indicator](./extensions/working-indicator.ts) | Context-aware working indicator that changes based on what Pi is doing |
| [response-latency](./extensions/response-latency.ts) | Shows response latency with color-coded speed phases |
| [voice-input](./extensions/voice-input/) | Voice-to-text prompts via FFmpeg + faster-whisper (`/voice`, `Alt+Q`) |
| [clipboard-cleanup](./extensions/clipboard-cleanup.ts) | Deletes stale `pi-clipboard-*` screenshot temp files on session start |
| [look](./extensions/look.ts) | `/look` — send clipboard screenshot (or image path) to the model as an attached image |

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

No configuration needed. Shows latency in status bar with phases:
- `< 2s` — ⚡ fast (green)
- `2-5s` — ◉ normal (yellow)
- `5-10s` — ◈ slow (orange)
- `> 10s` — ✖ stalling (red)

### voice-input

Voice-to-text: records your microphone until silence, transcribes via a faster-whisper server, and sends the text as your prompt.

Commands:
- `/voice` — record until ~2s silence (default max 20s)
- `/voice 30` — allow up to 30s of speech
- `Alt+Q` — same as `/voice`

Config via `.env` next to the extension (see [extensions/voice-input/README.md](./extensions/voice-input/README.md)):
```bash
WHISPER_URL=https://whisper.local.johnyan.net   # OpenAI-compatible /v1/audio/transcriptions
MIC_DEVICE=Microphone (Your Mic)                # optional — auto-detects first hardware mic if omitted
SILENCE_DURATION=3                              # seconds of silence before stopping
```

Requires: FFmpeg in PATH, a running faster-whisper server.

### clipboard-cleanup

No configuration needed. On session start, deletes `pi-clipboard-*` temp files (created by `Alt+V` image paste) older than 1 hour. Notifies when files are removed.

### look

Sends a screenshot or image directly to the model as an attached image. Requires a vision-capable model (`"input": ["text", "image"]` in `models.json`).

Workflow:
1. Take a screenshot: `Win+Shift+S`
2. Type the command below and submit — the image is attached automatically

Commands:
- `/look` — analyze the newest clipboard screenshot (default: describe + analyze)
- `/look what's wrong with this error?` — custom question about the screenshot
- `/look C:\path\to\img.png describe this` — explicit image file + prompt

Supported formats: png, jpg/jpeg, gif, webp, bmp. Only clipboard images from the last hour are considered.

## Development

Extensions use Pi's Extension API. See [Pi Extensions Docs](https://github.com/earendil-works/pi-coding-agent/docs/extensions.md) for the full API reference.

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
|-------|-------------|
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
