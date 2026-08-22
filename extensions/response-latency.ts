/**
 * Response Latency Indicator
 *
 * Shows time elapsed since user sent message. Color/icon changes with speed.
 * Thresholds are scaled for local AI inference (a 60s completion is still
 * normal; stalling starts at 120s):
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

      const status = ctx.ui.theme.fg(
        phase.color,
        `${phase.icon} ${formatTime(elapsed)} (${phase.label})`,
      );
      ctx.ui.setStatus("response-latency", status);
    };

    tick();
    updateTimer = setInterval(tick, 200);
  };

  const stopTracking = (ctx: any) => {
    if (messageStart) {
      const elapsed = Date.now() - messageStart;
      const phase = getPhase(elapsed);
      const status = ctx.ui.theme.fg(
        phase.color,
        `${phase.icon} ${formatTime(elapsed)} ✓`,
      );
      ctx.ui.setStatus("response-latency", status);
    }
    messageStart = 0;
    clearTimer();

    // Clear after brief delay so user sees final time.
    // The ctx may be stale by then (session reloaded) — a stale ctx.ui.setStatus
    // throws, so swallow it: the status bar of the new session owns its own state.
    setTimeout(() => {
      if (!messageStart) {
        try {
          ctx.ui.setStatus("response-latency", undefined);
        } catch {
          // stale ctx — nothing to clear
        }
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
