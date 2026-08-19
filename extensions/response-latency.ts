/**
 * Response Latency Indicator
 *
 * Shows time elapsed since user sent message. Color/icon changes with speed:
 *   < 2s    green  ⚡ fast
 *   2-5s    yellow ◉ normal
 *   5-10s   orange ◈ slow
 *   > 10s   red    ✖ timeout-risk
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface LatencyPhase {
  icon: string;
  color: string;
  label: string;
}

function getPhase(ms: number): LatencyPhase {
  if (ms < 2000) return { icon: "⚡", color: "success", label: "fast" };
  if (ms < 5000) return { icon: "◉", color: "warning", label: "normal" };
  if (ms < 10_000) return { icon: "◈", color: "warning", label: "slow" };
  return { icon: "✖", color: "error", label: "stalling" };
}

function formatTime(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = (ms / 1000).toFixed(1);
  return `${sec}s`;
}

export default function (pi: ExtensionAPI) {
  let messageStart = 0;
  let updateTimer: ReturnType<typeof setInterval> | null = null;

  const clearTimer = () => {
    if (updateTimer) {
      clearInterval(updateTimer);
      updateTimer = null;
    }
  };

  const startTracking = (ctx: any) => {
    messageStart = Date.now();
    clearTimer();

    const tick = () => {
      if (!messageStart) return;
      const elapsed = Date.now() - messageStart;
      const phase = getPhase(elapsed);

      const status = ctx.ui.theme.fg(phase.color, `${phase.icon} ${formatTime(elapsed)} (${phase.label})`);
      ctx.ui.setStatus("response-latency", status);
    };

    tick();
    updateTimer = setInterval(tick, 200);
  };

  const stopTracking = (ctx: any) => {
    if (messageStart) {
      const elapsed = Date.now() - messageStart;
      const phase = getPhase(elapsed);
      const status = ctx.ui.theme.fg(phase.color, `${phase.icon} ${formatTime(elapsed)} ✓`);
      ctx.ui.setStatus("response-latency", status);
    }
    messageStart = 0;
    clearTimer();

    // Clear after brief delay so user sees final time
    setTimeout(() => {
      if (!messageStart) {
        ctx.ui.setStatus("response-latency", undefined);
      }
    }, 2000);
  };

  pi.on("agent_start", async (_event, ctx) => {
    startTracking(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    stopTracking(ctx);
  });

  pi.on("session_shutdown", () => {
    clearTimer();
    messageStart = 0;
  });
}
