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
|---|---|
| `/obsidian-logger` | Toggle on/off |
| `/obsidian-logger on` | Enable logging |
| `/obsidian-logger off` | Disable logging |

A notification shows the current state when Pi loads and after each change.

### Switch Target (Temp vs Vault)

By default, logs go to your Obsidian vault. For scratch sessions, switch the
current session's logging to the OS temp directory:

| Command | Action |
|---|---|
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

## Folder Structure

```
{root}/Projects/{projectName}/{sessionId}/MM-DD-YYYY.md
```

`{root}` is your vault by default, or `{tmpdir}/pi-obsidian-logger` in temp mode.

Example: `C:/Vault/Projects/eVETAssist/abc123-def456/06-15-2025.md`

- **Project name**: Last directory component of your working directory
- **Session ID**: Unique Pi session UUID
- **Date file**: MM-DD-YYYY format, appends if file exists

## Markdown Format

Each entry is a section with timestamp:

```markdown
## 👤 Prompt (10:30:45 AM)

Your prompt text here...

---

## 🤖 Response (10:30:50 AM)

Assistant response text here...

---
```

## Notes

- Thinking blocks are excluded (only visible responses logged)
- Multiple entries on same day append to same file
- Folders created automatically if missing
- Failures are silent — won't disrupt your session
