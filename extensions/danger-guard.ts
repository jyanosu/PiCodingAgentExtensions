/**
 * Danger Guard Extension
 *
 * Intercepts `bash` tool calls and asks for confirmation before running
 * destructive commands (rm -rf, git push --force, DROP TABLE, ...).
 * Also asks when a command navigates (cd/pushd) outside the working-dir tree.
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
 *   DANGER_GUARD_NAV        — "off" disables the cd-outside-working-dir check
 *                             (default on; the main /danger-guard toggle still
 *                             gates it)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { resolve as pathResolve, sep as pathSep } from "node:path";

export interface DangerPattern {
  name: string;
  re: RegExp;
}

/** Curated destructive-command patterns (bash + cmd/PowerShell + git + DB + disk). */
export const DEFAULT_PATTERNS: DangerPattern[] = [
  // rm with a recursive and/or force flag: rm -r, rm -f, rm -rf, rm -Rf,
  // plus GNU long flags: rm --recursive, rm --force
  {
    name: "rm -r/-f",
    re: /\brm\s+(?:-\w+\s+)*-\w*[rf]\w*(?:\s|$)|\brm\s+(?:\S+\s+)*--(?:recursive|force)\b/i,
  },
  // sudo (escalation)
  { name: "sudo", re: /\bsudo\b/i },
  // world-writable permissions
  { name: "chmod 777", re: /\bchmod\b.*\b777\b/i },
  // Windows: del /s|/f|/q, rd /s, rmdir /s
  { name: "del/rd /s", re: /\b(?:del|erase|rd|rmdir)\s+\/\w*[sfq]\w*/i },
  // Windows: format C:, diskpart
  { name: "format/diskpart", re: /\bformat\s+[a-z]:|\bdiskpart\b/i },
  // PowerShell: Remove-Item -Recurse, Clear-Disk, Format-Volume
  {
    name: "PowerShell remove/format",
    re: /\bremove-item\b.*-recurse\b|\bclear-disk\b|\bformat-volume\b/i,
  },
  // git: push --force / -f / --force-with-lease
  {
    name: "git push --force",
    re: /\bgit\s+push\b[\s\S]*?(\s-f\b|--force\b|--force-with-lease\b)/i,
  },
  // git: reset --hard
  { name: "git reset --hard", re: /\bgit\s+reset\s+--hard\b/i },
  // git: clean with -d (removes untracked files/dirs), e.g. git clean -fd
  { name: "git clean -d", re: /\bgit\s+clean\s+(?:-\w+\s+)*-\w*d\w*(?:\s|$)/i },
  // git: checkout -- (discards worktree changes)
  { name: "git checkout --", re: /\bgit\s+checkout\s+--\s/i },
  // git: branch -D (force delete branch) — case-sensitive, -d is the safe variant
  { name: "git branch -D", re: /\bgit\s+branch\s+-D\b/ },
  // DB: DROP / TRUNCATE
  {
    name: "DROP/TRUNCATE",
    re: /\bdrop\s+(?:table|database|schema|index)\b|\btruncate\s+table\b/i,
  },
  // low-level disk ops: mkfs.*, dd of=/dev/..., shred
  {
    name: "mkfs/dd/shred",
    re: /\bmkfs\b|\bdd\s+.*\bof=\/(?:dev|sd|nvme|hd)\b|\bshred\b/i,
  },
];

/** Return the first pattern matched by the command, or null. */
export function matchDangerousCommand(
  command: string,
  patterns: DangerPattern[],
): DangerPattern | null {
  for (const p of patterns) {
    if (p.re.test(command)) return p;
  }
  return null;
}

/**
 * Detect `cd`/`pushd` navigation that leaves the working-dir tree.
 *
 * Returns the resolved absolute path of the FIRST offending target (for the
 * confirm dialog), or null when every navigation stays in `cwd` or a
 * descendant of it. See docs/parent-dir-guard/spec.md.
 *
 * Rules:
 * - only `cd`/`pushd` at command position (string start, or after ; & | ( newline `)
 * - first argument up to ; & | ) newline/end; one pair of surrounding quotes stripped
 * - bare `cd` / `cd -` → home (shell default); empty quoted arg (`cd ""`) → "."
 * - leading `~`, `~/...`, `$HOME`, `${HOME}` (with optional `/<sub>`) expanded
 *   to homedir() — bash expands $HOME the same way
 * - a virtual cwd is tracked across the command, so `cd sub && cd ../..`
 *   resolves to the parent correctly
 * - flagged when the resolved target !== cwd and is not a descendant; the
 *   `cwd + sep` boundary keeps `/projects/xy` OUTSIDE `/projects/x` (sibling).
 *   When cwd is root itself ("/" or "C:\"), appending sep would match
 *   nothing, so the boundary is cwd — everything is a descendant, nothing flags
 */
export function findOutsideNavigation(
  command: string,
  cwd: string,
): string | null {
  const home = homedir();
  let virtualCwd = cwd;
  // Descendant boundary: `cwd + sep`, except when cwd is already root
  // ("/" or "C:\"), where appending sep ("//") would match no path.
  const boundary = cwd.endsWith(pathSep) ? cwd : cwd + pathSep;

  const tokenRe = /\b(?:cd|pushd)\b/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(command)) !== null) {
    if (!atCommandPosition(command, m.index)) continue;

    const raw = extractFirstArg(command.slice(m.index + m[0].length));
    let target = raw === null || raw === "-" ? "~" : raw;
    // Explicit home refs behave like ~ (bash expands $HOME / ${HOME}).
    if (target === "$HOME" || target === "${HOME}") target = "~";
    else if (target.startsWith("$HOME/") || target.startsWith("${HOME}/")) {
      target = "~" + target.slice(target.indexOf("/"));
    }
    if (target === "~") target = home;
    else if (target.startsWith("~/")) target = home + target.slice(1);

    virtualCwd = pathResolve(virtualCwd, target);
    if (virtualCwd !== cwd && !virtualCwd.startsWith(boundary)) {
      return virtualCwd;
    }
  }
  return null;
}

/** True when the char before `index` (ignoring spaces/tabs) starts a new
 *  command: string start, or one of ; & | ( newline \r backtick. */
function atCommandPosition(command: string, index: number): boolean {
  let i = index - 1;
  while (i >= 0 && (command[i] === " " || command[i] === "\t")) i--;
  if (i < 0) return true;
  const c = command[i];
  return (
    c === ";" ||
    c === "&" ||
    c === "|" ||
    c === "(" ||
    c === "\n" ||
    c === "\r" ||
    c === "`"
  );
}

/** First argument after a cd/pushd token: text up to ; & | ) newline/end,
 *  trimmed, with one pair of matching surrounding quotes stripped.
 *  Returns null when there is no argument (bare cd); "" becomes ".". */
function extractFirstArg(rest: string): string | null {
  let i = 0;
  while (i < rest.length && (rest[i] === " " || rest[i] === "\t")) i++;
  let j = i;
  while (j < rest.length && !";&|\n\r)".includes(rest[j])) j++;
  let arg = rest.slice(i, j).trim();
  if (arg === "") return null;
  if (
    arg.length >= 2 &&
    ((arg[0] === '"' && arg[arg.length - 1] === '"') ||
      (arg[0] === "'" && arg[arg.length - 1] === "'"))
  ) {
    arg = arg.slice(1, -1);
  }
  return arg === "" ? "." : arg;
}

/** Flag name for the working-dir navigation check (dialog + block reason). */
export const NAV_NAME = "cd outside working dir";

/**
 * Combined guard decision: regex patterns first (they take precedence — a
 * command matching both reports the pattern), then the cd-outside-working-dir
 * check. Pure, so handler order is unit-testable. `cwd` missing → nav check
 * skipped silently.
 */
export function matchGuard(
  command: string,
  patterns: DangerPattern[],
  cwd: string | undefined,
  navEnabled: boolean,
): { name: string; detail?: string } | null {
  const hit = matchDangerousCommand(command, patterns);
  if (hit) return { name: hit.name };
  if (navEnabled && typeof cwd === "string" && cwd) {
    const target = findOutsideNavigation(command, cwd);
    if (target) return { name: NAV_NAME, detail: target };
  }
  return null;
}

/** Build pattern list from DANGER_GUARD_PATTERNS (JSON array of regex strings) or defaults. */
export function loadPatterns(
  env: NodeJS.ProcessEnv = process.env,
): DangerPattern[] {
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

/** Nav check enabled from DANGER_GUARD_NAV (default on; only "off" disables). */
export function loadNavEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.DANGER_GUARD_NAV ?? "").toLowerCase() !== "off";
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

export default function (pi: ExtensionAPI) {
  let enabled = true;
  let navEnabled = loadNavEnabled();
  const patterns = loadPatterns();
  const timeoutMs = loadTimeoutMs();

  pi.on("session_start", async (_event, ctx) => {
    enabled = true; // safe default: guard is ON for every new session
    navEnabled = loadNavEnabled(); // fresh per session (env may differ)
    ctx.ui.notify(
      `Danger guard: ON (${patterns.length} patterns) — /danger-guard to toggle`,
      "info",
    );
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!enabled || event.toolName !== "bash") return;
    const command =
      typeof event.input?.command === "string" ? event.input.command : "";
    if (!command) return;

    // Patterns take precedence over the nav check (a command matching both
    // reports the pattern name — existing behavior unchanged).
    const hit = matchGuard(command, patterns, ctx.cwd, navEnabled);
    if (!hit) return;

    if (!ctx.hasUI) {
      // Non-interactive: no one to ask — block (safe default)
      return {
        block: true,
        reason: `Danger guard: blocked (${hit.name}) — no UI for confirmation`,
      };
    }

    const matched = hit.detail
      ? `Matched: ${hit.name} (→ ${hit.detail})\n\nCommand changes directory outside the working dir (${ctx.cwd}).`
      : `Matched: ${hit.name}`;
    const ok = await ctx.ui.confirm(
      "⚠️ Danger guard",
      `${matched}\n\n${truncate(command, 600)}\n\nRun anyway? (auto-blocks when timer ends)`,
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
        ctx.ui.notify(
          "Danger guard: OFF — destructive bash commands run unconfirmed",
          "warning",
        );
        return;
      }
      if (arg === "toggle") {
        enabled = !enabled;
        ctx.ui.notify(`Danger guard: ${enabled ? "ON" : "OFF"}`, "info");
        return;
      }
      const lines = [
        `Danger guard: ${enabled ? "ON" : "OFF"} — ${patterns.length} patterns, confirm timeout ${Math.round(timeoutMs / 1000)}s, cd-outside check ${navEnabled ? "ON" : "OFF"}`,
      ];
      for (const p of patterns) lines.push(`  • ${p.name}: ${p.re}`);
      lines.push(
        navEnabled
          ? `  • ${NAV_NAME}: cd/pushd leaving the working-dir tree asks`
          : `  • ${NAV_NAME}: OFF (DANGER_GUARD_NAV=off)`,
      );
      lines.push("Usage: /danger-guard on|off|toggle");
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
