# Obsidian Logger Extension for Pi

Records all prompts and responses to Markdown files in your Obsidian vault —
or, per session, in the OS temp directory (cleared by the system over time).

## Setup

1. Edit `.env` file (next to `index.ts`) and set your vault path:

   ```
   OBSIDIAN_VAULT_PATH=C:/Users/YourName/Documents/ObsidianVault
   ```

2. Or set the environment variable:

   ```bash
   export OBSIDIAN_VAULT_PATH="C:/path/to/vault"
   ```

### Disable Logging (Optional)

Set `OBSIDIAN_LOGGER_ENABLED` to `false`, `0`, or `off` in `.env` or as an environment variable. Default is **enabled**.

```
OBSIDIAN_LOGGER_ENABLED=false
```

### Toggle at Runtime

Use the `/obsidian-logger` command to toggle logging without restarting:

| Command | Action |
| --- | --- |
| `/obsidian-logger` | Toggle on/off |
| `/obsidian-logger on` | Enable logging |
| `/obsidian-logger off` | Disable logging |

A notification shows the current state when Pi loads and after each change.

### Switch Target (Temp vs Vault)

By default, logs go to your Obsidian vault. For scratch sessions, switch the
current session's logging to the OS temp directory:

| Command | Action |
| --- | --- |
| `/obsidian-logger tmp` | Log this session to `{tmpdir}/pi-obsidian-logger/...` |
| `/obsidian-logger vault` | Switch back to the configured vault |

- **Session-only**: the switch is not persisted. Every new session starts at the vault.
- **No vault needed**: `tmp` mode works even when `OBSIDIAN_VAULT_PATH` is unset.
- **Not retroactive**: entries already written stay where they were.
- **No `README.md`** is created in temp mode.
- Temp location: `%TEMP%/pi-obsidian-logger` on Windows, `/tmp/pi-obsidian-logger` on Linux.
  The OS reclaims these over time (Storage Sense / Disk Cleanup on Windows; reboot or
  `systemd-tmpfiles` age policies on Linux) — treat temp logs as best-effort scratch,
  not guaranteed deletion.

### Log Reasoning (Thinking)

Assistant thinking blocks are **excluded by default**. To also log the model's
reasoning for the current session:

| Command | Action |
| --- | --- |
| `/obsidian-logger thinking` | Toggle reasoning logging on/off |
| `/obsidian-logger thinking on` | Enable reasoning logging |
| `/obsidian-logger thinking off` | Disable reasoning logging |

- **Off by default**: every new Pi session starts with reasoning logging off.
- **Session-only**: the flag is not persisted; it lasts until the session ends.
- Reasoning appears inside a foldable `<details>🧠 Reasoning</details>` block
  within the response entry, so the visible answer stays uncluttered.

## Folder Structure

```
{root}/Projects/{projectName}/{sessionId}/MM-DD-YYYY.md   (rolls over to -2, -3, ... past ~50KB)
{root}/Projects/{projectName}/{sessionId}/images/img-YYYYMMDD-HHMMSS-N.png
```

`{root}` is your vault by default, or `{tmpdir}/pi-obsidian-logger` in temp mode.

Example: `C:/Vault/Projects/eVETAssist/abc123-def456/06-15-2025.md`

- **Project name**: Last directory component of your working directory
- **Session ID**: Unique Pi session UUID
- **Date file**: MM-DD-YYYY format, appends if file exists; rolls over to
  `MM-DD-YYYY-2.md`, `-3.md`, ... once a note approaches 50KB (Obsidian's
  renderer drops `![[embeds]]` in very large notes, ~100KB+)
- **images/**: attached images from user messages (created only when needed)

### Image Embedding

Images attached to a user prompt (e.g. a `/look` screenshot) are saved to the
session's `images/` folder and embedded directly under the prompt entry, so
the screenshot lives right where you asked about it.

- **Vault mode**: embedded as an Obsidian wikilink `![[img-....png]]` (resolves
  anywhere in the vault).
- **Temp mode**: embedded as a relative markdown link `![](images/img-....png)`
  (no vault to resolve wikilinks).
- File name: `img-YYYYMMDD-HHMMSS-N.png` (N = position in the message).
- Supported types: png, jpeg, gif, webp, bmp (anything else falls back to `.png`).

## Markdown Format

## Markdown Format

Each daily file starts with YAML frontmatter (written once, on file
creation), then entries with timestamps:

```markdown
---
project: PiCodingAgentExtensions
session: 01a01a33-92d7-7ae7-9a17-1b2b7e07e225
model: anthropic/claude-sonnet-4-5
branch: main
cwd: /projects/PiCodingAgentExtensions
created: 2026-08-19T13:30:00.000Z
---

## 👤 Prompt (10:30:45 AM)

Your prompt text here...

![[img-20250615-103044-1.png]]

---

## 🤖 Response (10:30:50 AM)

<details>
<summary>🧠 Reasoning</summary>

Model thinking text here... (only when `/obsidian-logger thinking` is on)

</details>

Assistant response text here...

---
```

Frontmatter fields:

- **project / session**: as in the folder structure
- **model**: `provider/model-id` of the current model at file creation (`unknown` if unavailable)
- **branch**: current git branch, omitted when cwd is not a git repo
- **cwd**: working directory at file creation
- **created**: ISO timestamp of first write

Files created before frontmatter support have none (not backfilled).

## Notes

- Thinking blocks are excluded by default; enable per session with `/obsidian-logger thinking`
- Multiple entries on same day append to same file
- Folders created automatically if missing
- Failures are silent — won't disrupt your session
