# Voice Input Extension for Pi

Transforms voice into text prompts using your local faster-whisper server. No manual paste needed.

## Usage

Type `/voice` and press Enter — records until ~2s of silence (default max 20s).

| Command | Duration |
| --- | --- |
| `/voice` | Until silence (default max 20s) |
| `/voice 10` | Until silence (max 10s) |
| `/voice 30` | Until silence (max 30s) |
| `/voice 100` | Capped at 60s |
| `/voice mic` | Show the active microphone |

### Alt+Q toggle

Press `Alt+Q` to start recording, press `Alt+Q` again to stop early — no need to wait for silence. Works for `/voice`-started recordings too. Recordings shorter than 1s are discarded as accidental presses. While a recording or transcription is in flight, further `/voice` / `Alt+Q` presses are ignored ("busy").

## Voice Slash Commands

Say **"slash" + command** to trigger any slash command by voice. Whisper never transcribes `/`, so `slash` is the spoken prefix — the extension rewrites it.

| You say | Becomes |
| --- | --- |
| "slash look what's wrong with this" | `/look what's wrong with this` |
| "slash voice" | `/voice` |
| "slash compact" | `/compact` |

Works from both `/voice` and `Alt+Q`. Trailing periods Whisper adds are stripped from bare commands.

## How It Works

1. You type `/voice [seconds]` and submit (or press Alt+Q)
2. Pi records audio from your microphone via FFmpeg (until silence, or until you press Alt+Q again); when stopped by silence, the trailing silence is trimmed off
3. Sends audio to your faster-whisper server for transcription
4. Transcribed text replaces the command and becomes your prompt
5. Agent processes the transcribed text as if you typed it

## Requirements

- **FFmpeg** installed and in PATH (for mic recording)
- **faster-whisper-server** running with OpenAI-compatible API (`/v1/audio/transcriptions`)

## Config

Edit `.env` file next to `index.ts`:

```
WHISPER_URL=https://{server}
MIC_DEVICE=Microphone (BlackShark V3 Pro - Chat)
```

Or set as environment variables.

To change microphone, list available devices:

```bash
ffmpeg -list_devices true -f dshow -i dummy
```
