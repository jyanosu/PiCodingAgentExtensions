/**
 * Obsidian Logger Extension
 *
 * Records all user prompts and assistant responses (excluding thinking blocks)
 * to Markdown files in an Obsidian vault.
 *
 * Images attached to user messages (e.g. /look screenshots) are saved to
 * {session}/images/ and embedded under the prompt entry.
 *
 * Folder structure: {root}/Projects/{projectName}/{sessionId}/MM-DD-YYYY.md
 * where {root} is the Obsidian vault by default, or the OS temp directory
 * (os.tmpdir()/pi-obsidian-logger) when switched via /obsidian-logger tmp.
 * Long sessions roll over to MM-DD-YYYY-2.md, -3.md, ... once a note
 * approaches MAX_NOTE_BYTES — Obsidian's renderer drops ![[embeds]] in
 * very large notes (~100KB+), so each note stays well under that.
 *
 * Assistant reasoning (thinking blocks) is excluded by default; enable it
 * per session with /obsidian-logger thinking.
 *
 * Config: set OBSIDIAN_VAULT_PATH in .env file next to this extension,
 * or export OBSIDIAN_VAULT_PATH environment variable.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

type CustomEntry = Extract<SessionEntry, { type: "custom" }>;
import { parseSkillBlock } from "@earendil-works/pi-coding-agent";
import {
  appendFile,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";

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
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
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
  const parse = (v: string) =>
    v.toLowerCase() !== "false" && v !== "0" && v.toLowerCase() !== "off";

  // Try environment variable first
  const envVal = process.env.OBSIDIAN_LOGGER_ENABLED;
  if (envVal !== undefined) return parse(envVal);

  // Try .env file next to this extension
  const envFile = join(__dirname, ".env");
  const envVars = loadEnvFile(envFile);
  if ("OBSIDIAN_LOGGER_ENABLED" in envVars)
    return parse(envVars.OBSIDIAN_LOGGER_ENABLED);

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

/** Format date as YYYY-MM-DD (sorts chronologically — used for titled folders) */
export function formatDateISO(): string {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${mm}-${dd}`;
}

/**
 * Turn a session title into a folder-name slug: lowercase, runs of
 * non-alphanumerics collapsed to single dashes, max 40 chars.
 * Returns "" when nothing usable remains.
 */
export function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug;
}

/**
 * Rename (or pre-name) the session folder for a human-readable title.
 *
 * Target name: {YYYY-MM-DD}-{slug}, with -2/-3/... appended on collision
 * with an existing sibling folder. When the current folder does not exist
 * yet (title set before the first write), nothing is renamed — the next
 * write simply creates the titled folder.
 *
 * Returns the effective folder name; `renamed` is true only when a real
 * fs.rename happened. A rename failure (e.g. Obsidian holds a file open,
 * EBUSY on Windows) keeps the old folder and reports the error — the title
 * still applies to note frontmatter.
 */
export async function renameSessionFolder(
  root: string,
  projectName: string,
  currentFolder: string,
  title: string,
): Promise<{ folder: string; renamed: boolean; error?: string }> {
  const slug = slugifyTitle(title);
  if (!slug)
    return { folder: currentFolder, renamed: false, error: "empty slug" };

  const projectDir = join(root, "Projects", projectName);
  let name = `${formatDateISO()}-${slug}`;
  let i = 2;
  for (;;) {
    try {
      await stat(join(projectDir, name));
      name = `${formatDateISO()}-${slug}-${i++}`;
    } catch {
      break; // free
    }
  }

  const oldPath = join(projectDir, currentFolder);
  let exists = true;
  try {
    await stat(oldPath);
  } catch {
    exists = false;
  }
  if (!exists) return { folder: name, renamed: false }; // first write creates it
  if (name === currentFolder) return { folder: name, renamed: false };

  try {
    await rename(oldPath, join(projectDir, name));
    return { folder: name, renamed: true };
  } catch (err) {
    const msg =
      typeof err === "object" && err !== null && "message" in err
        ? (err as { message: string }).message
        : String(err);
    return { folder: currentFolder, renamed: false, error: msg };
  }
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

/** File extensions for image blocks we know how to embed. */
const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
};

/** Extract attached image blocks (base64) from a user message's content. */
export function extractUserImages(
  content: unknown,
): Array<{ data: string; mimeType: string }> {
  if (!Array.isArray(content)) return [];
  const images: Array<{ data: string; mimeType: string }> = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; data?: unknown; mimeType?: unknown };
    if (
      b.type === "image" &&
      typeof b.data === "string" &&
      typeof b.mimeType === "string"
    ) {
      images.push({ data: b.data, mimeType: b.mimeType });
    }
  }
  return images;
}

/**
 * If the text is an expanded skill command (<skill ...>block</skill> + args),
 * reduce it to what the user actually typed (/skill:name args) so the vault
 * doesn't get filled with full SKILL.md bodies.
 */
function stripSkillExpansion(text: string): string {
  const skill = parseSkillBlock(text);
  if (!skill) return text;
  return skill.userMessage
    ? `/skill:${skill.name} ${skill.userMessage}`
    : `/skill:${skill.name}`;
}

/** Extract assistant text (excluding tool calls; thinking only when included) */
function extractAssistantText(
  content: unknown,
  includeThinking = false,
): string {
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as ContentBlock;
    if (typeof b.text !== "string") continue;
    if (b.type === "text") {
      parts.push(b.text);
    } else if (includeThinking && b.type === "thinking") {
      // Foldable in Obsidian; keeps the visible response uncluttered
      parts.push(
        `<details>\n<summary>🧠 Reasoning</summary>\n\n${b.text}\n\n</details>`,
      );
    }
  }
  return parts.join("\n");
}

/** Ensure a README.md exists in the project folder with the full path info */
async function ensureProjectReadme(
  vaultPath: string,
  projectName: string,
): Promise<void> {
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
    const msg =
      typeof err === "object" && err !== null && "message" in err
        ? (err as { message: string }).message
        : String(err);
    console.error(`[obsidian-logger] Failed to create README.md: ${msg}`);
  }
}

/** Best-effort git branch of cwd (undefined when not a git repo) */
function getGitBranch(cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd, timeout: 2000 },
      (err, stdout) => {
        resolve(err ? undefined : stdout.trim() || undefined);
      },
    );
  });
}

/** Minimal YAML quoting for frontmatter values */
function yq(v: string): string {
  const Q = String.fromCharCode(34); // double quote
  const B = String.fromCharCode(92); // backslash
  if (!v.includes(Q) && !v.includes(":") && !v.includes("#")) return v;
  return Q + v.split(Q).join(B + Q) + Q;
}

/** YAML frontmatter written once when a daily file is first created */
async function buildFrontmatter(
  ctx: ExtensionContext,
  projectName: string,
  sessionId: string,
  title?: string,
): Promise<string> {
  const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown";
  const branch = await getGitBranch(ctx.cwd);
  const lines = [
    "---",
    `project: ${yq(projectName)}`,
    `session: ${yq(sessionId)}`,
  ];
  if (title) lines.push(`title: ${yq(title)}`);
  lines.push(`model: ${yq(model)}`, `cwd: ${yq(ctx.cwd)}`);
  if (branch) lines.push(`branch: ${yq(branch)}`);
  lines.push(`created: ${new Date().toISOString()}`);
  lines.push("---");
  return `${lines.join("\n")}\n\n`;
}

/** In-flight frontmatter creation per file path (serializes concurrent first writes) */
const fileCreations = new Map<string, Promise<void>>();

/**
 * Max bytes per note before rolling over to the next numbered file.
 * Obsidian's editor stops processing markdown (incl. ![[embeds]]) once a
 * note gets very large (~100KB+); 50KB keeps a wide safety margin.
 */
const MAX_NOTE_BYTES = 50_000;

/**
 * Pick today's note file: the plain daily file while it fits, else the
 * next rollover (MM-DD-YYYY-2.md, -3.md, ...). A missing file always
 * wins; an existing file wins if the incoming entry still fits.
 */
async function resolveDailyFilePath(
  folderPath: string,
  dateStr: string,
  incomingBytes: number,
): Promise<string> {
  for (let i = 1; ; i++) {
    const name = i === 1 ? `${dateStr}.md` : `${dateStr}-${i}.md`;
    const p = join(folderPath, name);
    try {
      const st = await stat(p);
      if (st.size + incomingBytes <= MAX_NOTE_BYTES) return p;
    } catch {
      return p; // does not exist yet
    }
  }
}

/** Append content to the daily MD file */
export async function appendToDailyFile(
  ctx: ExtensionContext,
  vaultPath: string,
  projectName: string,
  sessionId: string,
  role: string,
  text: string,
  images: Array<{ data: string; mimeType: string }> = [],
  target: "vault" | "tmp" = "vault",
  title?: string,
): Promise<void> {
  if (!text.trim()) return;

  const dateStr = formatDate();
  const folderPath = join(vaultPath, "Projects", projectName, sessionId);
  const filePath = await resolveDailyFilePath(
    folderPath,
    dateStr,
    Buffer.byteLength(text, "utf-8"),
  );

  // Build markdown entry
  const roleLabel = role === "user" ? "## 👤 Prompt" : "## 🤖 Response";
  const timestamp = new Date().toLocaleTimeString();
  let entry = `\n${roleLabel} (${timestamp})\n\n`;

  entry += text;
  // Embed attached images (e.g. /look screenshots) under the entry:
  // write them to <session>/images/, then reference by name.
  if (images.length > 0) {
    const imgDir = join(folderPath, "images");
    await mkdir(imgDir, { recursive: true });
    // (images live in one shared folder per session; rollover notes
    // embed them the same way — names are timestamped, never collide)
    const d = new Date();
    const pad2 = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const ext = MIME_TO_EXT[img.mimeType] ?? "png";
      const name = `img-${stamp}-${i + 1}.${ext}`;
      await writeFile(join(imgDir, name), Buffer.from(img.data, "base64"));
      // vault: Obsidian wikilink (resolves anywhere in the vault);
      // tmp: relative markdown link (no vault to resolve wikilinks)
      entry +=
        target === "vault" ? `\n\n![[${name}]]` : `\n\n![](images/${name})`;
    }
  }
  entry += `\n\n---\n`;

  try {
    // Create folders if missing (kept inside try: a bad vault path must
    // notify, not crash the agent via unhandled rejection)
    await mkdir(folderPath, { recursive: true });
    // Write frontmatter exactly once per file. Creation is serialized per
    // file path: the winner does exclusive open + frontmatter via handle,
    // concurrent events await the same promise, then append — so the
    // frontmatter is in the file before any entry can land.
    let creation = fileCreations.get(filePath);
    if (!creation) {
      creation = (async () => {
        try {
          const fh = await open(filePath, "wx");
          try {
            await fh.writeFile(
              await buildFrontmatter(ctx, projectName, sessionId, title),
              "utf-8",
            );
          } finally {
            await fh.close();
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        }
      })();
      fileCreations.set(filePath, creation);
      void creation.finally(() => fileCreations.delete(filePath));
    }
    await creation;
    // Append directly — avoids read-modify-write (O(n²) I/O in long
    // sessions) and lost entries when two message_end events overlap.
    await appendFile(filePath, entry, "utf-8");
  } catch (err) {
    const msg =
      typeof err === "object" && err !== null && "message" in err
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
  let logThinking = false;
  let projectName: string = "";
  let sessionId: string = "";
  let readmeChecked = false;
  /** Human-readable session title (set via /obsidian-logger title <name>) */
  let sessionTitle: string | null = null;
  /** Effective session folder name; null = use the raw sessionId */
  let folderName: string | null = null;

  const effectiveFolder = () => folderName ?? sessionId;

  /** Full state string for notifications */
  const state = () =>
    `${enabled ? "ON" : "OFF"} (target: ${logTarget}, thinking: ${logThinking ? "on" : "off"}${sessionTitle ? `, title: ${sessionTitle}` : ""})`;

  pi.on("session_start", async (_event, ctx) => {
    enabled = readEnabledFromConfig();
    logTarget = "vault";
    logThinking = false;
    // Reset so a new session (possibly in a different cwd/project) gets its own README
    readmeChecked = false;

    if (!enabled) {
      console.log(
        "[obsidian-logger] Logger disabled (OBSIDIAN_LOGGER_ENABLED not set or false).",
      );
      if (ctx.hasUI) ctx.ui.notify(`Obsidian logger: ${state()}`, "warning");
      return;
    }

    vaultPath = getVaultPath();
    projectName = getProjectName(ctx.cwd);
    sessionId = ctx.sessionManager.getSessionId();

    if (!vaultPath) {
      console.log(
        "[obsidian-logger] OBSIDIAN_VAULT_PATH not set. Set it in .env file next to the extension or as an environment variable, or use /obsidian-logger tmp to log to the temp directory.",
      );
      if (ctx.hasUI)
        ctx.ui.notify(
          `Obsidian logger: ${state()} (no vault path set — use /obsidian-logger tmp)`,
          "info",
        );
      return;
    }

    // Restore the titled folder from the last persisted entry, so a resumed
    // session keeps writing into the renamed folder instead of splitting
    // notes between the uuid and the title. Only trusted when the folder
    // still exists on disk.
    const last = [...ctx.sessionManager.getEntries()]
      .reverse()
      .find(
        (e): e is CustomEntry =>
          e.type === "custom" && e.customType === "obsidianLoggerTitle",
      );
    if (last && typeof last.data === "string") {
      try {
        const saved = JSON.parse(last.data) as { t?: unknown; f?: unknown };
        if (typeof saved.f === "string" && saved.f) {
          await stat(join(vaultPath, "Projects", projectName, saved.f));
          folderName = saved.f;
          sessionTitle = typeof saved.t === "string" ? saved.t : null;
        }
      } catch {
        // missing folder or corrupt entry — fall back to the uuid folder
      }
    }

    const folderPath = join(
      vaultPath,
      "Projects",
      projectName,
      effectiveFolder(),
    );
    console.log(`[obsidian-logger] Logging to: ${folderPath}`);
    if (ctx.hasUI) ctx.ui.notify(`Obsidian logger: ${state()}`, "info");
  });

  // Capture user prompts and assistant responses
  pi.on("message_end", async (event, ctx) => {
    if (!enabled || !sessionId) return;

    const root = logTarget === "tmp" ? TMP_ROOT : vaultPath;
    if (!root) return;

    const role = event.message.role;
    if (role !== "user" && role !== "assistant") return;

    const text =
      role === "user"
        ? stripSkillExpansion(extractUserText(event.message.content))
        : extractAssistantText(event.message.content, logThinking);
    // Attached images (e.g. /look screenshots) are embedded with the prompt
    const images =
      role === "user" ? extractUserImages(event.message.content) : [];

    // Ensure README.md exists on first vault write of session (never in temp mode)
    if (logTarget === "vault" && !readmeChecked) {
      readmeChecked = true;
      await ensureProjectReadme(root, projectName);
    }

    await appendToDailyFile(
      ctx,
      root,
      projectName,
      effectiveFolder(),
      role,
      text,
      images,
      logTarget,
      sessionTitle ?? undefined,
    );
  });

  // Command: /obsidian-logger [on|off|tmp|vault|thinking [on|off]] (no arg = toggle on/off)
  pi.registerCommand("obsidian-logger", {
    description:
      "Toggle logging (on|off), switch target (tmp|vault), log reasoning (thinking [on|off]), or name the session (title <name>)",
    handler: async (args, ctx) => {
      const rawArgs = args || "";
      const arg = rawArgs.trim().toLowerCase();

      if (arg === "tmp") {
        logTarget = "tmp";
        if (ctx.hasUI)
          ctx.ui.notify(
            `Obsidian logger: ${state()} — logging to ${TMP_ROOT}`,
            "info",
          );
        return;
      }

      if (arg === "vault") {
        if (!vaultPath) {
          if (ctx.hasUI)
            ctx.ui.notify(
              `No vault configured — staying in tmp mode`,
              "warning",
            );
          return;
        }
        logTarget = "vault";
        if (ctx.hasUI)
          ctx.ui.notify(
            `Obsidian logger: ${state()} — logging to ${join(vaultPath, "Projects", projectName)}`,
            "info",
          );
        return;
      }

      if (arg === "title" || arg.startsWith("title ")) {
        if (!enabled || !sessionId) {
          if (ctx.hasUI)
            ctx.ui.notify(
              `Obsidian logger: ${state()} — title needs an enabled session`,
              "warning",
            );
          return;
        }
        const root = logTarget === "tmp" ? TMP_ROOT : vaultPath;
        if (!root) {
          if (ctx.hasUI)
            ctx.ui.notify(
              `No target configured — use /obsidian-logger tmp or set OBSIDIAN_VAULT_PATH`,
              "warning",
            );
          return;
        }
        const title = rawArgs.trim().slice("title".length).trim();
        if (!title) {
          if (ctx.hasUI)
            ctx.ui.notify(
              sessionTitle
                ? `Session title: ${sessionTitle} (folder: ${effectiveFolder()})`
                : `No title set — usage: /obsidian-logger title <name>`,
              "info",
            );
          return;
        }
        const res = await renameSessionFolder(
          root,
          projectName,
          effectiveFolder(),
          title,
        );
        if (res.error === "empty slug") {
          if (ctx.hasUI)
            ctx.ui.notify(
              `Title "${title}" has no usable characters — usage: /obsidian-logger title <name>`,
              "warning",
            );
          return;
        }
        sessionTitle = title;
        folderName = res.folder;
        // Persist so a resumed session keeps the titled folder
        pi.appendEntry(
          "obsidianLoggerTitle",
          JSON.stringify({ t: title, f: res.folder }),
        );
        if (ctx.hasUI) {
          if (res.renamed)
            ctx.ui.notify(
              `Session renamed → ${join(root, "Projects", projectName, res.folder)}`,
              "info",
            );
          else if (res.error)
            ctx.ui.notify(
              `Title set for notes only — folder rename failed: ${res.error} (close the note in Obsidian and retry)`,
              "warning",
            );
          else
            ctx.ui.notify(
              `Session will be logged to folder: ${res.folder}`,
              "info",
            );
        }
        return;
      }

      if (arg === "thinking" || arg.startsWith("thinking ")) {
        const sub = arg.split(" ")[1];
        if (sub === "on") logThinking = true;
        else if (sub === "off") logThinking = false;
        else logThinking = !logThinking;
        if (ctx.hasUI)
          ctx.ui.notify(
            `Obsidian logger: ${state()} — reasoning ${logThinking ? "now logged" : "no longer logged"}`,
            "info",
          );
        return;
      }

      if (arg === "on") {
        enabled = true;
      } else if (arg === "off") {
        enabled = false;
      } else {
        enabled = !enabled;
      }

      if (ctx.hasUI)
        ctx.ui.notify(
          `Obsidian logger: ${state()}`,
          enabled ? "info" : "warning",
        );
    },
  });
}
