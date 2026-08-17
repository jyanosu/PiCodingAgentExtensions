/**
 * Clipboard Cleanup Extension
 *
 * Deletes stale pi-clipboard-* temp files (created by Alt+V image paste) on session start.
 * Files older than MAX_AGE_MS are removed; recent ones are kept in case they're still referenced.
 */

import { readdir, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
const PREFIX = "pi-clipboard-";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    try {
      const dir = tmpdir();
      const now = Date.now();
      const names = await readdir(dir);
      let removed = 0;

      for (const name of names) {
        if (!name.startsWith(PREFIX)) continue;
        const path = join(dir, name);
        try {
          const s = await stat(path);
          if (s.isFile() && now - s.mtimeMs > MAX_AGE_MS) {
            await unlink(path);
            removed++;
          }
        } catch {
          // file vanished or unreadable — skip
        }
      }

      if (removed > 0) {
        ctx.ui.notify(`Clipboard cleanup: removed ${removed} stale image temp file(s)`, "info");
      }
    } catch {
      // tmpdir unreadable — skip silently
    }
  });
}
