/**
 * Compaction Model Extension
 *
 * Uses a separate, smaller model for session compaction and branch summarization.
 * Configured via environment variables pointing to a litellm endpoint.
 *
 * Environment variables:
 *   COMPACTION_MODEL_PROVIDER  - Provider ID (default: "litellm")
 *   COMPACTION_MODEL_ID        - Model name (default: "Qwen3.5-8B")
 *   COMPACTION_MODEL_BASE_URL  - litellm base URL (e.g. "http://localhost:4000/v1")
 *   COMPACTION_MODEL_API_KEY   - API key (optional)
 *   COMPACTION_MODEL_MAX_TOKENS - Max tokens for summary (default: 8192)
 */

import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { uuidv7 } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  convertToLlm,
  serializeConversation,
} from "@earendil-works/pi-coding-agent";

// {{PREVIOUS_SUMMARY}} is replaced with prior-summary context (or "") — placeholder
// keeps prompt assembly deterministic instead of string-matching prompt text.
const SUMMARY_PROMPT = `You are a conversation summarizer.{{PREVIOUS_SUMMARY}} Create a comprehensive summary of this conversation that captures:

1. The main goals and objectives discussed
2. Key decisions made and their rationale
3. Important code changes, file modifications, or technical details
4. Current state of any ongoing work
5. Any blockers, issues, or open questions
6. Next steps that were planned or suggested

Be thorough but concise. Include all information needed to continue the work effectively.

Format the summary as structured markdown with clear sections using this exact format:

## Goal
[What the user is trying to accomplish]

## Constraints & Preferences
- [Requirements mentioned by user]

## Progress
### Done
- [x] [Completed tasks]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues, if any]

## Key Decisions
- **[Decision]**: [Rationale]

## Next Steps
1. [What should happen next]

## Critical Context
- [Data needed to continue]

<read-files>
[files read during session]
</read-files>

<modified-files>
[files modified during session]
</modified-files>

<conversation>
{{CONVERSATION}}
</conversation>`;

interface CompactionConfig {
  provider: string;
  modelId: string;
  baseUrl: string;
  apiKey?: string;
  maxTokens: number;
}

/** Max summary tokens from env (default 8192). */
function parseMaxTokens(): number {
  const n = parseInt(process.env.COMPACTION_MODEL_MAX_TOKENS || "8192", 10);
  return isNaN(n) || n <= 0 ? 8192 : n;
}

function loadConfig(): CompactionConfig {
  // Read from env vars first, then fall back to models.json
  const baseUrl = process.env.COMPACTION_MODEL_BASE_URL;
  if (baseUrl) {
    return {
      provider: process.env.COMPACTION_MODEL_PROVIDER || "litellm",
      modelId: process.env.COMPACTION_MODEL_ID || "Qwen3.5-8B",
      baseUrl,
      apiKey: process.env.COMPACTION_MODEL_API_KEY || undefined,
      maxTokens: parseMaxTokens(),
    };
  }

  // Fall back to reading models.json for the litellm endpoint
  try {
    const configDir =
      process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
    const modelsPath = join(configDir, "models.json");
    const models = JSON.parse(readFileSync(modelsPath, "utf8")) as {
      providers?: Record<string, { baseUrl?: string; apiKey?: string }>;
    };
    // Prefer the provider literally named "litellm", else the first one.
    const providers = models.providers ?? {};
    const litellmProvider = providers["litellm"] ?? Object.values(providers)[0];

    if (litellmProvider && litellmProvider.baseUrl) {
      return {
        provider: "litellm",
        modelId: process.env.COMPACTION_MODEL_ID || "Qwen3.5-8B",
        baseUrl: litellmProvider.baseUrl,
        apiKey: litellmProvider.apiKey || undefined,
        maxTokens: parseMaxTokens(),
      };
    }
  } catch {
    // Fall through to warning
  }

  return {
    provider: "litellm",
    modelId: "Qwen3.5-8B",
    baseUrl: "",
    maxTokens: 8192,
  };
}

export default async function (pi: ExtensionAPI) {
  const config = loadConfig();

  if (!config.baseUrl) {
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.notify(
        "compaction-model: COMPACTION_MODEL_BASE_URL not set — using default compaction",
        "warning",
      );
    });
    return;
  }

  // Register the litellm provider dynamically
  pi.registerProvider(config.provider, {
    baseUrl: config.baseUrl,
    apiKey: config.apiKey || "",
    api: "openai-completions",
    models: [
      {
        id: config.modelId,
        name: config.modelId,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: config.maxTokens,
      },
    ],
  });

  // Shared summarization logic
  const summarize = async (
    messagesToSummarize: readonly unknown[],
    turnPrefixMessages: readonly unknown[] | undefined,
    previousSummary: string | undefined,
    signal: AbortSignal | undefined,
    ctx: any,
  ) => {
    const model = ctx.modelRegistry.find(config.provider, config.modelId);
    if (!model) {
      throw new Error(`Model ${config.provider}/${config.modelId} not found`);
    }

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) throw new Error(`Auth failed: ${auth.error}`);

    const allMessages = [...messagesToSummarize, ...(turnPrefixMessages || [])];
    const conversationText = serializeConversation(
      convertToLlm(allMessages as any),
    );

    const previousContext = previousSummary
      ? `\n\nPrevious session summary for context:\n${previousSummary}`
      : "";

    const prompt = SUMMARY_PROMPT.replace(
      "{{CONVERSATION}}",
      conversationText,
    ).replace("{{PREVIOUS_SUMMARY}}", previousContext);

    const summaryMessages = [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: prompt }],
        timestamp: Date.now(),
      },
    ];

    return await complete(
      model,
      { messages: summaryMessages },
      {
        apiKey: auth.apiKey || undefined,
        headers: auth.headers,
        env: auth.env,
        maxTokens: config.maxTokens,
        signal,
        cacheRetention: "none",
        sessionId: uuidv7(),
      },
    );
  };

  pi.on("session_before_compact", async (event, ctx) => {
    const { preparation, signal } = event;
    const {
      messagesToSummarize,
      turnPrefixMessages,
      tokensBefore,
      firstKeptEntryId,
      previousSummary,
    } = preparation;

    const allCount =
      messagesToSummarize.length + (turnPrefixMessages?.length || 0);
    ctx.ui.notify(
      `Compacting ${allCount} msgs (${tokensBefore.toLocaleString()} tok) with ${config.modelId}...`,
      "info",
    );

    try {
      const response = await summarize(
        messagesToSummarize,
        turnPrefixMessages,
        previousSummary,
        signal,
        ctx,
      );

      const summary = response.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n");

      if (!summary.trim()) {
        if (!signal?.aborted) {
          ctx.ui.notify(
            "Summary was empty, using default compaction",
            "warning",
          );
        }
        return;
      }

      return {
        compaction: {
          summary,
          firstKeptEntryId,
          tokensBefore,
          usage: response.usage,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!signal?.aborted) {
        ctx.ui.notify(`Compaction failed: ${message}, using default`, "error");
      }
      return;
    }
  });

  pi.on("session_before_tree", async (event, ctx) => {
    const { preparation, signal } = event;

    if (!preparation.userWantsSummary) return;

    const count = preparation.entriesToSummarize.length;
    ctx.ui.notify(
      `Branch summary (${count} entries) with ${config.modelId}...`,
      "info",
    );

    try {
      // Convert branch entries to messages for summarization
      const conversationText = serializeConversation(
        convertToLlm(preparation.entriesToSummarize as any),
      );

      const prompt = `You are a conversation summarizer. Summarize this abandoned branch of conversation.

Format the summary using this exact structure:

## Goal
[What was being worked on in this branch]

## Progress
### Done
- [x] [Completed work]

## Key Decisions
- **[Decision]**: [Rationale]

## Critical Context
- [Data needed if returning to this branch]

<conversation>
${conversationText}
</conversation>`;

      const model = ctx.modelRegistry.find(config.provider, config.modelId);
      if (!model)
        throw new Error(`Model ${config.provider}/${config.modelId} not found`);

      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) throw new Error(`Auth failed: ${auth.error}`);

      const summaryMessages = [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: prompt }],
          timestamp: Date.now(),
        },
      ];

      const response = await complete(
        model,
        { messages: summaryMessages },
        {
          apiKey: auth.apiKey || undefined,
          headers: auth.headers,
          env: auth.env,
          maxTokens: config.maxTokens,
          signal,
          cacheRetention: "none",
          sessionId: uuidv7(),
        },
      );

      const summary = response.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n");

      if (!summary.trim()) {
        if (!signal?.aborted) {
          ctx.ui.notify("Branch summary was empty", "warning");
        }
        return;
      }

      return {
        summary: {
          summary,
          usage: response.usage,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!signal?.aborted) {
        ctx.ui.notify(`Branch summary failed: ${message}`, "error");
      }
      return;
    }
  });
}
