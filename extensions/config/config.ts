import type { CompactThinkingConfig } from "../feature/compact-thinking.ts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type CompactStyleMode = "on" | "compact" | "off";

export type DiffViewMode = "auto" | "split" | "unified";
export type DiffIndicatorMode = "bars" | "classic" | "none";

export interface ToolDisplayConfig {
	diffViewMode: DiffViewMode;
	diffIndicatorMode: DiffIndicatorMode;
	diffSplitMinWidth: number;
	editDiffCollapsedLines: number;
	/** Write-only collapsed body lines. 0 = `↳ created • click to show more`. */
	writeDiffCollapsedLines: number;
	diffWordWrap: boolean;
	expandedPreviewMaxLines: number;
}

export const DEFAULT_TOOL_DISPLAY_CONFIG: ToolDisplayConfig = {
	diffViewMode: "auto",
	diffIndicatorMode: "bars",
	diffSplitMinWidth: 120,
	/** Collapsed edit/diff body: ~half a typical terminal after chrome. */
	editDiffCollapsedLines: 24,
	/**
	 * Write create/overwrite collapsed body.
	 * 0 = `↳ created • click to show more` (stats stay on the title).
	 */
	writeDiffCollapsedLines: 0,
	diffWordWrap: true,
	/**
	 * Expanded tool/diff body cap. 40 ≈ one screen of content after title,
	 * Input section, editor, and status — keeps the TUI compact.
	 * Raise via /ccstyle → Diff → Expanded max lines when reviewing large dumps.
	 */
	expandedPreviewMaxLines: 40,
};

export type Config = {
	mode: CompactStyleMode;
	excludeRenderers: string[];
	diffViewMode: DiffViewMode;
	diffIndicatorMode: DiffIndicatorMode;
	diffSplitMinWidth: number;
	editDiffCollapsedLines: number;
	writeDiffCollapsedLines: number;
	diffWordWrap: boolean;
	expandedPreviewMaxLines: number;
	expandedInputMaxLines: number;
	expandedOutputMaxLines: number;
	inputClip: number;
	useSummaryTitlesAsThinkingTitle: boolean;
	previewLines: number;
	animationIntervalMs: number;
	/** 展开中间态 tail 窗口行数；再推进一次才全文。 */
	thinkingExpandedMaxLines: number;
	dimThinkingText: boolean;
	showStartupHeader: boolean;
	startupAnimation: boolean;
	quietStartup: boolean;
	scrollStepLines: number;
	/** 回合耗时超过 N 秒完成时响铃（BEL）；0 关闭。 */
	completionBellAfterSec: number;
	/** bash 执行中/落定尾预览开关。 */
	liveToolPreview: boolean;
	/** bash 尾预览行数。 */
	liveToolPreviewLines: number;
	enableSessionReference: boolean;
	enableSubagentAutocomplete: boolean;
	enableContextCommand: boolean;
	enableAgentSummary: boolean;
	enableWorkingMessage: boolean;
	enableAliases: boolean;
	enableImagePaster: boolean;
	enableClipboardPaste: boolean;
};

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(AGENT_DIR, "claude-code-style.json");

export const DIFF_VIEW_MODES: DiffViewMode[] = ["auto", "split", "unified"];
export const DIFF_INDICATOR_MODES: DiffIndicatorMode[] = ["bars", "classic", "none"];
export const DIFF_SPLIT_MIN_WIDTH_VALUES = ["80", "100", "120", "140", "160", "180"];
export const DIFF_COLLAPSED_LINES_VALUES = ["12", "24", "36", "48", "80", "120"];
/** Write collapsed presets. 0 = stats only (`+N -0` + expand hint). */
export const WRITE_DIFF_COLLAPSED_LINES_VALUES = ["0", "4", "8", "12", "24", "36"];
/** Presets for expanded body height — keep low options first so cycling stays TUI-friendly. */
export const EXPANDED_PREVIEW_MAX_LINES_VALUES = ["40", "60", "80", "120", "200", "500", "2000"];
/** 展开工具卡 Input 可见行数预设。 */
export const EXPANDED_INPUT_MAX_LINES_VALUES = ["5", "10", "20", "40", "80"];
/** 展开工具卡 Output 可见行数预设。 */
export const EXPANDED_OUTPUT_MAX_LINES_VALUES = ["10", "20", "40", "80", "120"];
/** 工具摘要里 path/command 等输入的折叠字符数。 */
export const INPUT_CLIP_VALUES = ["40", "60", "80", "100", "120", "160"];
export const THINKING_PREVIEW_LINES_VALUES = ["0", "1", "2", "3", "5", "10"];
export const THINKING_EXPANDED_MAX_LINES_VALUES = ["40", "100", "200", "500", "2000"];
export const THINKING_ANIMATION_INTERVAL_VALUES = ["40", "60", "90", "120", "180"];
/** fullscreen 滚轮步进行数预设。 */
export const SCROLL_STEP_LINES_VALUES = ["1", "2", "3", "5", "10"];
/** 完成响铃阈值（秒）预设；0 关闭。 */
export const COMPLETION_BELL_AFTER_SEC_VALUES = ["0", "10", "30", "60", "120"];
/** bash live 尾预览行数预设。 */
export const LIVE_TOOL_PREVIEW_LINES_VALUES = ["3", "5", "8", "12"];
/** Tools commonly toggled in excludeRenderers via the settings panel. */
export const EXCLUDE_RENDERER_CANDIDATES = [
	"bash",
	"read",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"webfetch",
	"wait",
];

export const DEFAULT_CONFIG: Config = {
	mode: "on",
	excludeRenderers: [],
	diffViewMode: DEFAULT_TOOL_DISPLAY_CONFIG.diffViewMode,
	diffIndicatorMode: DEFAULT_TOOL_DISPLAY_CONFIG.diffIndicatorMode,
	diffSplitMinWidth: DEFAULT_TOOL_DISPLAY_CONFIG.diffSplitMinWidth,
	editDiffCollapsedLines: DEFAULT_TOOL_DISPLAY_CONFIG.editDiffCollapsedLines,
	writeDiffCollapsedLines: DEFAULT_TOOL_DISPLAY_CONFIG.writeDiffCollapsedLines,
	diffWordWrap: DEFAULT_TOOL_DISPLAY_CONFIG.diffWordWrap,
	expandedPreviewMaxLines: DEFAULT_TOOL_DISPLAY_CONFIG.expandedPreviewMaxLines,
	expandedInputMaxLines: 5,
	expandedOutputMaxLines: 10,
	inputClip: 100,
	useSummaryTitlesAsThinkingTitle: true,
	previewLines: 3,
	animationIntervalMs: 90,
	thinkingExpandedMaxLines: 200,
	dimThinkingText: false,
	showStartupHeader: true,
	startupAnimation: true,
	quietStartup: true,
	scrollStepLines: 3,
	completionBellAfterSec: 0,
	liveToolPreview: true,
	liveToolPreviewLines: 5,
	enableSessionReference: true,
	enableSubagentAutocomplete: true,
	enableContextCommand: true,
	enableAgentSummary: true,
	enableWorkingMessage: true,
	enableAliases: true,
	enableImagePaster: true,
	enableClipboardPaste: true,
};

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return typeof value === "string" && (allowed as readonly string[]).includes(value)
		? (value as T)
		: fallback;
}

export function pickPositiveInt(value: unknown, fallback: number, min = 1, max = 100_000): number {
	const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, Math.floor(n)));
}

export function pickPositiveNumber(value: unknown, fallback: number, min = 1): number {
	const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	return Number.isFinite(n) ? Math.max(min, n) : fallback;
}

export function normalizeConfig(input: unknown): Config {
	const source = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
	const mode = pickEnum(source.mode, ["on", "compact", "off"], DEFAULT_CONFIG.mode);
	const excludeRenderers = Array.isArray(source.excludeRenderers)
		? [
				...new Set(
					source.excludeRenderers.filter(
						(name): name is string => typeof name === "string" && name.length > 0,
					),
				),
			]
		: [];
	return {
		mode,
		excludeRenderers,
		diffViewMode: pickEnum(source.diffViewMode, DIFF_VIEW_MODES, DEFAULT_CONFIG.diffViewMode),
		diffIndicatorMode: pickEnum(
			source.diffIndicatorMode,
			DIFF_INDICATOR_MODES,
			DEFAULT_CONFIG.diffIndicatorMode,
		),
		diffSplitMinWidth: pickPositiveInt(
			source.diffSplitMinWidth,
			DEFAULT_CONFIG.diffSplitMinWidth,
			40,
			300,
		),
		editDiffCollapsedLines: pickPositiveInt(
			source.editDiffCollapsedLines,
			DEFAULT_CONFIG.editDiffCollapsedLines,
			1,
			500,
		),
		writeDiffCollapsedLines: pickPositiveInt(
			source.writeDiffCollapsedLines,
			DEFAULT_CONFIG.writeDiffCollapsedLines,
			0,
			500,
		),
		diffWordWrap: source.diffWordWrap !== false,
		expandedPreviewMaxLines: pickPositiveInt(
			source.expandedPreviewMaxLines,
			DEFAULT_CONFIG.expandedPreviewMaxLines,
			10,
			50_000,
		),
		expandedInputMaxLines: pickPositiveInt(
			source.expandedInputMaxLines,
			DEFAULT_CONFIG.expandedInputMaxLines,
			1,
			5_000,
		),
		expandedOutputMaxLines: pickPositiveInt(
			source.expandedOutputMaxLines,
			DEFAULT_CONFIG.expandedOutputMaxLines,
			1,
			5_000,
		),
		inputClip: pickPositiveInt(source.inputClip, DEFAULT_CONFIG.inputClip, 8, 500),
		useSummaryTitlesAsThinkingTitle: source.useSummaryTitlesAsThinkingTitle !== false,
		previewLines: pickPositiveInt(
			source.previewLines,
			DEFAULT_CONFIG.previewLines,
			0,
			Number.MAX_SAFE_INTEGER,
		),
		animationIntervalMs: pickPositiveNumber(
			source.animationIntervalMs,
			DEFAULT_CONFIG.animationIntervalMs,
		),
		thinkingExpandedMaxLines: pickPositiveInt(
			source.thinkingExpandedMaxLines,
			DEFAULT_CONFIG.thinkingExpandedMaxLines,
			10,
			50_000,
		),
		dimThinkingText: source.dimThinkingText === true,
		showStartupHeader: source.showStartupHeader !== false,
		startupAnimation: source.startupAnimation !== false,
		quietStartup: source.quietStartup !== false,
		scrollStepLines: pickPositiveInt(source.scrollStepLines, DEFAULT_CONFIG.scrollStepLines, 1, 50),
		completionBellAfterSec: pickPositiveInt(
			source.completionBellAfterSec,
			DEFAULT_CONFIG.completionBellAfterSec,
			0,
			3600,
		),
		liveToolPreview: source.liveToolPreview !== false,
		liveToolPreviewLines: pickPositiveInt(
			source.liveToolPreviewLines,
			DEFAULT_CONFIG.liveToolPreviewLines,
			1,
			50,
		),
		enableSessionReference: source.enableSessionReference !== false,
		enableSubagentAutocomplete: source.enableSubagentAutocomplete !== false,
		enableContextCommand: source.enableContextCommand !== false,
		enableAgentSummary: source.enableAgentSummary !== false,
		enableWorkingMessage: source.enableWorkingMessage !== false,
		enableAliases: source.enableAliases !== false,
		enableImagePaster: source.enableImagePaster !== false,
		enableClipboardPaste: source.enableClipboardPaste !== false,
	};
}

export function getCompactThinkingConfig(source: Config = config): CompactThinkingConfig {
	return {
		useSummaryTitlesAsThinkingTitle: source.useSummaryTitlesAsThinkingTitle,
		previewLines: source.previewLines,
		animationIntervalMs: source.animationIntervalMs,
		thinkingExpandedMaxLines: source.thinkingExpandedMaxLines,
	};
}

export function getToolDisplayConfig(source: Config = config): ToolDisplayConfig {
	return {
		diffViewMode: source.diffViewMode,
		diffIndicatorMode: source.diffIndicatorMode,
		diffSplitMinWidth: source.diffSplitMinWidth,
		editDiffCollapsedLines: source.editDiffCollapsedLines,
		writeDiffCollapsedLines: source.writeDiffCollapsedLines,
		diffWordWrap: source.diffWordWrap,
		expandedPreviewMaxLines: source.expandedPreviewMaxLines,
	};
}

export function formatExcludeRenderers(names: readonly string[]): string {
	return names.length === 0 ? "none" : names.join(", ");
}

export function formatConfigStatus(source: Config = config): string {
	return [
		`mode=${source.mode}`,
		`exclude=[${source.excludeRenderers.join(", ") || "none"}]`,
		`diffView=${source.diffViewMode}`,
		`diffIndicator=${source.diffIndicatorMode}`,
		`diffSplitMin=${source.diffSplitMinWidth}`,
		`editCollapsed=${source.editDiffCollapsedLines}`,
		`writeCollapsed=${source.writeDiffCollapsedLines}`,
		`diffWordWrap=${source.diffWordWrap ? "on" : "off"}`,
		`expandedMax=${source.expandedPreviewMaxLines}`,
		`expandedInput=${source.expandedInputMaxLines}`,
		`expandedOutput=${source.expandedOutputMaxLines}`,
		`inputClip=${source.inputClip}`,
		`thinkingTitle=${source.useSummaryTitlesAsThinkingTitle ? "summary" : "default"}`,
		`thinkingPreview=${source.previewLines}`,
		`thinkingAnimation=${source.animationIntervalMs}ms`,
		`thinkingExpanded=${source.thinkingExpandedMaxLines}`,
		`thinkingDim=${source.dimThinkingText ? "on" : "off"}`,
		`startupHeader=${source.showStartupHeader ? "on" : "off"}`,
		`startupAnimation=${source.startupAnimation ? "on" : "off"}`,
		`quietStartup=${source.quietStartup ? "on" : "off"}`,
		`scrollStep=${source.scrollStepLines}`,
		`bellAfter=${source.completionBellAfterSec}s`,
		`sessionRef=${source.enableSessionReference ? "on" : "off"}`,
		`subagentAuto=${source.enableSubagentAutocomplete ? "on" : "off"}`,
		`context=${source.enableContextCommand ? "on" : "off"}`,
		`agentSummary=${source.enableAgentSummary ? "on" : "off"}`,
		`workingMsg=${source.enableWorkingMessage ? "on" : "off"}`,
		`aliases=${source.enableAliases ? "on" : "off"}`,
		`imagePaster=${source.enableImagePaster ? "on" : "off"}`,
		`clipboardPaste=${source.enableClipboardPaste ? "on" : "off"}`,
	].join(" · ");
}

/** 进程内唯一的活动配置对象。读取直接用 `config.xxx`；写入必须走 `updateConfig`。 */
export const config: Config = loadConfig();

/** 最近一次加载失败的原因（文件缺失不算）；供启动时 toast 一次，消费即清。 */
let lastConfigLoadError: string | null = null;

/** 取出并清空加载错误；无错误返回 null。 */
export function consumeConfigLoadError(): string | null {
	const error = lastConfigLoadError;
	lastConfigLoadError = null;
	return error;
}

function loadConfig(): Config {
	try {
		if (!existsSync(CONFIG_PATH)) return normalizeConfig({});
		try {
			return normalizeConfig(
				JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>,
			);
		} catch (error) {
			lastConfigLoadError = `claude-code-style.json 无法解析，已用默认配置：${error instanceof Error ? error.message : String(error)}`;
			return { ...DEFAULT_CONFIG };
		}
	} catch {
		// Ignore bad config and fall back to defaults.
	}
	return { ...DEFAULT_CONFIG };
}

export function saveConfig() {
	writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

/** 运行时配置写入的唯一入口：合并 + 规范化 + 持久化。 */
export function updateConfig(partial: Partial<Config>): void {
	Object.assign(config, normalizeConfig({ ...config, ...partial }));
	saveConfig();
}

/** 整体替换配置（default export 的 configOverride 注入路径；就地覆盖，不持久化）。 */
export function setConfig(next: Config): void {
	Object.assign(config, next);
}
