/**
 * Working Indicator Extension
 *
 * Customizes the inline working indicator shown while pi is streaming a response.
 * Supports context-aware mode that changes the indicator based on what Pi is doing.
 *
 * Usage:
 *   pi --extension extensions/working-indicator.ts
 *
 * Commands:
 *   /working-indicator              Show current mode
 *   /working-indicator dot          Use a static dot indicator
 *   /working-indicator pulse        Use a custom animated indicator
 *   /working-indicator none         Hide the indicator entirely
 *   /working-indicator spinner      Restore an animated spinner
 *   /working-indicator auto         Context-aware: spinner (thinking), dot (streaming), pulse (tools)
 *   /working-indicator reset        Restore pi's default spinner
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import type { ExtensionAPI, ExtensionContext, WorkingIndicatorOptions } from "@earendil-works/pi-coding-agent";

type WorkingIndicatorMode = "dot" | "none" | "pulse" | "spinner" | "auto" | "default";

const CONFIG_DIR = join(process.env.HOME || "/root", ".pi", "extensions");
const CONFIG_PATH = join(CONFIG_DIR, "working-indicator.json");

function loadMode(): WorkingIndicatorMode {
	try {
		if (existsSync(CONFIG_PATH)) {
			const data = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
			const valid: WorkingIndicatorMode[] = ["dot", "none", "pulse", "spinner", "auto", "default"];
			if (valid.includes(data.mode)) return data.mode;
		}
	} catch {
		// Ignore errors, use default.
	}
	return "auto";
}

function saveMode(mode: WorkingIndicatorMode) {
	try {
		mkdirSync(CONFIG_DIR, { recursive: true });
		writeFileSync(CONFIG_PATH, JSON.stringify({ mode }, null, 2));
	} catch {
		// Ignore errors.
	}
}

const SPINNER_FRAMES = ["/", "-", "\\", "|"];
const PASTEL_RAINBOW = [
	"\x1b[38;2;255;179;186m",
	"\x1b[38;2;255;223;186m",
	"\x1b[38;2;255;255;186m",
	"\x1b[38;2;186;255;201m",
	"\x1b[38;2;186;225;255m",
	"\x1b[38;2;218;186;255m",
];
const RESET_FG = "\x1b[39m";

function colorize(text: string, color: string): string {
	return `${color}${text}${RESET_FG}`;
}

const HIDDEN_INDICATOR: WorkingIndicatorOptions = {
	frames: [],
};

/** Context-aware phase labels for the status bar mini indicator. */
const PHASE_LABELS: Record<string, { icon: string; label: string; message: string }> = {
	thinking: { icon: ">>>", label: "thinking", message: "Reasoning..." },
	streaming: { icon: "@@@", label: "streaming", message: "Generating response..." },
	tools: { icon: ">O<", label: "tool", message: "Running tools..." },
	idle: { icon: "...", label: "idle", message: "Ready" },
};

function getIndicator(mode: WorkingIndicatorMode): WorkingIndicatorOptions | undefined {
	switch (mode) {
		case "dot":
			return {
				frames: [colorize("@", PASTEL_RAINBOW[0])],
			};
		case "none":
			return HIDDEN_INDICATOR;
		case "pulse":
			return {
				frames: [
					colorize("o", PASTEL_RAINBOW[0]),
					colorize("O", PASTEL_RAINBOW[2]),
					colorize("@", PASTEL_RAINBOW[4]),
					colorize("O", PASTEL_RAINBOW[5]),
				],
				intervalMs: 120,
			};
		case "spinner":
			return {
				frames: SPINNER_FRAMES.map((frame, index) =>
					colorize(frame, PASTEL_RAINBOW[index % PASTEL_RAINBOW.length]!),
				),
				intervalMs: 80,
			};
		case "auto":
			// Default to spinner; phase handlers will override dynamically.
			return {
				frames: SPINNER_FRAMES.map((frame, index) =>
					colorize(frame, PASTEL_RAINBOW[index % PASTEL_RAINBOW.length]!),
				),
				intervalMs: 80,
			};
		case "default":
			return undefined;
	}
}

function describeMode(mode: WorkingIndicatorMode): string {
	switch (mode) {
		case "dot":
			return "static dot";
		case "none":
			return "hidden";
		case "pulse":
			return "custom pulse";
		case "spinner":
			return "custom spinner";
		case "auto":
			return "context-aware (auto)";
		case "default":
			return "pi default spinner";
	}
}

export default function (pi: ExtensionAPI) {
	let mode: WorkingIndicatorMode = loadMode();
	let currentPhase: string = "idle";
	let activeToolCount = 0;
	let lastIndicatorKey: string = ""; // track to avoid redundant setWorkingIndicator calls

	const getAutoIndicator = (phase: string): { key: string; options: WorkingIndicatorOptions } => {
		switch (phase) {
			case "thinking":
				return {
					key: "auto-thinking",
					options: {
						frames: SPINNER_FRAMES.map((frame, index) =>
							colorize(frame, PASTEL_RAINBOW[index % PASTEL_RAINBOW.length]!),
						),
						intervalMs: 60,
					},
				};
			case "streaming":
				return {
					key: "auto-streaming",
					options: {
						frames: [
							colorize("@", PASTEL_RAINBOW[0]),
							colorize("#", PASTEL_RAINBOW[2]),
							colorize("*", PASTEL_RAINBOW[4]),
						],
						intervalMs: 150,
					},
				};
			case "tools":
				return {
					key: "auto-tools",
					options: {
						frames: [
							colorize("o", PASTEL_RAINBOW[0]),
							colorize("O", PASTEL_RAINBOW[2]),
							colorize("@", PASTEL_RAINBOW[4]),
							colorize("O", PASTEL_RAINBOW[5]),
						],
						intervalMs: 120,
					},
				};
			default:
				return {
					key: "auto-idle",
					options: {
						frames: SPINNER_FRAMES.map((frame, index) =>
							colorize(frame, PASTEL_RAINBOW[index % PASTEL_RAINBOW.length]!),
						),
						intervalMs: 80,
					},
				};
		}
	};

	const applyIndicator = (ctx: ExtensionContext, phase?: string) => {
		if (phase) currentPhase = phase;

		// Only call setWorkingIndicator when the actual indicator config changes.
		let indicatorKey: string;
		if (mode === "auto") {
			const { key, options } = getAutoIndicator(currentPhase);
			indicatorKey = key;
			if (key !== lastIndicatorKey) {
				ctx.ui.setWorkingIndicator(options);
			}
		} else {
			indicatorKey = `mode-${mode}`;
			if (indicatorKey !== lastIndicatorKey) {
				ctx.ui.setWorkingIndicator(getIndicator(mode));
			}
		}
		lastIndicatorKey = indicatorKey;

		// Update working message to match current phase.
		const phaseInfo = PHASE_LABELS[currentPhase] || PHASE_LABELS.idle;
		ctx.ui.setWorkingMessage(phaseInfo.message);

		// Update status bar with mini indicator showing current phase (always update).
		const modeDesc = describeMode(mode);
		const statusText = ctx.ui.theme.fg("dim", `${phaseInfo.icon} ${modeDesc} | ${phaseInfo.label}`);
		ctx.ui.setStatus("working-indicator", statusText);
	};

	pi.on("session_start", async (_event, ctx) => {
		applyIndicator(ctx);
	});

	// --- Context-aware phase tracking (only in auto mode) ---

	pi.on("agent_start", async (_event, ctx) => {
		if (mode !== "auto") return;
		activeToolCount = 0;
		applyIndicator(ctx, "thinking");
	});

	pi.on("message_start", async (event, ctx) => {
		if (mode !== "auto") return;
		if (event.message.role === "assistant") {
			activeToolCount = 0;
			applyIndicator(ctx, "streaming");
		}
	});

	pi.on("message_update", async (event, ctx) => {
		if (mode !== "auto") return;
		// Keep showing streaming indicator during token updates.
		if (currentPhase !== "streaming") {
			activeToolCount = 0;
			applyIndicator(ctx, "streaming");
		}
	});

	pi.on("message_end", async (event, ctx) => {
		if (mode !== "auto") return;
		if (event.message.role === "assistant") {
			// If tools are active, stay in tool phase. Otherwise return to thinking.
			if (activeToolCount > 0) {
				applyIndicator(ctx, "tools");
			} else {
				applyIndicator(ctx, "thinking");
			}
		}
	});

	pi.on("tool_execution_start", async (_event, ctx) => {
		if (mode !== "auto") return;
		activeToolCount++;
		applyIndicator(ctx, "tools");
	});

	pi.on("tool_execution_end", async (_event, ctx) => {
		if (mode !== "auto") return;
		activeToolCount = Math.max(0, activeToolCount - 1);
		if (activeToolCount === 0) {
			applyIndicator(ctx, "thinking");
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (mode !== "auto") return;
		activeToolCount = 0;
		applyIndicator(ctx, "idle");
	});

	// --- Command ---

	pi.registerCommand("working-indicator", {
		description: "Set the streaming working indicator: dot, pulse, none, spinner, auto, or reset.",
		handler: async (args, ctx) => {
			const nextMode = args.trim().toLowerCase();
			if (!nextMode) {
				ctx.ui.notify(`Working indicator: ${describeMode(mode)} | Phase: ${currentPhase}`, "info");
				return;
			}

			if (
				nextMode !== "dot" &&
				nextMode !== "none" &&
				nextMode !== "pulse" &&
				nextMode !== "spinner" &&
				nextMode !== "auto" &&
				nextMode !== "reset"
			) {
				ctx.ui.notify("Usage: /working-indicator [dot|pulse|none|spinner|auto|reset]", "error");
				return;
			}

			mode = nextMode === "reset" ? "default" : nextMode;
			saveMode(mode);
			applyIndicator(ctx);
			ctx.ui.notify(`Working indicator set to: ${describeMode(mode)}`, "info");
		},
	});
}
