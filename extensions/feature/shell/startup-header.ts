/**
 * Custom startup header: animated π mascot + model/cwd + Loaded resource panel.
 *
 * Mascot + Loaded counting ported from cc-my-pi's `extensions/claude-header/`
 * (MIT, Tim van den Hoorn); mascot concept inspired by
 * Phoobobo/pi-claude-code-tui (MIT, Phoobobo). Layout, gradient removal and
 * the native-hints right column are original to this package.
 */

import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { config } from "../../config/config.ts";
import { stripAnsi } from "../../utils/ansi-text.ts";
import { shortenCwd } from "../../utils/format.ts";
import { collectLoadedStats, type LoadedStats, resolveAgentDir } from "./loaded-stats.ts";
import { PI_MASCOT_FRAME_COUNT, piMascotFrame } from "./mascot.ts";
import { createQuietStartupFile } from "./quiet-startup.ts";

// 左右双栏布局：左侧 mascot + 模型/目录，右侧 Getting started + Loaded
const TWO_COL_GAP = 3; // ` │ `
// 左栏 ≈ 30% 内宽，收敛到 [24, 44]；右栏拿剩余，恒更宽
const MIN_LEFT_WIDTH = 24;
const MAX_LEFT_WIDTH = 44;
const MIN_RIGHT_WIDTH = 24;

/** mascot 动画间隔：13 帧 ≈ 1.5 秒播完。 */
const MASCOT_ANIMATION_INTERVAL_MS = 120;
const MASCOT_LAST_FRAME = PI_MASCOT_FRAME_COUNT - 1;

/** 进程内动画标记：reload/resume 同进程重挂时跳过重播，直接末帧。 */
const HEADER_ANIMATED = Symbol.for("pi-claude-code:header-animated");

function headerAnimatedThisProcess(): boolean {
	return (globalThis as Record<symbol, unknown>)[HEADER_ANIMATED] === true;
}

function markHeaderAnimated(): void {
	(globalThis as Record<symbol, unknown>)[HEADER_ANIMATED] = true;
}

/**
 * 进程共享的动画控制器（globalThis）。header 工厂可能被重建多次
 * （/reload、双实例、Pi 内部重挂），所有实例共用同一帧计数 + 同一
 * 定时器：后来者从当前帧续播而不是从 0 重来，保证 wall-clock 1.5 秒
 * 内必收敛到末帧（accent 定格），不受重建打断。
 */
type HeaderAnimShared = {
	frame: number;
	done: boolean;
	timer: ReturnType<typeof setInterval> | undefined;
	sinks: Set<() => void>;
};

const HEADER_ANIM = Symbol.for("pi-claude-code:header-anim");

export function headerAnimState(): HeaderAnimShared {
	const g = globalThis as Record<symbol, unknown>;
	let state = g[HEADER_ANIM] as HeaderAnimShared | undefined;
	if (!state) {
		state = { frame: 0, done: false, timer: undefined, sinks: new Set() };
		g[HEADER_ANIM] = state;
	}
	return state;
}

/** 测试/调试用：重置共享动画状态。 */
export function resetHeaderAnimation(): void {
	const state = headerAnimState();
	if (state.timer) clearInterval(state.timer);
	state.frame = 0;
	state.done = false;
	state.timer = undefined;
	state.sinks.clear();
	(globalThis as Record<symbol, unknown>)[HEADER_ANIMATED] = false;
}

function repaintHeaderSinks(): void {
	for (const repaint of headerAnimState().sinks) {
		try {
			repaint();
		} catch {
			/* ignore dead tui */
		}
	}
}

/** 确保唯一的滴答定时器在跑；到末帧自停并标记完成。导出供测试。 */
export function ensureHeaderAnimTick(): void {
	const state = headerAnimState();
	if (state.done || state.timer) return;
	state.timer = setInterval(() => {
		if (state.frame < MASCOT_LAST_FRAME) {
			state.frame++;
			repaintHeaderSinks();
		} else {
			if (state.timer) clearInterval(state.timer);
			state.timer = undefined;
			state.done = true;
			markHeaderAnimated();
			repaintHeaderSinks();
		}
	}, MASCOT_ANIMATION_INTERVAL_MS);
	(state.timer as unknown as { unref?: () => void }).unref?.();
}

function renderMascotLines(
	palette: { accent: (s: string) => string; muted: (s: string) => string },
	frame: number,
): string[] {
	return piMascotFrame(frame, palette);
}

// ---- 布局 helpers（盒线骨架沿用 cc-my-pi/pi-claude-code-tui 的做法，MIT） ----

function center(text: string, width: number): string {
	if (width <= 0) return "";
	const w = visibleWidth(text);
	if (w >= width) return truncateToWidth(text, width, "…");
	return `${" ".repeat(Math.floor((width - w) / 2))}${text}`;
}

function padRight(text: string, width: number, ellipsis = ""): string {
	const clipped = truncateToWidth(text, width, ellipsis);
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function headerColumnWidths(innerWidth: number): {
	leftWidth: number;
	rightWidth: number;
	useRight: boolean;
} {
	const single = { leftWidth: innerWidth, rightWidth: 0, useRight: false };
	if (innerWidth <= 0) return { leftWidth: 0, rightWidth: 0, useRight: false };
	if (innerWidth < MIN_LEFT_WIDTH + TWO_COL_GAP + MIN_RIGHT_WIDTH) return single;
	const leftWidth = Math.min(
		MAX_LEFT_WIDTH,
		Math.max(MIN_LEFT_WIDTH, Math.round(innerWidth * 0.3)),
	);
	const rightWidth = innerWidth - TWO_COL_GAP - leftWidth;
	if (rightWidth < MIN_RIGHT_WIDTH || rightWidth <= leftWidth) return single;
	return { leftWidth, rightWidth, useRight: true };
}

function borderLine(
	left: string,
	label: string,
	right: string,
	width: number,
	paint: (text: string) => string,
): string {
	if (width <= 1) return "";
	if (width < 8 || label.length === 0) {
		return paint(truncateToWidth(left + "─".repeat(Math.max(0, width - 2)) + right, width, ""));
	}
	const before = "─── ";
	const after = " ─────";
	const fixedWidth = visibleWidth(before) + visibleWidth(label) + visibleWidth(after);
	const fill = Math.max(0, width - 2 - fixedWidth);
	return `${paint(left)}${paint(before)}${label}${paint(after)}${paint("─".repeat(fill))}${paint(right)}`;
}

function boxedLine(content: string, width: number, paint: (text: string) => string): string {
	if (width <= 2) return truncateToWidth(content, width, "");
	return `${paint("│")}${padRight(content, width - 2)}${paint("│")}`;
}

function twoColumn(
	left: string,
	right: string,
	leftWidth: number,
	rightWidth: number,
	paint: (text: string) => string,
): string {
	// 右栏超宽截断省略号；左栏已居中不再截。
	return `${padRight(left, leftWidth)} ${paint("│")} ${padRight(right, rightWidth, "…")}`;
}

// ---- 文本格式化（pi-claude-code-tui 原体，MIT） ----

function formatCwd(cwd: string, home: string = homedir()): string {
	return shortenCwd(cwd, home);
}

function formatModelLabel(model: { provider?: string; id?: string } | null | undefined): string {
	if (!model?.id) return "Default model";
	return model.provider ? `${model.provider}/${model.id}` : model.id;
}

function formatThinkingLabel(level: string): string {
	return level === "off" ? "off" : level;
}

// ---- 右侧文案 ----

/** Loaded 盘点行；扫描中显示省略号。返回裸计数，由调用方加标题。 */
function renderLoadedLines(
	stats: LoadedStats | undefined,
	theme: { fg(name: string, text: string): string },
): { counts: string; aggregate: string } {
	if (!stats) {
		return { counts: theme.fg("muted", "…"), aggregate: "" };
	}
	const parts = [
		`${stats.skills.user + stats.skills.project} skills`,
		`${stats.prompts.user + stats.prompts.project} prompts`,
		`${stats.extensions.user + stats.extensions.project} extensions`,
	];
	if (stats.mcpServers > 0) parts.push(`${stats.mcpServers} mcp servers`);
	const global = stats.skills.user + stats.prompts.user + stats.extensions.user;
	const project = stats.skills.project + stats.prompts.project + stats.extensions.project;
	return {
		counts: theme.fg("muted", parts.join(" · ")),
		aggregate: theme.fg("muted", `${global} global · ${project} project`),
	};
}

export type HeaderMeta = {
	model?: { provider?: string; id?: string } | null;
	thinkingLevel?: string;
	cwd?: string;
};

export function renderHeaderLines(
	width: number,
	theme: {
		getFgAnsi(name: string): string;
		fg(name: string, text: string): string;
		bold(text: string): string;
	},
	frame: number = MASCOT_LAST_FRAME,
	stats?: LoadedStats,
	meta: HeaderMeta = {},
): string[] {
	const paint = (s: string) => theme.fg("accent", s);
	const muted = (s: string) => theme.fg("muted", s);
	const dim = (s: string) => theme.fg("dim", s);
	const bold = (s: string) => theme.bold(s);
	const loaded = renderLoadedLines(stats, theme);

	if (width < 24) return [paint(`Pi v${VERSION}`)];

	const model = formatModelLabel(meta.model);
	const effort = formatThinkingLabel(meta.thinkingLevel ?? "off");
	const cwd = formatCwd(meta.cwd ?? "");

	const innerWidth = width - 2;
	const { leftWidth, rightWidth, useRight } = headerColumnWidths(innerWidth);

	// 左栏：标题 → mascot → 模型·档位 → 目录；右栏：Getting started + Loaded
	// 左栏行保持原始宽度，布局时再按实际 leftWidth 居中，避免预居中被截断。
	const leftLines = [
		bold("pi-cc"),
		...renderMascotLines({ accent: paint, muted }, frame),
		muted(`${model} · ${effort} effort`),
		dim(cwd),
	];
	const divider = paint("─".repeat(Math.max(8, Math.min(rightWidth || 16, 16))));
	const rightLines = [
		paint(bold("Getting started")),
		muted("Run /ccstyle to configure the look"),
		divider,
		paint(bold("Loaded")),
		loaded.counts,
		loaded.aggregate,
		dim("/loaded for details"),
	];

	const lines = [borderLine("╭", `${paint("Pi")} v${VERSION}`, "╮", width, paint)];
	if (!useRight) {
		// 单栏：左栏内容占满内宽（center 是 ANSI 感知的，保留小人配色）
		for (const line of leftLines) lines.push(boxedLine(center(line, innerWidth), width, paint));
		lines.push(boxedLine(center(`Loaded: ${stripAnsi(loaded.counts)}`, innerWidth), width, paint));
		if (loaded.aggregate)
			lines.push(boxedLine(center(stripAnsi(loaded.aggregate), innerWidth), width, paint));
	} else {
		const rowCount = Math.max(leftLines.length, rightLines.length);
		for (let i = 0; i < rowCount; i++) {
			const content = twoColumn(
				center(leftLines[i] ?? "", leftWidth),
				rightLines[i] ?? "",
				leftWidth,
				rightWidth,
				paint,
			);
			lines.push(boxedLine(content, width, paint));
		}
	}
	lines.push(borderLine("╰", "", "╯", width, paint));
	return lines.map((line) => truncateToWidth(line, width, ""));
}

/** 当前会话已缓存的盘点（扫描中为 undefined），附带所属 cwd，切目录即失效。 */
let cachedStats: LoadedStats | undefined;
let cachedStatsCwd: string | undefined;

function safeHasCommand(pi: unknown, name: string): boolean {
	try {
		const commands = (pi as { getCommands?: () => Array<{ name?: string }> }).getCommands?.();
		return Array.isArray(commands) && commands.some((c) => c?.name === name);
	} catch {
		return false;
	}
}

/** 当前 thinking 档位；拿不到则回退 off。 */
function safeThinkingLevel(pi: unknown): string {
	try {
		const level = (pi as { getThinkingLevel?: () => string }).getThinkingLevel?.();
		return typeof level === "string" && level ? level : "off";
	} catch {
		return "off";
	}
}

/** 启动资源扫描（按 cwd 缓存）； resolve 后请求重绘。 */
function ensureStats(pi: unknown, cwd: string, requestRender: () => void): void {
	if (cachedStats && cachedStatsCwd === cwd) {
		requestRender();
		return;
	}
	cachedStats = undefined;
	cachedStatsCwd = cwd;
	collectLoadedStats(cwd, resolveAgentDir(), safeHasCommand(pi, "mcp")).then(
		(stats) => {
			cachedStats = stats;
			cachedStatsCwd = cwd;
			requestRender();
		},
		() => {
			/* 失败则省略盘点行 */
		},
	);
}

type HeaderComponent = {
	render(width: number): string[];
	invalidate(): void;
	dispose(): void;
};

let activeHeader: HeaderComponent | undefined;

function disposeActiveHeader(): void {
	try {
		activeHeader?.dispose();
	} catch {
		/* ignore */
	}
	activeHeader = undefined;
}

/**
 * 按配置应用启动头：on → 自定义 header；off → 恢复官方默认 header。
 * 导出供 /ccstyle 面板在切换开关时实时重应用。
 */
export function applyStartupHeader(ctx: any, pi?: unknown): void {
	if (!ctx?.hasUI || typeof ctx.ui?.setHeader !== "function") return;
	if (!config.showStartupHeader) {
		// 恢复官方内置 header（logo + 快捷键提示 + onboarding）。
		disposeActiveHeader();
		ctx.ui.setHeader(undefined);
		return;
	}
	const skipAnimation = !config.startupAnimation || headerAnimatedThisProcess();
	const anim = headerAnimState();
	if (skipAnimation) {
		// 关动画或已播过：直接末帧，不启动定时器。
		anim.frame = MASCOT_LAST_FRAME;
		anim.done = true;
		markHeaderAnimated();
	} else {
		ensureHeaderAnimTick();
	}
	disposeActiveHeader();
	ctx.ui.setHeader((tui: any, _theme: unknown) => {
		const requestRender = () => {
			try {
				tui?.requestRender?.();
			} catch {
				/* ignore */
			}
		};
		try {
			ensureStats(pi, ctx.cwd, requestRender);
		} catch {
			/* ignore stale ctx */
		}
		// 注册重绘槽：共享定时器每帧刷所有存活实例；render 读共享帧，天然续播。
		anim.sinks.add(requestRender);
		const component: HeaderComponent = {
			render(width: number): string[] {
				// 主题每次渲染现取，跟随 /theme 切换；ctx getter stale 则回退空信息。
				const theme = ctx.ui.theme;
				let meta: HeaderMeta = {};
				try {
					meta = {
						model: ctx.model ?? null,
						thinkingLevel: safeThinkingLevel(pi),
						cwd: typeof ctx.cwd === "string" ? ctx.cwd : "",
					};
				} catch {
					/* ignore stale ctx */
				}
				return renderHeaderLines(width, theme, anim.frame, cachedStats, meta);
			},
			invalidate() {},
			dispose() {
				anim.sinks.delete(requestRender);
			},
		};
		activeHeader = component;
		return component;
	});
}

const quietStartupFile = createQuietStartupFile();

export default function piStartupHeader(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		// quietStartup 只做单向确保（开则写入 Pi 配置）；关闭走面板显式写入，避免误清用户手写值。
		if (config.showStartupHeader && config.quietStartup) {
			try {
				quietStartupFile.write(true);
			} catch {
				/* best effort */
			}
		}
		applyStartupHeader(ctx, pi);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		disposeActiveHeader();
		ctx.ui.setHeader(undefined);
	});
}
