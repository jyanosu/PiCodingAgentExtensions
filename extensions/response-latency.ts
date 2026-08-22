/**
 * Response Latency Indicator
 *
 * Shows two timings in the status bar, separated by " | ":
 *
 *   ⚡ response latency — the wait from when a model request is dispatched
 *   (prompt sent, or tool results handed back) until the response starts
 *   coming back (first assistant message). Each model call in a turn is
 *   measured separately; the value freezes with a ✓ when it arrives.
 *
 *   ◷ whole-turn timer — total time for the current turn (prompt through
 *   agent_end, including tool execution and streaming). A plain stopwatch:
 *   no phase coloring, since a long tool-heavy turn is normal.
 *
 * Example: `⚡ 1.2s ✓ | ◷ 2m05s`
 *
 * The frozen values stay in the status bar until the next prompt is sent
 * (a new agent_start replaces them with live timing).
 *
 * Response-latency phases are scaled for local AI inference (a 60s response
 * is still normal; stalling starts at 120s):
 *   < 30s    green  ⚡ fast
 *   30-60s   yellow ◉ normal
 *   60-120s  orange ◈ slow
 *   > 120s   red    ✖ stalling
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface LatencyPhase {
  icon: string;
  color: string;
  label: string;
}

export function getPhase(ms: number): LatencyPhase {
  if (ms < 30_000) return { icon: "⚡", color: "success", label: "fast" };
  if (ms < 60_000) return { icon: "◉", color: "warning", label: "normal" };
  if (ms < 120_000) return { icon: "◈", color: "warning", label: "slow" };
  return { icon: "✖", color: "error", label: "stalling" };
}

export function formatTime(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m${String(s).padStart(2, "0")}s`;
}

export default function (pi: ExtensionAPI) {
  let turnStart = 0; // when the current turn began (whole-turn stopwatch)
  let waitStart = 0; // when the current model request was dispatched
  let lastTtft = 0; // last completed response latency (shown frozen with ✓)
  let lastTurn = 0; // completed turn duration (shown frozen for ~2s)
  let updateTimer: ReturnType<typeof setInterval> | null = null;

  const clearTimer = () => {
    if (updateTimer) {
      clearInterval(updateTimer);
      updateTimer = null;
    }
  };

  /** Render the combined status; undefined (clears) when nothing is active. */
  const render = (ctx: any) => {
    const parts: string[] = [];
    if (waitStart > 0) {
      const e = Date.now() - waitStart;
      const p = getPhase(e);
      parts.push(ctx.ui.theme.fg(p.color, `${p.icon} ${formatTime(e)}`));
    } else if (lastTtft > 0) {
      const p = getPhase(lastTtft);
      parts.push(
        ctx.ui.theme.fg(p.color, `${p.icon} ${formatTime(lastTtft)} ✓`),
      );
    }
    if (turnStart > 0) {
      parts.push(
        ctx.ui.theme.fg("dim", `◷ ${formatTime(Date.now() - turnStart)}`),
      );
    } else if (lastTurn > 0) {
      parts.push(ctx.ui.theme.fg("dim", `◷ ${formatTime(lastTurn)} ✓`));
    }
    ctx.ui.setStatus(
      "response-latency",
      parts.length > 0
        ? parts.join(ctx.ui.theme.fg("muted", " | "))
        : undefined,
    );
  };

  const startTimer = (ctx: any) => {
    clearTimer();
    const tick = () => {
      if (!turnStart) return;
      try {
        render(ctx);
      } catch {
        // stale ctx (session reloaded mid-turn) — stop, new session owns status
        turnStart = 0;
        waitStart = 0;
        lastTtft = 0;
        lastTurn = 0;
        clearTimer();
      }
    };
    tick();
    updateTimer = setInterval(tick, 200);
  };

  // Turn begins → start the stopwatch and time the first model call
  pi.on("agent_start", async (_event, ctx) => {
    lastTtft = 0;
    lastTurn = 0;
    turnStart = Date.now();
    waitStart = Date.now();
    startTimer(ctx);
  });

  // Response started coming back → freeze the response latency for this call
  pi.on("message_start", async (event, ctx) => {
    if (event.message.role !== "assistant" || !waitStart) return;
    lastTtft = Date.now() - waitStart;
    waitStart = 0;
    try {
      render(ctx);
    } catch {
      // stale ctx — the tick will stop itself
    }
  });

  // Tools finished → the agent dispatches the next model call with results.
  // Parallel tools: the last end event wins ≈ when the call goes out.
  pi.on("tool_execution_end", async (_event, ctx) => {
    if (turnStart && !waitStart) {
      waitStart = Date.now();
      try {
        render(ctx);
      } catch {
        // stale ctx — the tick will stop itself
      }
    }
  });

  // Turn over → freeze both values, show for a couple of seconds, then clear
  pi.on("agent_end", async (_event, ctx) => {
    if (!turnStart) return;
    lastTurn = Date.now() - turnStart;
    turnStart = 0;
    waitStart = 0; // a call still pending at turn end never got a response
    clearTimer();
    try {
      // Frozen values stay visible until the next prompt (agent_start resets)
      render(ctx);
    } catch {
      // stale ctx — nothing to show
    }
  });

  pi.on("session_shutdown", () => {
    clearTimer();
    turnStart = 0;
    waitStart = 0;
    lastTtft = 0;
    lastTurn = 0;
  });
}
