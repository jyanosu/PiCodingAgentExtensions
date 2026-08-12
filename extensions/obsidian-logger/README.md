# Obsidian Logger Extension for Pi

Records all prompts and responses to Markdown files in your Obsidian vault.

## Setup

1. Edit `.env` file (next to `index.ts`) and set your vault path:
   ```
   OBSIDIAN_VAULT_PATH=C:/Users/YourName/Documents/ObsidianVault
   ```

2. Or set the environment variable:
   ```bash
   export OBSIDIAN_VAULT_PATH="C:/path/to/vault"
   ```

## Folder Structure

```
{vault}/{projectName}/{sessionId}/MM-DD-YYYY.md
```

Example: `C:/Vault/eVETAssist/abc123-def456/06-15-2025.md`

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
