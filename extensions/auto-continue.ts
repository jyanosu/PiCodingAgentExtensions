import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Auto-Continue Extension
 *
 * Detects when the assistant outputs raw tool-call XML that Pi failed to parse
 * (stale <function=...> blocks displayed as text instead of executed), and
 * automatically sends "continue" so the model retries.
 *
 * Toggle with /autocontinue (on by default).
 */

const STATE_KEY = "auto-continue:enabled";

// Patterns that look like raw/unexecuted tool-call XML
const RAW_TOOL_CALL_PATTERNS = [
  /<function\s*=/i,           // <function=bash ...>
  /<\/function>/i,            // closing tag without execution
  /<tool_use\s*name/i,       // Anthropic-style raw
  /<antThinking>/i,          // leaked thinking block as text
];

export default function (pi: ExtensionAPI) {
  let enabled = true;

  pi.on("session_start", (_event, ctx) => {
    // Restore state if available
    const entries = ctx.sessionManager.getEntries();
    const last = entries.find(e => e.customType === "auto-continue-state");
    if (last && typeof (last as any).content === "string") {
      enabled = (last as any).content === "on";
    }
  });

  pi.on("message_end", async (event, ctx) => {
    if (!enabled || event.message.role !== "assistant") return;

    const text = extractTextContent(event.message);
    if (!text) return;

    // Check for raw tool-call XML in the output
    const hasRawToolCall = RAW_TOOL_CALL_PATTERNS.some(p => p.test(text));
    if (!hasRawToolCall) return;

    // Make sure no tools were actually executed this turn (otherwise it's just text about XML)
    const toolCallMentions = (text.match(/<function\s*=/gi) || []).length;
    const closingTags = (text.match(/<\/function>/gi) || []).length;

    // Only auto-continue if there are balanced tags (looks like a real unexecuted call)
    if (toolCallMentions === 0 || Math.abs(toolCallMentions - closingTags) > 1) return;

    // Small delay so the TUI renders first, then auto-send continue
    setTimeout(() => {
      if (enabled && ctx.isIdle()) {
        pi.sendUserMessage("continue", { deliverAs: "followUp" });
        ctx.ui.notify("auto-continue: detected raw tool call, resuming...", "info");
      }
    }, 800);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    // Persist state
    ctx.sessionManager.appendEntry({
      role: "system" as any,
      customType: "auto-continue-state",
      content: enabled ? "on" : "off",
      timestamp: Date.now(),
    });
  });

  // Toggle command
  pi.registerCommand("autocontinue", {
    description: "Toggle auto-continue for raw tool-call XML",
    handler: async (_args, ctx) => {
      enabled = !enabled;
      ctx.ui.notify(`auto-continue: ${enabled ? "ON" : "OFF"}`, enabled ? "info" : "warn");
    },
  });
}

function extractTextContent(message: any): string | null {
  if (!message.content || !Array.isArray(message.content)) return null;
  const textParts = message.content
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text);
  return textParts.length > 0 ? textParts.join("\n") : null;
}
