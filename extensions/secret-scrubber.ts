/**
 * Secret Scrubber Extension
 *
 * Complements danger-guard: where danger-guard blocks *destructive* commands,
 * the scrubber stops *leaks*. Scans outgoing tool calls for well-known secret
 * shapes (API keys, tokens, private key blocks) and asks for confirmation
 * before the call proceeds. Without a UI (non-interactive mode) matches are
 * blocked outright.
 *
 * Scanned tools:
 *   bash  — the full command string
 *   write — the file content
 *   edit  — every edits[].newText
 *
 * Matched secrets are never echoed back: confirm/notify show the pattern name
 * plus a masked value (first4…last4).
 *
 * Commands:
 *   /secret-scrubber         — show state + active patterns
 *   /secret-scrubber on|off  — enable/disable (in-memory, defaults ON each session)
 *   /secret-scrubber toggle
 *
 * Config (environment variables):
 *   SECRET_SCRUBBER_PATTERNS   — JSON array of regex strings, replaces defaults
 *                                e.g. ["\\bMYKEY_[A-Za-z0-9]{16}"]
 *   SECRET_SCRUBBER_TIMEOUT_MS — confirm dialog timeout in ms (default 120000);
 *                                timeout = block (safe default)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface SecretPattern {
  name: string;
  re: RegExp;
}

/**
 * Curated secret shapes. Prefix-based on purpose — generic entropy checks
 * false-positive too often (hashes, commit SHAs, base64 chunks). Order
 * matters: specific vendors before the generic OpenAI `sk-` pattern.
 */
export const DEFAULT_SECRET_PATTERNS: SecretPattern[] = [
  { name: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  // sk-proj- is the standard format for new OpenAI keys; the generic sk-
  // pattern below cannot match it (the second dash breaks the char class)
  { name: "OpenAI project key", re: /\bsk-proj-[A-Za-z0-9_-]{20,}/ },
  { name: "OpenAI API key", re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: "Stripe live key", re: /\b(?:sk|rk)_live_[A-Za-z0-9]{10,}/ },
  { name: "GitHub PAT (classic)", re: /\bghp_[A-Za-z0-9]{30,}\b/ },
  { name: "GitHub PAT (fine-grained)", re: /\bgithub_pat_[A-Za-z0-9_]{30,}/ },
  { name: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "HuggingFace token", re: /\bhf_[A-Za-z0-9]{30,}/ },
  { name: "Telegram bot token", re: /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}\b/ },
  {
    name: "Private key block",
    re: /-----BEGIN[ A-Z]*PRIVATE KEY-----/,
  },
];

/** First pattern matched by the text, with the matched substring, or null. */
export function matchSecret(
  text: string,
  patterns: SecretPattern[],
): { name: string; match: string } | null {
  if (!text) return null;
  for (const p of patterns) {
    const m = p.re.exec(text);
    if (m) return { name: p.name, match: m[0] };
  }
  return null;
}

/** Mask a secret for display: first4…last4 (or **** when too short). */
export function maskSecret(s: string): string {
  if (s.length <= 8) return "****";
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

/**
 * The text a tool call would expose, or null when the tool is not scanned.
 * bash → command; write → content; edit → all newText values.
 */
export function extractScannableText(
  toolName: string,
  input: unknown,
): string | null {
  if (!input || typeof input !== "object") return null;
  const inp = input as Record<string, unknown>;
  switch (toolName) {
    case "bash":
      return typeof inp.command === "string" ? inp.command : null;
    case "write":
      return typeof inp.content === "string" ? inp.content : null;
    case "edit": {
      const edits = inp.edits;
      if (!Array.isArray(edits)) return null;
      const parts: string[] = [];
      for (const e of edits) {
        const newText =
          e && typeof e === "object"
            ? (e as { newText?: unknown }).newText
            : undefined;
        if (typeof newText === "string") parts.push(newText);
      }
      return parts.length > 0 ? parts.join("\n") : null;
    }
    default:
      return null;
  }
}

/** Pattern list from SECRET_SCRUBBER_PATTERNS (JSON array of regex strings) or defaults. */
export function loadPatterns(
  env: NodeJS.ProcessEnv = process.env,
): SecretPattern[] {
  const raw = env.SECRET_SCRUBBER_PATTERNS;
  if (!raw) return DEFAULT_SECRET_PATTERNS;
  try {
    const list = JSON.parse(raw);
    if (!Array.isArray(list) || list.length === 0)
      return DEFAULT_SECRET_PATTERNS;
    const patterns: SecretPattern[] = [];
    for (const item of list) {
      if (typeof item !== "string" || !item) continue;
      try {
        patterns.push({
          name: `custom (${item.slice(0, 40)})`,
          re: new RegExp(item),
        });
      } catch {
        // skip invalid regexes
      }
    }
    return patterns.length > 0 ? patterns : DEFAULT_SECRET_PATTERNS;
  } catch {
    return DEFAULT_SECRET_PATTERNS;
  }
}

/** Confirm timeout in ms from SECRET_SCRUBBER_TIMEOUT_MS (default 120000, clamped 1000..600000). */
export function loadTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = parseInt(env.SECRET_SCRUBBER_TIMEOUT_MS ?? "", 10);
  if (isNaN(n)) return 120000;
  return Math.min(600000, Math.max(1000, n));
}

export default function (pi: ExtensionAPI) {
  let enabled = true;
  const patterns = loadPatterns();
  const timeoutMs = loadTimeoutMs();

  pi.on("session_start", async (_event, ctx) => {
    enabled = true; // safe default: scrubber is ON for every new session
    ctx.ui.notify(
      `Secret scrubber: ON (${patterns.length} patterns) — /secret-scrubber to toggle`,
      "info",
    );
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!enabled) return;
    const text = extractScannableText(event.toolName, event.input);
    if (!text) return;

    const hit = matchSecret(text, patterns);
    if (!hit) return;

    if (!ctx.hasUI) {
      // Non-interactive: no one to ask — block (safe default)
      return {
        block: true,
        reason: `Secret scrubber: blocked (${hit.name}) — no UI for confirmation`,
      };
    }

    const ok = await ctx.ui.confirm(
      "🔒 Secret scrubber",
      `${event.toolName} call contains what looks like a ${hit.name} (${maskSecret(hit.match)}).\n\nProceed anyway? (auto-blocks when timer ends)`,
      { timeout: timeoutMs },
    );

    if (!ok) {
      ctx.ui.notify(`Secret scrubber: blocked (${hit.name})`, "warning");
      return {
        block: true,
        reason: `Blocked by secret scrubber (${hit.name})`,
      };
    }
  });

  pi.registerCommand("secret-scrubber", {
    description: "Secret scrubber state; on|off|toggle to control",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim().toLowerCase();
      if (arg === "on") {
        enabled = true;
        ctx.ui.notify("Secret scrubber: ON", "info");
        return;
      }
      if (arg === "off") {
        enabled = false;
        ctx.ui.notify(
          "Secret scrubber: OFF — tool calls with suspected secrets run unconfirmed",
          "warning",
        );
        return;
      }
      if (arg === "toggle") {
        enabled = !enabled;
        ctx.ui.notify(`Secret scrubber: ${enabled ? "ON" : "OFF"}`, "info");
        return;
      }
      const lines = [
        `Secret scrubber: ${enabled ? "ON" : "OFF"} — ${patterns.length} patterns, confirm timeout ${Math.round(timeoutMs / 1000)}s`,
      ];
      for (const p of patterns) lines.push(`  • ${p.name}: ${p.re}`);
      lines.push("Usage: /secret-scrubber on|off|toggle");
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
