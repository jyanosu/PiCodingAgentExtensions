/**
 * Custom Compaction Model Extension
 *
 * Uses a separate (cheaper/faster) model for context compaction.
 * Default: Gemini 2.5 Flash — change MODEL_PROVIDER + MODEL_NAME below.
 */

import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

// ── Change these to pick your compaction model ──────────────────────
const MODEL_PROVIDER = "llama-cpp";
const MODEL_NAME     = "Qwen3.5-8B";
// ────────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.on("session_before_compact", async (event, ctx) => {
    const { preparation, signal } = event;
    const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, previousSummary } = preparation;

    // Find model in registry
    const model = ctx.modelRegistry.find(MODEL_PROVIDER, MODEL_NAME);
    if (!model) {
      ctx.ui.notify(`Compaction model ${MODEL_PROVIDER}/${MODEL_NAME} not found — using default`, "warning");
      return;
    }

    // Resolve auth
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) {
      ctx.ui.notify(`Compaction auth failed for ${model.id}: ${auth.error ?? 'no API key'} — using default`, "warning");
      return;
    }

    // Combine all messages
    const allMessages = [...messagesToSummarize, ...turnPrefixMessages];

    ctx.ui.notify(
      `Compacting ${allMessages.length} msgs (${tokensBefore.toLocaleString()} tokens) with ${model.id}`,
      "info",
    );

    // Serialize to text
    const conversationText = serializeConversation(convertToLlm(allMessages));
    const prevContext = previousSummary ? `\n\nPrevious summary:\n${previousSummary}` : "";

    const summaryMessages = [
      {
        role: "user" as const,
        content: [
          {
            type: "text" as const,
            text: `You are a conversation summarizer. Create a structured summary of this conversation:${prevContext}

1. Main goals and objectives
2. Key decisions + rationale
3. Important code changes / file modifications
4. Current state of ongoing work
5. Blockers or open questions
6. Planned next steps

Be thorough but concise. This replaces the full history, so include everything needed to continue.

Format as structured markdown with clear sections.

<conversation>
${conversationText}
</conversation>`,
          },
        ],
        timestamp: Date.now(),
      },
    ];

    try {
      const response = await complete(model, { messages: summaryMessages }, {
        apiKey: auth.apiKey,
        headers: auth.headers,
        env: auth.env,
        maxTokens: 8192,
        signal,
      });

      const summary = response.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n");

      if (!summary.trim()) {
        if (!signal.aborted) ctx.ui.notify("Empty summary — using default compaction", "warning");
        return;
      }

      return { compaction: { summary, firstKeptEntryId, tokensBefore, usage: response.usage } };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Compaction failed: ${msg} — using default`, "error");
      return;
    }
  });
}
