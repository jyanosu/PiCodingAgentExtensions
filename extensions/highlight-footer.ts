import { spawn } from "child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
/**
 * Run a git command asynchronously and return lines of output, or null on failure.
 */
function gitLines(args: string[], cwd: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.on("close", (code) => {
      if (code !== 0) return resolve(null);
      const trimmed = output.trim();
      resolve(trimmed ? trimmed.split("\n") : []);
    });
    child.on("error", () => resolve(null));
  });
}

/**
 * Two-line footer:
 *   Line 1: project / branch [staged] [unstaged]
 *   Line 2: model • context usage (dim, left-aligned)
 */
export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    const project = ctx.cwd.split("/").filter(Boolean).pop() || "";
    const REFRESH_INTERVAL = 5000;

    // TUI handle captured from setFooter so the timer can request re-renders.
    let tuiHandle: any;

    // Voice input state — checked via footerData.status
    // Cached git data — updated on a timer, never during render.
    let staged = 0;
    let unstaged = 0;
    let added = 0;
    let modified = 0;
    let deleted = 0;
    let lastCommit: string | null = null;
    let branch: string | null = null;
    let unpushed = 0;

    // Track whether Pi is actively working — skip git refresh during streaming.
    let activeToolCount = 0;
    let isStreaming = false;
    let timerId: ReturnType<typeof setInterval> | undefined;
    let isDisposed = false;

    /** Fetch git data asynchronously and update cache. Skips if Pi is actively working. */
    async function fetchGitData() {
      if (isStreaming || activeToolCount > 0 || isDisposed) return;
      let cwd: string;
      try {
        // Force ctx staleness check — throws if ctx stale after reload
        cwd = ctx.cwd;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("stale") || msg.includes("replaced")) {
          clearInterval(timerId);
          isDisposed = true;
          return;
        }
        throw err;
      }
      try {
        const [stagedResult, unstagedResult, porcelains, commitResult, branchResult, unpushedResult] = await Promise.all([
          gitLines(["--no-optional-locks", "diff", "--name-only", "--cached"], cwd),
          gitLines(["--no-optional-locks", "diff", "--name-only"], cwd),
          gitLines(["--no-optional-locks", "status", "--porcelain"], cwd),
          gitLines(["--no-optional-locks", "log", "-1", "--format=%s"], cwd),
          gitLines(["--no-optional-locks", "branch", "--show-current"], cwd),
          gitLines(["rev-list", "--count", "HEAD..@{u}"], cwd),
        ]);

        const newStaged = stagedResult?.length ?? 0;
        const newUnstaged = unstagedResult?.length ?? 0;
        const newBranch = branchResult?.[0] || null;
        const newUnpushed = parseInt(unpushedResult?.[0] ?? "", 10) || 0;

        // Parse working tree from porcelain output.
        // Format: XY PATH — X = index status, Y = worktree status.
        const lines = porcelains || [];
        let newAdded = 0, newModified = 0, newDeleted = 0;
        for (const line of lines) {
          const x = line[0];
          const y = line[1];
          if (x === "?" || x === "A") newAdded++;
          else if (y === "M") newModified++;
          else if (y === "D") newDeleted++;
        }

        const commit = commitResult?.[0] || null;

        // Only mark dirty if values actually changed (triggers re-render).
        const changed = staged !== newStaged || unstaged !== newUnstaged ||
          added !== newAdded || modified !== newModified || deleted !== newDeleted ||
          lastCommit !== commit || branch !== newBranch || unpushed !== newUnpushed;

        staged = newStaged;
        unstaged = newUnstaged;
        added = newAdded;
        modified = newModified;
        deleted = newDeleted;
        lastCommit = commit;
        branch = newBranch;
        unpushed = newUnpushed;

        if (changed && tuiHandle) {
          try { tuiHandle.requestRender(); } catch {} // ignore stale tui
        }
      } catch (err: unknown) {
        // ctx stale after reload — kill timer silently
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("stale") || msg.includes("replaced")) {
          clearInterval(timerId);
          isDisposed = true;
          return;
        }
        throw err;
      }
    }

    fetchGitData();
    timerId = setInterval(fetchGitData, REFRESH_INTERVAL);

    // Pause git refresh while Pi is streaming or running tools.
    pi.on("message_start", async (event) => {
      if (event.message.role === "assistant") isStreaming = true;
    });
    pi.on("message_end", async (event) => {
      if (event.message.role === "assistant") isStreaming = false;
    });
    pi.on("tool_execution_start", async () => { activeToolCount++; });
    pi.on("tool_execution_end", async (_event) => {
      activeToolCount = Math.max(0, activeToolCount - 1);
      if (activeToolCount === 0) fetchGitData();
    });

    const formatTokens = (count: number): string => {
      if (count < 1000) return count.toString();
      if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
      if (count < 1000000) return `${Math.round(count / 1000)}k`;
      return `${(count / 1000000).toFixed(1)}M`;
    };

    // Defensive: clear a leftover "token-budget" widget if the separate
    // token-budget extension (not in this repo) was ever enabled.
    ctx.ui.setWidget("token-budget", undefined);

    ctx.ui.setFooter((tui, theme, footerData) => {
      tuiHandle = tui;
      const render = (width: number): string[] => {
        // Left: voice indicator + project / branch [staged] [unstaged]
        // Status set by voice-input extension: ready | recording | transcribing
        const voiceStatus = footerData.getExtensionStatuses().get("voice");
        let voiceIcon = "";
        if (voiceStatus === "recording") voiceIcon = "\x1b[31m🔴\x1b[0m";
        else if (voiceStatus === "transcribing") voiceIcon = "\x1b[33m⏳\x1b[0m";
        else if (voiceStatus === "ready") voiceIcon = "\x1b[32m🎙\x1b[0m";
        const voiceSpacer = voiceIcon ? " " : "";
        let left = voiceIcon + voiceSpacer + (branch
          ? theme.fg("accent", theme.bold(project)) + theme.fg("muted", " / ") + theme.fg("accent", theme.bold(branch))
          : theme.fg("accent", project));

        // Status info (read from cache — no I/O here).
        if (branch) {
          const treeParts: string[] = [];
          if (added > 0) treeParts.push(theme.fg("success", `+${added}`));
          if (modified > 0) treeParts.push(theme.fg("warning", `~${modified}`));
          if (deleted > 0) treeParts.push(theme.fg("error", `-${deleted}`));
          if (staged > 0) treeParts.push(theme.fg("accent", `[S:${staged}]`));
          if (unstaged > 0) treeParts.push(theme.fg("warning", `[U:${unstaged}]`));
          if (unpushed > 0) treeParts.push(theme.fg("muted", `↑${unpushed}`));

          if (treeParts.length > 0) {
            left += theme.fg("muted", " ") + treeParts.join(theme.fg("muted", " "));
          }
        }

        // Model name + token budget bar on same line
        const usage = ctx.getContextUsage();
        const modelName = ctx.model?.name || "";

        // Token budget bar
        const pct = usage ? Math.min(((usage.tokens ?? 0) / (usage.contextWindow ?? 1)) * 100, 100) : 0;
        const filled = Math.round((pct / 100) * 20);
        const empty = 20 - filled;
        // Gradient bar: first third green, middle yellow, last third red
        // Use ANSI codes directly for consistent colors across themes
        const ansiGreen = "\x1b[32m";
        const ansiYellow = "\x1b[33m";
        const ansiRed = "\x1b[31m";
        const ansiDim = "\x1b[2m";
        const ansiReset = "\x1b[0m";

        const total = filled + empty;
        const zoneSize = Math.ceil(total / 3);
        let barParts: string[] = [];
        for (let i = 0; i < total; i++) {
          if (i < filled) {
            const colorCode = i < zoneSize ? ansiGreen : i < zoneSize * 2 ? ansiYellow : ansiRed;
            barParts.push(`${colorCode}#${ansiReset}`);
          } else {
            barParts.push(`${ansiDim}-${ansiReset}`);
          }
        }
        const bar = `[${barParts.join("")}]`;

        // Percentage text color matches the zone of the last filled segment
        let pctColor = ansiGreen;
        if (filled > zoneSize * 2) pctColor = ansiRed;
        else if (filled > zoneSize) pctColor = ansiYellow;
        const budgetStr = usage ? `${bar} ${pctColor}${Math.round(pct)}%${ansiReset} | ${theme.fg("dim", formatTokens(usage.tokens ?? 0) + "/" + formatTokens(usage.contextWindow))}` : "";

        // Combine model name (left) and budget bar (right) with padding
        let middleLine = "";
        if (modelName || budgetStr) {
          const modelPart = modelName ? theme.fg("dim", modelName) : "";
          if (budgetStr && modelPart) {
            // Estimate visible widths (strip ANSI codes for length calc)
            const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
            const modelVis = stripAnsi(modelPart).length;
            const budgetVis = stripAnsi(budgetStr).length;
            const padWidth = Math.max(2, width - modelVis - budgetVis);
            middleLine = modelPart + " ".repeat(padWidth) + budgetStr;
          } else if (budgetStr) {
            middleLine = budgetStr;
          } else {
            middleLine = modelPart;
          }
        }

        // Two-line footer: project/branch, model + budget bar
        return [
          left,
          middleLine,
        ];
      };

      return {
        render,
        invalidate() {},
      };
    });

    // Cleanup on session shutdown.
    pi.on("session_shutdown", () => {
      isDisposed = true;
      clearInterval(timerId);
      tuiHandle = null;
    });
  });
}
