/**
 * /look Extension
 *
 * Sends the latest clipboard screenshot (pi-clipboard-* in %TEMP%) directly to the model
 * as an attached image, with an optional prompt.
 *
 * Usage:
 *   Win+Shift+S  →  /look                  Describe/analyze the latest screenshot
 *   Win+Shift+S  →  /look what's wrong?    Custom question about the screenshot
 *   /look C:\path\img.png describe this    Explicit image path + prompt
 */

import { readdir, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_AGE_MS = 60 * 60 * 1000; // ignore clipboard images older than 1 hour
const PREFIX = "pi-clipboard-";

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

/** Find the newest pi-clipboard-* image in tmpdir, or null. */
async function findLatestClipboardImage(): Promise<{ path: string; mimeType: string } | null> {
  try {
    const dir = tmpdir();
    const now = Date.now();
    let best: { path: string; mtimeMs: number; ext: string } | null = null;

    for (const name of await readdir(dir)) {
      if (!name.startsWith(PREFIX)) continue;
      const ext = extname(name).toLowerCase();
      if (!(ext in MIME_BY_EXT)) continue;
      try {
        const s = await stat(join(dir, name));
        if (!s.isFile() || now - s.mtimeMs > MAX_AGE_MS) continue;
        if (!best || s.mtimeMs > best.mtimeMs) {
          best = { path: join(dir, name), mtimeMs: s.mtimeMs, ext };
        }
      } catch {}
    }

    if (!best) return null;
    return { path: best.path, mimeType: MIME_BY_EXT[best.ext]! };
  } catch {
    return null;
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("look", {
    description: "Send latest clipboard screenshot to the model. /look [prompt] or /look <image-path> [prompt]",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);

      // Optional explicit image path as first arg
      let imagePath: string | null = null;
      let mimeType: string | null = null;
      let promptParts = parts;

      if (parts.length > 0) {
        const first = parts[0];
        const ext = extname(first).toLowerCase();
        if (ext in MIME_BY_EXT && first.includes("\\")) {
          try {
            await stat(first);
            imagePath = first;
            mimeType = MIME_BY_EXT[ext]!;
            promptParts = parts.slice(1);
          } catch {}
        }
      }

      // Fall back to newest clipboard screenshot
      if (!imagePath) {
        const found = await findLatestClipboardImage();
        if (!found) {
          ctx.ui.notify("No recent clipboard image found (screenshot with Win+Shift+S first)", "error");
          return;
        }
        imagePath = found.path;
        mimeType = found.mimeType;
      }

      const buffer = await readFile(imagePath);
      const prompt = promptParts.length > 0
        ? promptParts.join(" ")
        : "Describe and analyze this image.";

      pi.sendUserMessage([
        { type: "image", data: buffer.toString("base64"), mimeType: mimeType! },
        { type: "text", text: prompt },
      ]);
    },
  });
}
