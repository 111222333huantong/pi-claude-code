import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type { CompactThinkingConfig } from "../feature/compact-thinking.ts";
import {
	DEFAULT_FOOTER_CHIP_LAYOUT,
	formatFooterChipSummary,
	normalizeFooterChipLayout,
} from "../feature/shell/footer-layout.ts";

export type CompactStyleMode = "on" | "compact" | "off";

export type DiffViewMode = "auto" | "split" | "unified";
export type DiffPaletteMode = "theme" | "claude";
export type DiffIndicatorMode = "bars" | "classic" | "none";
export type FooterGitStatsMode = "working" | "branch";
export type FooterTokenRateMode = "average" | "live";
export type ScrollButtonMode = "dock" | "native";

export interface ToolDisplayConfig {
	diffViewMode: DiffViewMode;
	diffIndicatorMode: DiffIndicatorMode;
	diffPalette: DiffPaletteMode;
	diffSplitMinWidth: number;
	/** Edit-only collapsed body lines. 0 = change counts and an expand hint. */
	editDiffCollapsedLines: number;
	/** Write-only collapsed body lines. 0 = `↳ created · click to show more`. */
	writeDiffCollapsedLines: number;
	diffWordWrap: boolean;
	expandedPreviewMaxLines: number;
}

export const DEFAULT_TOOL_DISPLAY_CONFIG: ToolDisplayConfig = {
	diffViewMode: "auto",
	diffIndicatorMode: "bars",
	diffPalette: "theme",
	diffSplitMinWidth: 120,
	/** Collapsed edit/diff body: ~half a typical terminal after chrome. */
	editDiffCollapsedLines: 24,
	/**
	 * Write create/overwrite collapsed body.
	 * 0 = `↳ created · click to show more` (stats stay on the title).
	 */
	writeDiffCollapsedLines: 0,
	diffWordWrap: true,
	/**
	 * Expanded TaskList body cap. Tool Input/Output and diffs use their own settings;
	 * an expanded diff always renders every line.
	 */
	expandedPreviewMaxLines: 40,
};

export type Config = {
	mode: CompactStyleMode;
	excludeRenderers: string[];
	diffViewMode: DiffViewMode;
	diffIndicatorMode: DiffIndicatorMode;
	diffPalette: DiffPaletteMode;
	diffSplitMinWidth: number;
	editDiffCollapsedLines: number;
	writeDiffCollapsedLines: number;
	diffWordWrap: boolean;
	expandedPreviewMaxLines: number;
	expandedInputMaxLines: number;
	expandedOutputMaxLines: number;
	toolLabelClip: number;
	useSummaryTitlesAsThinkingTitle: boolean;
	previewLines: number;
	animationIntervalMs: number;
	/** 展开中间态 tail 窗口行数；再推进一次才全文。 */
	thinkingExpandedMaxLines: number;
	showStartupHeader: boolean;
	startupAnimation: boolean;
	/** 启动头 slogan（空串关闭）；独立主题色，不跟随 logo/accent 以外文案。 */
	startupSlogan: string;
	startupSloganColor: ThemeColor;
	quietStartup: boolean;
	scrollStepLines: number;
	/** 回合耗时超过 N 秒完成时响铃（BEL）；0 关闭。 */
	completionBellAfterSec: number;
	/** bash 执行中/落定尾预览开关。 */
	liveToolPreview: boolean;
	/** bash 尾预览行数。 */
	liveToolPreviewLines: number;
	/** fullscreen：userMessage 正文首行滚出视口上沿后钉住，直到下一条指令接手。 */
	stickyUserMessage: boolean;
	/** fullscreen 回到底部按钮：扩展 dock 行，或 Pi 原生浮层；两者文案相同。 */
	scrollButtonMode: ScrollButtonMode;
	enableSessionReference: boolean;
	enableSubagentAutocomplete: boolean;
	enableContextCommand: boolean;
	enableAgentSummary: boolean;
	enableWorkingMessage: boolean;
	enableAliases: boolean;
	enableImagePaster: boolean;
	enablePathHyperlinks: boolean;
	enableClipboardPaste: boolean;
	enableEscSteer: boolean;
	enableDoubleEscClear: boolean;
	/** markdown 转换：Mermaid 方言渲染、圈数字转半角括号。关掉让位给其他扩展。 */
	enableMarkdownEnhance: boolean;
	/** 输入框 `❯ ` 前缀（占左侧 2 列，颜色随 thinking/bash mode 联动）。 */
	enableEditorPrefix: boolean;
	enableCustomFooter: boolean;
	/** footer 输出速率芯片。关则不显示。 */
	footerTokenRate: boolean;
	/** average：整段指令墙钟平均；live：最近 1 秒瞬时速率，空档回退平均。 */
	footerTokenRateMode: FooterTokenRateMode;
	/** 速率芯片是否带 TTFT。关则只显示速率。 */
	footerTokenRateTtft: boolean;
	/** ISO 4217 显示币种。USD 时不换算。 */
	footerCurrency: string;
	/** 1 单位费用对应的显示币种数量。null 只换符号、不乘倍率。 */
	footerCurrencyRate: number | null;
	footerNerdIcons: boolean;
	footerGitStatsMode: FooterGitStatsMode;
	footerHiddenKeys: string[];
	footerLine1Keys: string[];
	footerLine2Keys: string[];
	footerLine3Keys: string[];
};

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
export const CONFIG_PATH = join(AGENT_DIR, "pi-cc-extensions.json");
const LEGACY_CONFIG_PATH = join(AGENT_DIR, "claude-code-style.json");

export const DIFF_VIEW_MODES: DiffViewMode[] = ["auto", "split", "unified"];
export const DIFF_INDICATOR_MODES: DiffIndicatorMode[] = ["bars", "classic", "none"];
export const DIFF_PALETTE_MODES: DiffPaletteMode[] = ["theme", "claude"];
/** slogan 独立色候选：前景槽位，走 theme.fg。 */
export const STARTUP_SLOGAN_COLORS: ThemeColor[] = [
	"accent",
	"success",
	"warning",
	"error",
	"text",
	"muted",
];
/** slogan 最大长度（抄 pi-cc-header MAX_SLOGAN_LENGTH）。 */
export const MAX_STARTUP_SLOGAN_LENGTH = 250;
export const FOOTER_GIT_STATS_MODES: FooterGitStatsMode[] = ["working", "branch"];
export const FOOTER_TOKEN_RATE_MODES: FooterTokenRateMode[] = ["average", "live"];
export const SCROLL_BUTTON_MODES: ScrollButtonMode[] = ["dock", "native"];
export const DIFF_SPLIT_MIN_WIDTH_VALUES = ["80", "100", "120", "140", "160", "180"];
export const DIFF_COLLAPSED_LINES_VALUES = ["0", "12", "24", "36", "48", "80", "120"];
/** Write collapsed presets. 0 = stats only (`+N -0` + expand hint). */
export const WRITE_DIFF_COLLAPSED_LINES_VALUES = ["0", "4", "8", "12", "24", "36"];
/** Presets for expanded body height — keep low options first so cycling stays TUI-friendly. */
export const EXPANDED_PREVIEW_MAX_LINES_VALUES = ["40", "60", "80", "120", "200", "500", "2000"];
/** 展开工具卡 Input 可见行数预设。 */
export const EXPANDED_INPUT_MAX_LINES_VALUES = ["5", "10", "20", "40", "80"];
/** 展开工具卡 Output 可见行数预设。 */
export const EXPANDED_OUTPUT_MAX_LINES_VALUES = ["10", "20", "40", "80", "120"];
/** 工具摘要里 path/command 等输入的折叠字符数；0 = 只按可用宽度截断。 */
export const TOOL_LABEL_CLIP_VALUES = ["0", "40", "60", "80", "100", "120", "160"];
export const THINKING_PREVIEW_LINES_VALUES = ["0", "1", "3", "5", "10"];
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
	"powershell",
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
	diffPalette: "theme",
	diffSplitMinWidth: DEFAULT_TOOL_DISPLAY_CONFIG.diffSplitMinWidth,
	editDiffCollapsedLines: DEFAULT_TOOL_DISPLAY_CONFIG.editDiffCollapsedLines,
	writeDiffCollapsedLines: DEFAULT_TOOL_DISPLAY_CONFIG.writeDiffCollapsedLines,
	diffWordWrap: DEFAULT_TOOL_DISPLAY_CONFIG.diffWordWrap,
	expandedPreviewMaxLines: DEFAULT_TOOL_DISPLAY_CONFIG.expandedPreviewMaxLines,
	expandedInputMaxLines: 5,
	expandedOutputMaxLines: 10,
	toolLabelClip: 0,
	useSummaryTitlesAsThinkingTitle: true,
	previewLines: 3,
	animationIntervalMs: 90,
	thinkingExpandedMaxLines: 200,
	showStartupHeader: true,
	startupAnimation: true,
	startupSlogan: "",
	startupSloganColor: "accent",
	quietStartup: true,
	scrollStepLines: 3,
	completionBellAfterSec: 0,
	liveToolPreview: true,
	liveToolPreviewLines: 5,
	stickyUserMessage: true,
	scrollButtonMode: "dock",
	enableSessionReference: true,
	enableSubagentAutocomplete: true,
	enableContextCommand: true,
	enableAgentSummary: true,
	enableWorkingMessage: true,
	enableAliases: true,
	enableImagePaster: true,
	enablePathHyperlinks: false,
	enableClipboardPaste: true,
	enableEscSteer: true,
	enableDoubleEscClear: true,
	enableMarkdownEnhance: true,
	enableEditorPrefix: true,
	enableCustomFooter: true,
	footerTokenRate: true,
	footerTokenRateMode: "average",
	footerTokenRateTtft: true,
	footerCurrency: "USD",
	footerCurrencyRate: null,
	footerNerdIcons: true,
	footerGitStatsMode: "working",
	...DEFAULT_FOOTER_CHIP_LAYOUT,
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

/** toolLabelClip：0 表示按宽度自适应，其余夹到 8..500。 */
export function pickToolLabelClip(value: unknown): number {
	const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	return n === 0 ? 0 : pickPositiveInt(value, DEFAULT_CONFIG.toolLabelClip, 8, 500);
}

export function pickPositiveNumber(value: unknown, fallback: number, min = 1): number {
	const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	return Number.isFinite(n) ? Math.max(min, n) : fallback;
}

function normalizeCurrency(value: unknown): string {
	return typeof value === "string" && /^[A-Za-z]{3}$/.test(value.trim())
		? value.trim().toUpperCase()
		: "USD";
}

/** 缺失、空串、非正数都视为不换算。 */
function normalizeFooterCurrencyRate(value: unknown): number | null {
	if (value === undefined || value === null || value === "") return null;
	const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	return Number.isFinite(n) && n > 0 ? n : null;
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
		diffPalette: pickEnum(source.diffPalette, DIFF_PALETTE_MODES, DEFAULT_CONFIG.diffPalette),
		diffSplitMinWidth: pickPositiveInt(
			source.diffSplitMinWidth,
			DEFAULT_CONFIG.diffSplitMinWidth,
			40,
			300,
		),
		editDiffCollapsedLines: pickPositiveInt(
			source.editDiffCollapsedLines,
			DEFAULT_CONFIG.editDiffCollapsedLines,
			0,
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
		toolLabelClip: pickToolLabelClip(
			source.toolLabelClip ?? source.inputClip, // 兼容旧配置键
		),
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
		showStartupHeader: source.showStartupHeader !== false,
		startupAnimation: source.startupAnimation !== false,
		startupSlogan:
			typeof source.startupSlogan === "string"
				? source.startupSlogan.slice(0, MAX_STARTUP_SLOGAN_LENGTH)
				: "",
		startupSloganColor: pickEnum(
			source.startupSloganColor,
			STARTUP_SLOGAN_COLORS,
			DEFAULT_CONFIG.startupSloganColor,
		),
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
		stickyUserMessage: source.stickyUserMessage !== false,
		scrollButtonMode: pickEnum(
			source.scrollButtonMode,
			SCROLL_BUTTON_MODES,
			DEFAULT_CONFIG.scrollButtonMode,
		),
		enableSessionReference: source.enableSessionReference !== false,
		enableSubagentAutocomplete: source.enableSubagentAutocomplete !== false,
		enableContextCommand: source.enableContextCommand !== false,
		enableAgentSummary: source.enableAgentSummary !== false,
		enableWorkingMessage: source.enableWorkingMessage !== false,
		enableAliases: source.enableAliases !== false,
		enableImagePaster: source.enableImagePaster !== false,
		enablePathHyperlinks: source.enablePathHyperlinks === true,
		enableClipboardPaste: source.enableClipboardPaste !== false,
		enableEscSteer: source.enableEscSteer !== false,
		enableDoubleEscClear: source.enableDoubleEscClear !== false,
		enableMarkdownEnhance: source.enableMarkdownEnhance !== false,
		enableEditorPrefix: (source.enableEditorPrefix ?? source.enableInputPrompt) !== false, // 兼容旧配置键
		enableCustomFooter: source.enableCustomFooter !== false,
		footerTokenRate: source.footerTokenRate !== false,
		footerTokenRateMode: pickEnum(
			source.footerTokenRateMode,
			FOOTER_TOKEN_RATE_MODES,
			DEFAULT_CONFIG.footerTokenRateMode,
		),
		footerTokenRateTtft: source.footerTokenRateTtft !== false,
		footerCurrency: normalizeCurrency(source.footerCurrency),
		footerCurrencyRate: normalizeFooterCurrencyRate(source.footerCurrencyRate),
		footerNerdIcons: source.footerNerdIcons !== false,
		footerGitStatsMode: pickEnum(
			source.footerGitStatsMode,
			FOOTER_GIT_STATS_MODES,
			DEFAULT_CONFIG.footerGitStatsMode,
		),
		...normalizeFooterChipLayout(source),
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
		diffPalette: source.diffPalette,
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
		`diffPalette=${source.diffPalette}`,
		`diffSplitMin=${source.diffSplitMinWidth}`,
		`editCollapsed=${source.editDiffCollapsedLines}`,
		`writeCollapsed=${source.writeDiffCollapsedLines}`,
		`diffWordWrap=${source.diffWordWrap ? "on" : "off"}`,
		`expandedMax=${source.expandedPreviewMaxLines}`,
		`expandedInput=${source.expandedInputMaxLines}`,
		`expandedOutput=${source.expandedOutputMaxLines}`,
		`toolLabelClip=${source.toolLabelClip}`,
		`thinkingTitle=${source.useSummaryTitlesAsThinkingTitle ? "summary" : "default"}`,
		`thinkingPreview=${source.previewLines}`,
		`thinkingAnimation=${source.animationIntervalMs}ms`,
		`thinkingExpanded=${source.thinkingExpandedMaxLines}`,
		`startupHeader=${source.showStartupHeader ? "on" : "off"}`,
		`startupAnimation=${source.startupAnimation ? "on" : "off"}`,
		`startupSlogan=${source.startupSlogan ? `"${source.startupSlogan}"` : "off"}`,
		`quietStartup=${source.quietStartup ? "on" : "off"}`,
		`scrollStep=${source.scrollStepLines}`,
		`bellAfter=${source.completionBellAfterSec}s`,
		`stickyUserMessage=${source.stickyUserMessage ? "on" : "off"}`,
		`livePreview=${source.liveToolPreview ? `${source.liveToolPreviewLines} lines` : "off"}`,
		`scrollButton=${source.scrollButtonMode}`,
		`sessionRef=${source.enableSessionReference ? "on" : "off"}`,
		`subagentAuto=${source.enableSubagentAutocomplete ? "on" : "off"}`,
		`context=${source.enableContextCommand ? "on" : "off"}`,
		`agentSummary=${source.enableAgentSummary ? "on" : "off"}`,
		`workingMsg=${source.enableWorkingMessage ? "on" : "off"}`,
		`aliases=${source.enableAliases ? "on" : "off"}`,
		`imagePaster=${source.enableImagePaster ? "on" : "off"}`,
		`pathLinks=${source.enablePathHyperlinks ? "on" : "off"}`,
		`clipboardPaste=${source.enableClipboardPaste ? "on" : "off"}`,
		`escSteer=${source.enableEscSteer ? "on" : "off"}`,
		`doubleEscClear=${source.enableDoubleEscClear ? "on" : "off"}`,
		`markdownEnhance=${source.enableMarkdownEnhance ? "on" : "off"}`,
		`editorPrefix=${source.enableEditorPrefix ? "on" : "off"}`,
		`footer=${source.enableCustomFooter ? "on" : "off"}`,
		`footerTokenRate=${source.footerTokenRate ? "on" : "off"}`,
		`footerTokenRateMode=${source.footerTokenRateMode}`,
		`footerTokenRateTtft=${source.footerTokenRateTtft ? "on" : "off"}`,
		`footerCurrency=${source.footerCurrency}`,
		`footerRate=${source.footerCurrencyRate ?? "-"}`,
		`footerIcons=${source.footerNerdIcons ? "nerd" : "plain"}`,
		`footerGitStats=${source.footerGitStatsMode}`,
		formatFooterChipSummary(source),
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
		const fromLegacy = !existsSync(CONFIG_PATH) && existsSync(LEGACY_CONFIG_PATH);
		const rawPath = existsSync(CONFIG_PATH) ? CONFIG_PATH : fromLegacy ? LEGACY_CONFIG_PATH : null;
		if (!rawPath) return normalizeConfig({});
		try {
			const source = JSON.parse(readFileSync(rawPath, "utf8")) as Record<string, unknown>;
			const next = normalizeConfig(source);
			if (fromLegacy) {
				try {
					writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
					rmSync(LEGACY_CONFIG_PATH, { force: true });
				} catch {
					// 新路径写失败时仍使用已读到的旧配置，旧文件保留。
				}
			}
			return next;
		} catch (error) {
			const name = rawPath.split("/").pop() ?? rawPath;
			lastConfigLoadError = `${name} 无法解析，已用默认配置：${error instanceof Error ? error.message : String(error)}`;
			return { ...DEFAULT_CONFIG };
		}
	} catch {
		// Ignore bad config and fall back to defaults.
	}
	return { ...DEFAULT_CONFIG };
}

export function saveConfig() {
	// 原子写：先写 tmp 再 rename，崩溃不留半截配置文件（抄 pi-tool-display）。
	const text = JSON.stringify(config, null, 2);
	const tmp = `${CONFIG_PATH}.${process.pid}.tmp`;
	try {
		writeFileSync(tmp, text);
		renameSync(tmp, CONFIG_PATH);
	} catch {
		try {
			writeFileSync(CONFIG_PATH, text);
		} catch {
			// best effort：读侧已有损坏回退，此处不抛。
		}
	}
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
