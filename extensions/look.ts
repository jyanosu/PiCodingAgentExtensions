/**
 * /look Extension
 *
 * Sends a screenshot or image directly to the model as an attached image.
 *
 * Usage:
 *   Win+Shift+S  →  /look                  Analyze the clipboard screenshot (no Alt+V needed)
 *   Win+Shift+S  →  /look what's wrong?    Custom question about the clipboard screenshot
 *   /look C:\path\img.png describe this    Explicit image path + prompt
 *
 * Source priority: explicit path > Windows clipboard (direct) > newest pi-clipboard-* temp file.
 */

import { execFile } from "node:child_process";
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

/** Read the current Windows clipboard image directly, as base64 PNG. Null if none. */
function getClipboardImageBase64(): Promise<string | null> {
  return new Promise((resolve) => {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms,System.Drawing",
      "$img=[System.Windows.Forms.Clipboard]::GetImage()",
      "if($img){$ms=New-Object System.IO.MemoryStream; $img.Save($ms,[System.Drawing.Imaging.ImageFormat]::Png); [Convert]::ToBase64String($ms.ToArray())}",
    ].join("; ");
    execFile(
      "powershell",
      ["-NoProfile", "-Command", script],
      { timeout: 15000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        const out = stdout.trim();
        if (err || !out) return resolve(null);
        resolve(out);
      }
    );
  });
}

/** Find the newest pi-clipboard-* image in tmpdir, or null. */
async function findLatestClipboardFile(): Promise<{ path: string; mimeType: string } | null> {
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
    description: "Send clipboard screenshot or image file to the model. /look [prompt] or /look <image-path> [prompt]",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);

      let data: string | null = null;
      let mimeType: string | null = null;
      let promptParts = parts;

      // 1. Explicit image path as first arg
      if (parts.length > 0) {
        const first = parts[0];
        const ext = extname(first).toLowerCase();
        if (ext in MIME_BY_EXT && first.includes("\\")) {
          try {
            await stat(first);
            data = (await readFile(first)).toString("base64");
            mimeType = MIME_BY_EXT[ext]!;
            promptParts = parts.slice(1);
          } catch {}
        }
      }

      // 2. Windows clipboard directly (no Alt+V needed)
      if (!data) {
        const b64 = await getClipboardImageBase64();
        if (b64) {
          data = b64;
          mimeType = "image/png";
        }
      }

      // 3. Fallback: newest pi-clipboard-* temp file (from Alt+V paste)
      if (!data) {
        const found = await findLatestClipboardFile();
        if (found) {
          data = (await readFile(found.path)).toString("base64");
          mimeType = found.mimeType;
        }
      }

      if (!data || !mimeType) {
        ctx.ui.notify("No image found — screenshot with Win+Shift+S, or pass a path: /look C:\\path\\img.png", "error");
        return;
      }

      const prompt = promptParts.length > 0
        ? promptParts.join(" ")
        : "Describe and analyze this image.";

      pi.sendUserMessage([
        { type: "image", data, mimeType },
        { type: "text", text: prompt },
      ]);
    },
  });
}
