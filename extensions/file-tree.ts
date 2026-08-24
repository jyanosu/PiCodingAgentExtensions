/**
 * File Tree Panel - persistent right-side file tree overlay
 *
 * Usage: pi --extension ./extensions/file-tree.ts
 * (or copy to ~/.pi/agent/extensions/)
 *
 * Toggle: /tree or Ctrl+Alt+T
 * Filter: /tree <pattern> — show only entries whose name matches (plus ancestor dirs)
 * Clear filter: /tree clear
 * Focus mode (feature flag, off by default): /tree focus on|off
 *   When on, the panel can take keyboard focus:
 *     Ctrl+Alt+L — focus panel (arrows/j/k scroll, type to filter, Esc back)
 *     Ctrl+Alt+H or Esc — return keys to the editor
 *
 * Shows a live file tree of the current working directory in a panel on the
 * right edge. The panel is non-capturing (typing still goes to the editor)
 * and refreshes automatically when files change on disk.
 */

import { execFile } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";

type CustomEntry = Extract<SessionEntry, { type: "custom" }>;
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

const IGNORED = new Set([
	".git",
	"node_modules",
	"dist",
	"out",
	"build",
	".next",
	".nuxt",
	".turbo",
	".cache",
	".venv",
	"venv",
	"__pycache__",
	".pytest_cache",
	"target",
	"coverage",
]);

const MAX_DEPTH = 6;
const MAX_ENTRIES = 2000;
const REFRESH_DEBOUNCE_MS = 400;

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const BOLD_CYAN = "\x1b[1;36m";
const RESET = "\x1b[0m";

/** ANSI color for a file name by porcelain status (first char of XY). */
function gitColor(status: string): string {
	const c = status[0];
	if (c === "M") return "\x1b[33m"; // modified — yellow
	if (c === "A" || status === "??") return "\x1b[32m"; // added/untracked — green
	if (c === "D") return "\x1b[31m"; // deleted — red
	if (c === "R") return "\x1b[35m"; // renamed — magenta
	return "\x1b[33m";
}

/** Git status marker per porcelain code (first char of XY). */
function gitMarker(status: string): string {
	const c = status[0];
	if (c === "M") return `\x1b[1;33mM${RESET}`; // modified — bold yellow
	if (c === "A" || status === "??") return `\x1b[1;32m+${RESET}`; // added/untracked — green
	if (c === "D") return `\x1b[1;31m-${RESET}`; // deleted — red
	if (c === "R") return `\x1b[1;35mR${RESET}`; // renamed — magenta
	return `\x1b[1;33m${c}${RESET}`;
}

/** Decode a C-quoted git path (git quotes paths with special chars/unicode). */
function unquoteGitPath(s: string): string {
	const bytes: number[] = [];
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (c !== "\\") {
			bytes.push(...Buffer.from(c, "utf8"));
			continue;
		}
		i++;
		const n = s[i];
		if (n === "n") bytes.push(10);
		else if (n === "t") bytes.push(9);
		else if (n === "\\" || n === '"') bytes.push(n.charCodeAt(0));
		else if (n >= "0" && n <= "7") {
			let oct = n;
			while (
				oct.length < 3 &&
				i + 1 < s.length &&
				s[i + 1] >= "0" &&
				s[i + 1] <= "7"
			) {
				i++;
				oct += s[i];
			}
			bytes.push(parseInt(oct, 8));
		} else if (n !== undefined) bytes.push(n.charCodeAt(0));
	}
	return Buffer.from(bytes).toString("utf8");
}

interface GitState {
	branch: string;
	/** Relative path (slash-separated) → porcelain status code. */
	status: Map<string, string>;
}

function gitRun(root: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			args,
			{ cwd: root, maxBuffer: 10 * 1024 * 1024 },
			(err, stdout) => (err ? reject(err) : resolve(stdout)),
		);
	});
}

async function getGitState(root: string): Promise<GitState | null> {
	try {
		const [porcelain, branch] = await Promise.all([
			gitRun(root, ["status", "--porcelain"]),
			gitRun(root, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "HEAD"),
		]);
		const status = new Map<string, string>();
		for (const line of porcelain.split("\n")) {
			if (line.length < 4) continue;
			const code = line.slice(0, 2);
			let p = line.slice(3);
			// Rename/copy: "R  old -> new" — keep the new path.
			const arrow = p.indexOf(" -> ");
			if (arrow !== -1) p = p.slice(arrow + 4);
			// Git C-quotes paths with special characters or non-ASCII bytes.
			if (p.startsWith('"') && p.endsWith('"')) p = unquoteGitPath(p.slice(1, -1));
			if (code === "??" && p.endsWith("/")) p = p.slice(0, -1); // untracked dir
			status.set(p, code);
		}
		return { branch: branch.trim() || "HEAD", status };
	} catch {
		return null; // not a git repo (or git missing)
	}
}

/** Panel component: renders pre-built tree lines, clipped to viewport height. */
interface FileTreePanelOptions {
	onEscape?: () => void;
	/** Printable char or "backspace" — filter editing while focused. */
	onFilterKey?: (key: string) => void;
}

/** Optional line shown above the tree (e.g. active filter). */
class FileTreePanel implements Component {
	private lines: string[] = [];
	private scrollTop = 0;
	private tui: TUI;
	private opts: FileTreePanelOptions;
	filterLine: string | null = null;

	constructor(tui: TUI, opts: FileTreePanelOptions = {}) {
		this.tui = tui;
		this.opts = opts;
	}

	setFilterLine(line: string | null): void {
		this.filterLine = line;
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.opts.onEscape?.();
			return;
		}
		if (matchesKey(data, "up") || data === "k") {
			this.scroll(-1);
			return;
		}
		if (matchesKey(data, "down") || data === "j") {
			this.scroll(1);
			return;
		}
		const maxRows = Math.max(1, this.tui.terminal.rows - 6);
		if (matchesKey(data, "pageUp")) {
			this.scroll(-(maxRows - 1));
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.scroll(maxRows - 1);
			return;
		}
		if (matchesKey(data, "backspace")) {
			this.opts.onFilterKey?.("backspace");
			return;
		}
		// Plain printable char → filter input.
		if (data.length === 1 && data.charCodeAt(0) >= 32)
			this.opts.onFilterKey?.(data);
	}

	setLines(lines: string[]): void {
		this.lines = lines;
		this.clampScroll();
		this.tui.requestRender();
	}

	/** Scroll by delta rows; returns true when the position changed. */
	scroll(delta: number): boolean {
		const maxRows = Math.max(1, this.tui.terminal.rows - 6);
		const maxTop = Math.max(0, this.lines.length - maxRows);
		const next = Math.min(maxTop, Math.max(0, this.scrollTop + delta));
		if (next === this.scrollTop) return false;
		this.scrollTop = next;
		this.tui.requestRender();
		return true;
	}

	private clampScroll(): void {
		const maxRows = Math.max(1, this.tui.terminal.rows - 6);
		this.scrollTop = Math.min(
			this.scrollTop,
			Math.max(0, this.lines.length - maxRows),
		);
	}

	invalidate(): void {
		// Lines are rebuilt from disk; nothing to clear.
	}

	render(width: number): string[] {
		// Leave room for the editor + footer below the panel.
		const maxRows = Math.max(1, this.tui.terminal.rows - 6);
		this.scrollTop = Math.min(
			this.scrollTop,
			Math.max(0, this.lines.length - maxRows),
		);
		const visible = this.lines
			.slice(this.scrollTop, this.scrollTop + maxRows)
			.map((line) => truncateToWidth(line, width));
		if (this.filterLine) visible.unshift(truncateToWidth(this.filterLine, width));
		if (this.scrollTop > 0)
			visible.unshift(`${DIM}↑ ${this.scrollTop} more${RESET}`);
		const hidden = this.lines.length - (this.scrollTop + visible.length);
		if (hidden > 0) visible.push(`${DIM}↓ ${hidden} more${RESET}`);
		return visible;
	}
}

interface TreeEntry {
	name: string;
	dir: boolean;
	depth: number;
	rel: string;
}

const FILE_ICONS: Record<string, string> = {
	ts: "🔷",
	mts: "🔷",
	cts: "🔷",
	js: "🟨",
	mjs: "🟨",
	cjs: "🟨",
	jsx: "🟨",
	json: "🧾",
	md: "📝",
	mdx: "📝",
	rst: "📝",
	txt: "📄",
	log: "📄",
	css: "🎨",
	scss: "🎨",
	less: "🎨",
	html: "🌐",
	htm: "🌐",
	xml: "🌐",
	py: "🐍",
	rs: "🦀",
	go: "🐹",
	java: "☕",
	c: "🛠",
	h: "🛠",
	cpp: "🛠",
	hpp: "🛠",
	cc: "🛠",
	sh: "💻",
	bash: "💻",
	zsh: "💻",
	ps1: "💻",
	bat: "💻",
	yaml: "⚙",
	yml: "⚙",
	toml: "⚙",
	ini: "⚙",
	conf: "⚙",
	env: "⚙",
	png: "🖼",
	jpg: "🖼",
	jpeg: "🖼",
	gif: "🖼",
	webp: "🖼",
	svg: "🖼",
	bmp: "🖼",
	ico: "🖼",
	mp4: "🎬",
	mov: "🎬",
	mkv: "🎬",
	webm: "🎬",
	mp3: "🎵",
	wav: "🎵",
	ogg: "🎵",
	flac: "🎵",
	zip: "📦",
	tar: "📦",
	gz: "📦",
	rar: "📦",
	"7z": "📦",
	pdf: "📕",
	sql: "🗃",
	db: "🗃",
};

function fileIcon(name: string): string {
	const lower = name.toLowerCase();
	if (lower === "dockerfile") return "🐳";
	if (lower === "makefile") return "🔨";
	if (lower === ".gitignore" || lower === ".dockerignore") return "🛡";
	if (lower.endsWith(".lock") || lower === "package-lock.json") return "🔒";
	const dot = lower.lastIndexOf(".");
	const ext = dot > 0 ? lower.slice(dot + 1) : "";
	return FILE_ICONS[ext] ?? "📄";
}

function relPath(root: string, abs: string): string {
	return path.relative(root, abs).split(path.sep).join("/");
}

async function walk(
	root: string,
	dir: string,
	prefix: string,
	depth: number,
	out: TreeEntry[],
	git: GitState | null,
): Promise<void> {
	if (depth > MAX_DEPTH || out.length >= MAX_ENTRIES) return;
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return; // unreadable dir — skip
	}
	const byName = (a: { name: string }, b: { name: string }) =>
		a.name.localeCompare(b.name);
	const dirs = entries
		.filter((e) => e.isDirectory() && !IGNORED.has(e.name))
		.sort(byName);
	const files = entries
		.filter((e) => e.isFile() && !IGNORED.has(e.name))
		.sort(byName);

	for (const d of dirs) {
		const abs = path.join(dir, d.name);
		out.push({ name: d.name, dir: true, depth, rel: relPath(root, abs) });
		if (out.length >= MAX_ENTRIES) return;
		await walk(root, abs, prefix + "  ", depth + 1, out, git);
	}
	for (const f of files) {
		out.push({
			name: f.name,
			dir: false,
			depth,
			rel: relPath(root, path.join(dir, f.name)),
		});
		if (out.length >= MAX_ENTRIES) return;
	}
}

/**
 * Filter pre-order entries to name matches plus their ancestor dirs.
 * Forward scan: when an entry matches, its open ancestors (stack) are kept.
 */
function filterEntries(entries: TreeEntry[], pattern: string): TreeEntry[] {
	const p = pattern.toLowerCase();
	const keep = entries.map((e) => e.name.toLowerCase().includes(p));
	const stack: number[] = []; // indices of open ancestors, increasing depth
	for (let i = 0; i < entries.length; i++) {
		while (
			stack.length &&
			entries[stack[stack.length - 1]].depth >= entries[i].depth
		)
			stack.pop();
		if (keep[i]) for (const a of stack) keep[a] = true;
		stack.push(i);
	}
	return entries.filter((_, i) => keep[i]);
}

function renderEntries(entries: TreeEntry[], git: GitState | null): string[] {
	const out: string[] = [];
	for (const e of entries) {
		const prefix = "  ".repeat(e.depth);
		if (e.dir) {
			let marker = "";
			if (git) {
				// Mark the dir itself (e.g. untracked dir) or count dirty children.
				if (git.status.has(e.rel)) marker = ` ${gitMarker(git.status.get(e.rel)!)}`;
				else {
					const prefixKey = e.rel + "/";
					let n = 0;
					for (const key of git.status.keys()) if (key.startsWith(prefixKey)) n++;
					if (n > 0) marker = ` ${DIM}(${n})${RESET}`;
				}
			}
			out.push(`${prefix}📁 ${BOLD_CYAN}${e.name}/${RESET}${marker}`);
			continue;
		}
		const code = git?.status.get(e.rel);
		const icon = fileIcon(e.name);
		// Color the file name by git status; clean files stay dim.
		out.push(
			code
				? `${prefix}${icon} ${gitColor(code)}${e.name}${RESET} ${gitMarker(code)}`
				: `${DIM}${prefix}${icon} ${e.name}${RESET}`,
		);
	}
	return out;
}

async function buildTree(root: string, filter: string): Promise<string[]> {
	const git = await getGitState(root);
	let header = git
		? `${BOLD}${git.branch}${RESET} ${DIM}${git.status.size > 0 ? `● ${git.status.size} changed` : "clean"}${RESET}`
		: `${DIM}${path.basename(root)}/${RESET}`;
	const entries: TreeEntry[] = [];
	await walk(root, root, "", 0, entries, git);
	const shown = filter ? filterEntries(entries, filter) : entries;
	if (filter)
		header += ` ${DIM}[${shown.length} match${shown.length === 1 ? "" : "es"}]${RESET}`;
	return [header, ...renderEntries(shown, git)];
}

export default function (pi: ExtensionAPI) {
	let open = false;
	let closePanel: (() => void) | null = null;
	let activePanel: FileTreePanel | null = null;
	let removeInputListener: (() => void) | null = null;
	let watcher: FSWatcher | null = null;
	let refreshTimer: NodeJS.Timeout | null = null;
	let root = process.cwd();
	let filter = "";
	let focusMode = false;
	let panelHandle: OverlayHandle | null = null;
	let filterDebounce: NodeJS.Timeout | null = null;

	function detachInput(): void {
		removeInputListener?.();
		removeInputListener = null;
	}

	function stopWatcher(): void {
		if (refreshTimer) {
			clearTimeout(refreshTimer);
			refreshTimer = null;
		}
		if (filterDebounce) {
			clearTimeout(filterDebounce);
			filterDebounce = null;
		}
		watcher?.close();
		watcher = null;
	}

	function startWatcher(ctx: ExtensionContext): void {
		stopWatcher();
		let w: FSWatcher | null = null;
		try {
			w = watch(root, { recursive: true }, () => scheduleRefresh(ctx));
		} catch {
			try {
				w = watch(root, () => scheduleRefresh(ctx));
			} catch {
				w = null;
			}
		}
		watcher = w;
	}

	function scheduleRefresh(_ctx: ExtensionContext): void {
		if (!open) return;
		if (refreshTimer) clearTimeout(refreshTimer);
		refreshTimer = setTimeout(() => {
			refreshTimer = null;
			void buildTree(root, filter).then((lines) => activePanel?.setLines(lines));
		}, REFRESH_DEBOUNCE_MS);
	}

	async function toggle(ctx: ExtensionContext, args?: string): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("File tree requires interactive mode", "error");
			return;
		}
		root = ctx.cwd;
		const arg = args?.trim() ?? "";
		if (arg.toLowerCase().startsWith("focus")) {
			focusMode = !/\boff\b/i.test(arg);
			pi.appendEntry("fileTreeFocusMode", focusMode ? "on" : "off");
			ctx.ui.notify(
				focusMode
					? open
						? "Focus mode ON — applies when panel reopens"
						: "Focus mode ON — Ctrl+Alt+L = panel keys, Ctrl+Alt+H/Esc = editor"
					: "Focus mode OFF",
				"info",
			);
			return;
		}
		if (arg) {
			filter = arg.toLowerCase() === "clear" ? "" : arg;
			ctx.ui.notify(
				filter ? `File tree filter: ${filter}` : "File tree filter cleared",
				"info",
			);
		}
		if (open) {
			open = false;
			activePanel = null;
			panelHandle = null;
			detachInput();
			stopWatcher();
			closePanel?.();
			closePanel = null;
			ctx.ui.notify("File tree closed", "info");
			return;
		}
		open = true;
		ctx.ui.notify(`File tree open — ${root}`, "info");
		try {
			// Wait only until the overlay factory has attached (closePanel set),
			// not for the panel's whole lifetime — otherwise this toggle would
			// resume after a later close and re-start the watcher.
			await new Promise<void>((resolve, reject) => {
				let settled = false;
				const failTimer = setTimeout(() => {
					if (!settled) {
						settled = true;
						reject(new Error("overlay did not attach"));
					}
				}, 5000);
				void ctx.ui.custom(
					(tui, _theme, _keybindings, done) => {
						closePanel = () => {
							clearTimeout(failTimer);
							done(undefined);
						};
						if (!settled) {
							settled = true;
							clearTimeout(failTimer);
							resolve();
						}
						const backToEditor = () => {
							panelHandle?.unfocus();
							ctx.ui.notify("Focus back to editor", "info");
						};
						const panel = new FileTreePanel(tui, {
							onEscape: backToEditor,
							onFilterKey: (key) => {
								filter = key === "backspace" ? filter.slice(0, -1) : filter + key;
								panel.setFilterLine(filter ? `\x1b[1;36m✎ ${filter}${RESET}` : null);
								if (filterDebounce) clearTimeout(filterDebounce);
								filterDebounce = setTimeout(() => {
									filterDebounce = null;
									void buildTree(root, filter).then((lines) =>
										activePanel?.setLines(lines),
									);
								}, 120);
							},
						});
						activePanel = panel;
						// Non-capturing overlays receive no keys, so scroll via a
						// global input listener that runs before the editor sees them.
						removeInputListener = tui.addInputListener((data) => {
							if (matchesKey(data, "ctrl+alt+l") && !focusMode) {
								ctx.ui.notify("Focus mode off — /tree focus on", "info");
								return { consume: true };
							}
							if (focusMode && panelHandle) {
								if (matchesKey(data, "ctrl+alt+l")) {
									// Toggle: focused → back to editor, else focus panel.
									if (panelHandle.isFocused()) backToEditor();
									else {
										panelHandle.focus();
										ctx.ui.notify(
											"File tree focused — type to filter, Esc for editor",
											"info",
										);
									}
									return { consume: true };
								}
								if (matchesKey(data, "ctrl+alt+h")) {
									backToEditor();
									return { consume: true };
								}
							}
							if (matchesKey(data, "ctrl+alt+down"))
								return panel.scroll(5) ? { consume: true } : undefined;
							if (matchesKey(data, "ctrl+alt+up"))
								return panel.scroll(-5) ? { consume: true } : undefined;
							return undefined;
						});
						void buildTree(root, filter).then((lines) => panel.setLines(lines));
						return panel;
					},
					{
						overlay: true,
						onHandle: (handle) => {
							panelHandle = handle;
							// Capturing overlay grabs focus on show — release it so the
							// editor keeps typing until Ctrl+Alt+L claims the panel.
							if (focusMode) handle.unfocus();
						},
						overlayOptions: {
							width: "30%",
							minWidth: 24,
							maxHeight: "90%",
							anchor: "right-center",
							nonCapturing: !focusMode,
							margin: { top: 1, right: 0, bottom: 1, left: 1 },
						},
					},
				);
			});
			startWatcher(ctx);
		} catch (error) {
			open = false;
			activePanel = null;
			panelHandle = null;
			detachInput();
			stopWatcher();
			ctx.ui.notify(
				`File tree failed: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}
	}

	pi.registerCommand("tree", {
		description:
			"Toggle file tree panel; /tree <pattern> filter; /tree clear; /tree focus on|off (panel key focus mode)",
		handler: async (args, ctx) => {
			await toggle(ctx, args);
		},
	});

	pi.registerShortcut("ctrl+alt+t", {
		description: "Toggle file tree panel",
		handler: (ctx) => toggle(ctx),
	});

	pi.on("session_start", (_event, ctx) => {
		// Restore focus-mode flag from the most recent persisted entry.
		const last = [...ctx.sessionManager.getEntries()]
			.reverse()
			.find(
				(e): e is CustomEntry =>
					e.type === "custom" && e.customType === "fileTreeFocusMode",
			);
		if (last && typeof last.data === "string") focusMode = last.data === "on";
	});

	pi.on("session_shutdown", () => {
		open = false;
		activePanel = null;
		panelHandle = null;
		detachInput();
		stopWatcher();
		closePanel?.();
		closePanel = null;
	});
}
