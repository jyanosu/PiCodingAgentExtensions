/**
 * Danger Guard Extension
 *
 * Intercepts `bash` tool calls and asks for confirmation before running
 * destructive commands (rm -rf, git push --force, DROP TABLE, ...).
 * Without a UI (non-interactive mode) matching commands are blocked outright.
 *
 * Commands:
 *   /danger-guard        — show state + active patterns
 *   /danger-guard on|off — enable/disable (in-memory, defaults ON each session)
 *   /danger-guard toggle
 *
 * Config (environment variables):
 *   DANGER_GUARD_PATTERNS   — JSON array of regex strings, replaces defaults
 *                             e.g. ["\\bgit\\s+push\\b", "\\bdel\\s+/s"]
 *   DANGER_GUARD_TIMEOUT_MS — confirm dialog timeout in ms (default 120000);
 *                             timeout = block (safe default)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface DangerPattern {
  name: string;
  re: RegExp;
}

/** Curated destructive-command patterns (bash + cmd/PowerShell + git + DB + disk). */
export const DEFAULT_PATTERNS: DangerPattern[] = [
  // rm with a recursive and/or force flag: rm -r, rm -f, rm -rf, rm -Rf
  { name: "rm -r/-f", re: /\brm\s+(?:-\w+\s+)*-\w*[rf]\w*(?:\s|$)/i },
  // sudo (escalation)
  { name: "sudo", re: /\bsudo\b/i },
  // world-writable permissions
  { name: "chmod 777", re: /\bchmod\b.*\b777\b/i },
  // Windows: del /s|/f|/q, rd /s, rmdir /s
  { name: "del/rd /s", re: /\b(?:del|erase|rd|rmdir)\s+\/\w*[sfq]\w*/i },
  // Windows: format C:, diskpart
  { name: "format/diskpart", re: /\bformat\s+[a-z]:|\bdiskpart\b/i },
  // PowerShell: Remove-Item -Recurse, Clear-Disk, Format-Volume
  { name: "PowerShell remove/format", re: /\bremove-item\b.*-recurse\b|\bclear-disk\b|\bformat-volume\b/i },
  // git: push --force / -f / --force-with-lease
  { name: "git push --force", re: /\bgit\s+push\b[\s\S]*?(\s-f\b|--force\b|--force-with-lease\b)/i },
  // git: reset --hard
  { name: "git reset --hard", re: /\bgit\s+reset\s+--hard\b/i },
  // git: clean with -d (removes untracked files/dirs), e.g. git clean -fd
  { name: "git clean -d", re: /\bgit\s+clean\s+(?:-\w+\s+)*-\w*d\w*(?:\s|$)/i },
  // git: checkout -- (discards worktree changes)
  { name: "git checkout --", re: /\bgit\s+checkout\s+--\s/i },
  // git: branch -D (force delete branch) — case-sensitive, -d is the safe variant
  { name: "git branch -D", re: /\bgit\s+branch\s+-D\b/ },
  // DB: DROP / TRUNCATE
  { name: "DROP/TRUNCATE", re: /\bdrop\s+(?:table|database|schema|index)\b|\btruncate\s+table\b/i },
  // low-level disk ops: mkfs.*, dd of=/dev/..., shred
  { name: "mkfs/dd/shred", re: /\bmkfs\b|\bdd\s+.*\bof=\/(?:dev|sd|nvme|hd)\b|\bshred\b/i },
];

/** Return the first pattern matched by the command, or null. */
export function matchDangerousCommand(command: string, patterns: DangerPattern[]): DangerPattern | null {
  for (const p of patterns) {
    if (p.re.test(command)) return p;
  }
  return null;
}

/** Build pattern list from DANGER_GUARD_PATTERNS (JSON array of regex strings) or defaults. */
export function loadPatterns(env: NodeJS.ProcessEnv = process.env): DangerPattern[] {
  const raw = env.DANGER_GUARD_PATTERNS;
  if (!raw) return DEFAULT_PATTERNS;
  try {
    const list = JSON.parse(raw);
    if (!Array.isArray(list) || list.length === 0) return DEFAULT_PATTERNS;
    const patterns: DangerPattern[] = [];
    for (const item of list) {
      if (typeof item !== "string" || !item) continue;
      try {
        patterns.push({ name: item.slice(0, 40), re: new RegExp(item, "i") });
      } catch {
        // skip invalid regexes
      }
    }
    return patterns.length > 0 ? patterns : DEFAULT_PATTERNS;
  } catch {
    return DEFAULT_PATTERNS;
  }
}

/** Confirm timeout in ms from DANGER_GUARD_TIMEOUT_MS (default 120000, clamped 1000..600000). */
export function loadTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = parseInt(env.DANGER_GUARD_TIMEOUT_MS ?? "", 10);
  if (isNaN(n)) return 120000;
  return Math.min(600000, Math.max(1000, n));
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

export default function (pi: ExtensionAPI) {
  let enabled = true;
  const patterns = loadPatterns();
  const timeoutMs = loadTimeoutMs();

  pi.on("session_start", async (_event, ctx) => {
    enabled = true; // safe default: guard is ON for every new session
    ctx.ui.notify(`Danger guard: ON (${patterns.length} patterns) — /danger-guard to toggle`, "info");
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!enabled || event.toolName !== "bash") return;
    const command = typeof event.input?.command === "string" ? event.input.command : "";
    if (!command) return;

    const hit = matchDangerousCommand(command, patterns);
    if (!hit) return;

    if (!ctx.hasUI) {
      // Non-interactive: no one to ask — block (safe default)
      return { block: true, reason: `Danger guard: blocked (${hit.name}) — no UI for confirmation` };
    }

    const ok = await ctx.ui.confirm(
      "⚠️ Danger guard",
      `Matched: ${hit.name}\n\n${truncate(command, 600)}\n\nRun anyway? (auto-blocks when timer ends)`,
      { timeout: timeoutMs },
    );

    if (!ok) {
      ctx.ui.notify(`Danger guard: blocked (${hit.name})`, "warning");
      return { block: true, reason: `Blocked by danger guard (${hit.name})` };
    }
  });

  pi.registerCommand("danger-guard", {
    description: "Danger guard state; on|off|toggle to control",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim().toLowerCase();
      if (arg === "on") {
        enabled = true;
        ctx.ui.notify("Danger guard: ON", "info");
        return;
      }
      if (arg === "off") {
        enabled = false;
        ctx.ui.notify("Danger guard: OFF — destructive bash commands run unconfirmed", "warning");
        return;
      }
      if (arg === "toggle") {
        enabled = !enabled;
        ctx.ui.notify(`Danger guard: ${enabled ? "ON" : "OFF"}`, "info");
        return;
      }
      const lines = [`Danger guard: ${enabled ? "ON" : "OFF"} — ${patterns.length} patterns, confirm timeout ${Math.round(timeoutMs / 1000)}s`];
      for (const p of patterns) lines.push(`  • ${p.name}: ${p.re}`);
      lines.push("Usage: /danger-guard on|off|toggle");
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
