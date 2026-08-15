# Voice Input Extension for Pi

Transforms voice into text prompts using your local faster-whisper server. No manual paste needed.

## Usage

Type `/voice` and press Enter — records 5 seconds by default.

| Command | Duration |
|---|---|
| `/voice` | 5 seconds (default) |
| `/voice 10` | 10 seconds |
| `/voice 30` | Up to 120 seconds |

## Voice Slash Commands

Say **"slash" + command** to trigger any slash command by voice. Whisper never transcribes `/`, so `slash` is the spoken prefix — the extension rewrites it.

| You say | Becomes |
|---|---|
| "slash look what's wrong with this" | `/look what's wrong with this` |
| "slash voice" | `/voice` |
| "slash compact" | `/compact` |

Works from both `/voice` and `Alt+Q`. Trailing periods Whisper adds are stripped from bare commands.

## How It Works

1. You type `/voice [seconds]` and submit
2. Pi records audio from your microphone via FFmpeg
3. Sends audio to your faster-whisper server for transcription
4. Transcribed text replaces the command and becomes your prompt
5. Agent processes the transcribed text as if you typed it

## Requirements

- **FFmpeg** installed and in PATH (for mic recording)
- **faster-whisper-server** running with OpenAI-compatible API (`/v1/audio/transcriptions`)

## Config

Edit `.env` file next to `index.ts`:

```
WHISPER_URL=https://whisper.local.johnyan.net
MIC_DEVICE=Microphone (BlackShark V3 Pro - Chat)
```

Or set as environment variables.

To change microphone, list available devices:
```bash
ffmpeg -list_devices true -f dshow -i dummy
```
