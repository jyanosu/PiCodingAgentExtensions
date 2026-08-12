/**
 * Obsidian Logger Extension
 *
 * Records all user prompts and assistant responses (excluding thinking blocks)
 * to Markdown files in an Obsidian vault.
 *
 * Folder structure: {vault}/{projectName}/{sessionId}/MM-DD-YYYY.md
 *
 * Config: set OBSIDIAN_VAULT_PATH in .env file next to this extension,
 * or export OBSIDIAN_VAULT_PATH environment variable.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

/** Append content to the daily MD file */
async function appendToDailyFile(ctx: ExtensionContext, vaultPath: string, projectName: string, sessionId: string, role: string, text: string): Promise<void> {
  if (!text.trim()) return;

  const dateStr = formatDate();
  const fileName = `${dateStr}.md`;
  const folderPath = join(vaultPath, "Projects", projectName, sessionId);
  const filePath = join(folderPath, fileName);

  // Create folders if missing
  await mkdir(folderPath, { recursive: true });

  // Build markdown entry
  const roleLabel = role === "user" ? "## 👤 Prompt" : "## 🤖 Response";
  const timestamp = new Date().toLocaleTimeString();
  let entry = `\n${roleLabel} (${timestamp})\n\n`;

  if (role === "user") {
    entry += `${text}\n`;
  } else {
    // Wrap response in markdown for readability
    entry += `${text}\n`;
  }
  entry += `\n---\n`;

  try {
    // Check if file exists, read existing content
    let existing = "";
    try {
      existing = await readFile(filePath, "utf-8");
    } catch {
      // File doesn't exist yet, that's fine
    }

    // Write combined content
    await writeFile(filePath, existing + entry, "utf-8");
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
  let vaultPath: string | undefined;
  let projectName: string = "";
  let sessionId: string = "";

  pi.on("session_start", async (_event, ctx) => {
    vaultPath = getVaultPath();
    if (!vaultPath) {
      console.log("[obsidian-logger] OBSIDIAN_VAULT_PATH not set. Set it in .env file next to the extension or as an environment variable.");
      return;
    }

    projectName = getProjectName(ctx.cwd);
    sessionId = ctx.sessionManager.getSessionId();

    const folderPath = join(vaultPath, "Projects", projectName, sessionId);
    console.log(`[obsidian-logger] Logging to: ${folderPath}`);
  });

  // Capture user prompts and assistant responses
  pi.on("message_end", async (event, ctx) => {
    if (!vaultPath || !sessionId) return;

    const role = event.message.role;
    if (role !== "user" && role !== "assistant") return;

    const text = role === "user"
      ? extractUserText(event.message.content)
      : extractAssistantText(event.message.content);

    await appendToDailyFile(ctx, vaultPath, projectName, sessionId, role, text);
  });
}
