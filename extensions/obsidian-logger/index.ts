/**
 * Obsidian Logger Extension
 *
 * Records all user prompts and assistant responses (excluding thinking blocks)
 * to Markdown files in an Obsidian vault.
 *
 * Folder structure: {root}/Projects/{projectName}/{sessionId}/MM-DD-YYYY.md
 * where {root} is the Obsidian vault by default, or the OS temp directory
 * (os.tmpdir()/pi-obsidian-logger) when switched via /obsidian-logger tmp.
 *
 * Config: set OBSIDIAN_VAULT_PATH in .env file next to this extension,
 * or export OBSIDIAN_VAULT_PATH environment variable.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseSkillBlock } from "@earendil-works/pi-coding-agent";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Temp-directory target root (OS-managed: %TEMP% on Windows, /tmp on Linux) */
const TMP_ROOT = join(tmpdir(), "pi-obsidian-logger");

type ContentBlock = {
  type?: string;
  text?: string;
};

/** Load .env file next to this extension (simple KEY=VALUE parser) */
function loadEnvFile(envPath: string): Record<string, string> {
  try {
    const content = readFileSync(envPath, "utf-8");
    const env: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();
      // Strip surrounding quotes
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      env[key] = value;
    }
    return env;
  } catch {
    return {};
  }
}

/** Read enabled value from config (env var or .env file). Default: true. */
function readEnabledFromConfig(): boolean {
  const parse = (v: string) => v.toLowerCase() !== "false" && v !== "0" && v.toLowerCase() !== "off";

  // Try environment variable first
  const envVal = process.env.OBSIDIAN_LOGGER_ENABLED;
  if (envVal !== undefined) return parse(envVal);

  // Try .env file next to this extension
  const envFile = join(__dirname, ".env");
  const envVars = loadEnvFile(envFile);
  if ("OBSIDIAN_LOGGER_ENABLED" in envVars) return parse(envVars.OBSIDIAN_LOGGER_ENABLED);

  // Default: enabled
  return true;
}

/** Get vault path from .env file or environment variable */
function getVaultPath(): string | undefined {
  // Try environment variable first
  const envPath = process.env.OBSIDIAN_VAULT_PATH;
  if (envPath) {
    return envPath;
  }

  // Try .env file next to this extension
  const envFile = join(__dirname, ".env");
  const envVars = loadEnvFile(envFile);
  if (envVars.OBSIDIAN_VAULT_PATH) {
    return envVars.OBSIDIAN_VAULT_PATH;
  }

  return undefined;
}

/** Get project name from cwd (last directory component) */
function getProjectName(cwd: string): string {
  // Handle both Windows and Unix paths
  const normalized = cwd.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] || "root";
}

/** Format date as MM-DD-YYYY */
function formatDate(): string {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const yyyy = now.getFullYear();
  return `${mm}-${dd}-${yyyy}`;
}

/** Extract text content from user message */
function extractUserText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as ContentBlock;
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    }
  }
  return parts.join("\n");
}

/**
 * If the text is an expanded skill command (<skill ...>block</skill> + args),
 * reduce it to what the user actually typed (/skill:name args) so the vault
 * doesn't get filled with full SKILL.md bodies.
 */
function stripSkillExpansion(text: string): string {
  const skill = parseSkillBlock(text);
  if (!skill) return text;
  return skill.userMessage ? `/skill:${skill.name} ${skill.userMessage}` : `/skill:${skill.name}`;
}

/** Extract assistant text (excluding thinking blocks and tool calls) */
function extractAssistantText(content: unknown): string {
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as ContentBlock;
    // Only include text blocks, skip thinking and tool calls
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    }
  }
  return parts.join("\n");
}

/** Ensure a README.md exists in the project folder with the full path info */
async function ensureProjectReadme(vaultPath: string, projectName: string): Promise<void> {
  const projectFolder = join(vaultPath, "Projects", projectName);
  const readmePath = join(projectFolder, "README.md");

  try {
    // Check if already exists
    await readFile(readmePath, "utf-8");
    return;
  } catch {
    // Does not exist, create it
  }

  const content = `# ${projectName}\n\nFull path: ${projectFolder}\n`;
  try {
    await mkdir(projectFolder, { recursive: true });
    await writeFile(readmePath, content, "utf-8");
  } catch (err) {
    const msg = typeof err === "object" && err !== null && "message" in err
      ? (err as { message: string }).message
      : String(err);
    console.error(`[obsidian-logger] Failed to create README.md: ${msg}`);
  }
}

/** Append content to the daily MD file */
async function appendToDailyFile(ctx: ExtensionContext, vaultPath: string, projectName: string, sessionId: string, role: string, text: string): Promise<void> {
  if (!text.trim()) return;

  const dateStr = formatDate();
  const fileName = `${dateStr}.md`;
  const folderPath = join(vaultPath, "Projects", projectName, sessionId);
  const filePath = join(folderPath, fileName);

  // Build markdown entry
  const roleLabel = role === "user" ? "## 👤 Prompt" : "## 🤖 Response";
  const timestamp = new Date().toLocaleTimeString();
  let entry = `\n${roleLabel} (${timestamp})\n\n`;

  entry += `${text}\n\n---\n`;

  try {
    // Create folders if missing (kept inside try: a bad vault path must
    // notify, not crash the agent via unhandled rejection)
    await mkdir(folderPath, { recursive: true });
    // Append directly — avoids read-modify-write (O(n²) I/O in long
    // sessions) and lost entries when two message_end events overlap.
    await appendFile(filePath, entry, "utf-8");
  } catch (err) {
    const msg = typeof err === "object" && err !== null && "message" in err
      ? (err as { message: string }).message
      : String(err);
    console.error(`[obsidian-logger] Failed to write: ${msg}`);
    if (ctx.hasUI) {
      ctx.ui.notify(`Obsidian logger write failed: ${msg}`, "warning");
    }
  }
}

export default function (pi: ExtensionAPI) {
  let enabled = true;
  let vaultPath: string | undefined;
  let logTarget: "vault" | "tmp" = "vault";
  let projectName: string = "";
  let sessionId: string = "";
  let readmeChecked = false;

  pi.on("session_start", async (_event, ctx) => {
    enabled = readEnabledFromConfig();
    logTarget = "vault";

    if (!enabled) {
      console.log("[obsidian-logger] Logger disabled (OBSIDIAN_LOGGER_ENABLED not set or false).");
      ctx.ui.notify(`Obsidian logger: OFF`, "warning");
      return;
    }

    vaultPath = getVaultPath();
    projectName = getProjectName(ctx.cwd);
    sessionId = ctx.sessionManager.getSessionId();

    if (!vaultPath) {
      console.log("[obsidian-logger] OBSIDIAN_VAULT_PATH not set. Set it in .env file next to the extension or as an environment variable, or use /obsidian-logger tmp to log to the temp directory.");
      ctx.ui.notify(`Obsidian logger: ON (no vault path set — use /obsidian-logger tmp)`, "info");
      return;
    }

    const folderPath = join(vaultPath, "Projects", projectName, sessionId);
    console.log(`[obsidian-logger] Logging to: ${folderPath}`);
    ctx.ui.notify(`Obsidian logger: ON (target: vault)`, "info");
  });

  // Capture user prompts and assistant responses
  pi.on("message_end", async (event, ctx) => {
    if (!enabled || !sessionId) return;

    const root = logTarget === "tmp" ? TMP_ROOT : vaultPath;
    if (!root) return;

    const role = event.message.role;
    if (role !== "user" && role !== "assistant") return;

    const text = role === "user"
      ? stripSkillExpansion(extractUserText(event.message.content))
      : extractAssistantText(event.message.content);

    // Ensure README.md exists on first vault write of session (never in temp mode)
    if (logTarget === "vault" && !readmeChecked) {
      readmeChecked = true;
      await ensureProjectReadme(root, projectName);
    }

    await appendToDailyFile(ctx, root, projectName, sessionId, role, text);
  });

  // Command: /obsidian-logger [on|off|tmp|vault] (no arg = toggle on/off)
  pi.registerCommand("obsidian-logger", {
    description: "Toggle Obsidian logging (on|off) or switch target (tmp|vault)",
    handler: async (args, ctx) => {
      const arg = (args || "").trim().toLowerCase();
      const onOff = enabled ? "ON" : "OFF";

      if (arg === "tmp") {
        logTarget = "tmp";
        ctx.ui.notify(`Obsidian logger: ${onOff} (target: tmp) — logging to ${TMP_ROOT}`, "info");
        return;
      }

      if (arg === "vault") {
        if (!vaultPath) {
          ctx.ui.notify(`No vault configured — staying in tmp mode`, "warning");
          return;
        }
        logTarget = "vault";
        ctx.ui.notify(`Obsidian logger: ${onOff} (target: vault) — logging to ${join(vaultPath, "Projects", projectName)}`, "info");
        return;
      }

      if (arg === "on") {
        enabled = true;
      } else if (arg === "off") {
        enabled = false;
      } else {
        enabled = !enabled;
      }

      ctx.ui.notify(`Obsidian logger: ${enabled ? "ON" : "OFF"} (target: ${logTarget})`, enabled ? "info" : "warning");
    },
  });
}
