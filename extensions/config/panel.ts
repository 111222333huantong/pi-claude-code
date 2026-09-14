/**
 * /ccstyle 配置面板 UI。
 *
 * 渲染副作用（applyStyleMode / refreshCurrentTranscript）由 renderer 经
 * CcstylePanelHooks 注入，避免 config → renderer 循环依赖。
 */
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Input, SettingsList, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { CompactThinkingController } from "../feature/compact-thinking.ts";
import { applyStartupHeader } from "../feature/shell/startup-header.ts";
import { createQuietStartupFile } from "../feature/shell/quiet-startup.ts";
import { readStatuslineConfig, writeStatuslineConfig } from "../feature/statusline/config.ts";
import type { ToolGroupingHooks } from "../renderer/tool/grouping.ts";
import {
	config,
	COMPLETION_BELL_AFTER_SEC_VALUES,
	DEFAULT_CONFIG,
	DIFF_COLLAPSED_LINES_VALUES,
	DIFF_INDICATOR_MODES,
	DIFF_SPLIT_MIN_WIDTH_VALUES,
	DIFF_VIEW_MODES,
	EXCLUDE_RENDERER_CANDIDATES,
	EXPANDED_INPUT_MAX_LINES_VALUES,
	EXPANDED_OUTPUT_MAX_LINES_VALUES,
	EXPANDED_PREVIEW_MAX_LINES_VALUES,
	formatExcludeRenderers,
	getCompactThinkingConfig,
	pickPositiveInt,
	pickPositiveNumber,
	SCROLL_STEP_LINES_VALUES,
	THINKING_ANIMATION_INTERVAL_VALUES,
	THINKING_EXPANDED_MAX_LINES_VALUES,
	THINKING_PREVIEW_LINES_VALUES,
	INPUT_CLIP_VALUES,
	LIVE_TOOL_PREVIEW_LINES_VALUES,
	WRITE_DIFF_COLLAPSED_LINES_VALUES,
	updateConfig,
	type CompactStyleMode,
	type Config,
	type DiffIndicatorMode,
	type DiffViewMode,
} from "./config.ts";

/** renderer 注入的渲染副作用，面板自身不触碰渲染状态。 */
export type CcstylePanelHooks = {
	applyStyleMode: (mode: CompactStyleMode, ctx: any, toolGrouping?: ToolGroupingHooks) => void;
	refreshCurrentTranscript: (ctx?: any, toolGrouping?: ToolGroupingHooks) => void;
};

function modeSettingDescription(mode: CompactStyleMode): string {
	if (mode === "compact") {
		return "(Experimental) One summary line per assistant round; edit/write reuse the same Diff preview settings as on.";
	}
	if (mode === "off") {
		return "Pi native tool rendering. Diff options below still apply independently.";
	}
	return "Claude Code style with rich edit/write diffs. Tune diff options below.";
}

function excludeRenderersDescription(names: readonly string[]): string {
	return names.length === 0
		? "No tools excluded. Agent always keeps its dedicated renderer. Enter to toggle common tools."
		: `Native renderer for: ${names.join(", ")}. Agent is always native. Enter to toggle.`;
}

function diffViewModeDescription(mode: DiffViewMode): string {
	if (mode === "split") return "Force side-by-side diff when width allows; otherwise unified.";
	if (mode === "unified") return "Always render a single unified diff column.";
	return "Auto: split when terminal is wide enough, otherwise unified.";
}

function diffIndicatorDescription(mode: DiffIndicatorMode): string {
	if (mode === "classic") return "Classic +/- gutters on changed lines.";
	if (mode === "none") return "No change indicators; rely on color alone.";
	return "Vertical bar indicators on changed lines (default).";
}

/** 额外功能开关项：on/off 二值，描述随状态切换；切换后需重启生效。 */
function featureToggleSetting(
	id: string,
	label: string,
	onDescription: string,
	offDescription: string,
	current: boolean,
) {
	const setting = {
		id,
		label,
		description: current ? onDescription : offDescription,
		currentValue: current ? "on" : "off",
		values: ["on", "off"],
	};
	return {
		setting,
		apply(on: boolean): void {
			setting.currentValue = on ? "on" : "off";
			setting.description = on ? onDescription : offDescription;
		},
	};
}

function buildExcludeRenderersSubmenu(
	onClose: () => void,
	onLiveChange: () => void,
): {
	render: (width: number) => string[];
	invalidate: () => void;
	handleInput: (data: string) => void;
} {
	const candidates = [
		...new Set([...EXCLUDE_RENDERER_CANDIDATES, ...config.excludeRenderers]),
	].sort((a, b) => a.localeCompare(b));
	const items = candidates.map((name) => ({
		id: name,
		label: name,
		description:
			name === "Agent"
				? "Agent always uses its dedicated renderer and cannot be forced through ccstyle."
				: `Use Pi native renderer for ${name} instead of Claude Code styling.`,
		currentValue: config.excludeRenderers.includes(name) ? "exclude" : "style",
		values: ["style", "exclude"],
	}));
	const list = new SettingsList(
		items,
		Math.min(8, Math.max(4, items.length)),
		getSettingsListTheme(),
		(id: string, value: string) => {
			const excluded = new Set(config.excludeRenderers);
			if (value === "exclude") excluded.add(id);
			else excluded.delete(id);
			updateConfig({ excludeRenderers: [...excluded].sort((a, b) => a.localeCompare(b)) });
			onLiveChange();
		},
		() => onClose(),
		{ enableSearch: candidates.length > 8 },
	);
	return {
		render: (width: number) => [
			...list.render(width),
			"",
			// Extra hint: Esc returns to the Style section list.
			truncateToWidth("  Esc back to Style settings", width),
		],
		invalidate: () => list.invalidate(),
		handleInput: (data: string) => list.handleInput(data),
	};
}

/** 数值项手动输入子面板：预填当前值，Space 循环预设，输入数字自定义，Enter 应用，Esc 取消。 */
function buildNumberInputSubmenu(
	theme: any,
	setting: { label: string; values: readonly string[]; currentValue: string },
	closeSubmenu: (selected?: string) => void,
): {
	render: (width: number) => string[];
	invalidate: () => void;
	handleInput: (data: string) => void;
} {
	const input = new Input();
	let error = "";
	input.setValue(setting.currentValue);
	input.onSubmit = (value: string) => {
		const raw = value.trim();
		if (raw === "") {
			closeSubmenu(); // 空输入 = 取消
			return;
		}
		if (!Number.isFinite(Number(raw))) {
			error = `Invalid number: "${raw}"`;
			return;
		}
		closeSubmenu(raw);
	};
	input.onEscape = () => closeSubmenu();
	return {
		render: (width: number) => {
			const safe = Math.max(0, Math.floor(width));
			const lines = [
				theme.fg("dim", `  ${setting.label} — custom value:`),
				...input.render(safe),
				truncateToWidth(theme.fg("dim", "  Enter to apply · Esc to go back"), safe),
			];
			if (error !== "") lines.push(theme.fg("dim", `  ${error}`));
			return lines;
		},
		invalidate: () => {},
		handleInput: (data: string) => input.handleInput(data),
	};
}

/** Section tabs for /ccstyle — matches Zentui-style "A / B / C" headers. */
type CcstyleSection = {
	id: "style" | "diff" | "thinking" | "ui" | "feature";
	label: string;
	items: any[];
};

function isForwardTabKey(data: string): boolean {
	return data === "\t" || matchesKey(data, "tab");
}

function isBackTabKey(data: string): boolean {
	// CSI Z is the common terminal encoding for Shift+Tab.
	return data === "\x1b[Z" || matchesKey(data, "shift+tab");
}

function renderPanelRule(theme: any, width: number): string {
	return theme.fg("dim", "─".repeat(Math.max(0, width)));
}

function renderSectionTabBar(
	theme: any,
	sections: readonly { label: string }[],
	activeIndex: number,
	width: number,
): string {
	const pieces: string[] = [];
	for (let i = 0; i < sections.length; i++) {
		if (i > 0) pieces.push(theme.fg("dim", " / "));
		const label = sections[i]?.label ?? "";
		pieces.push(
			i === activeIndex
				? theme.fg("text", typeof theme.bold === "function" ? theme.bold(label) : label)
				: theme.fg("dim", label),
		);
	}
	return truncateToWidth(pieces.join(""), Math.max(0, width));
}

export async function showCcstylePanel(
	ctx: any,
	hooks: CcstylePanelHooks,
	toolGrouping?: ToolGroupingHooks,
	compactThinking?: CompactThinkingController,
): Promise<void> {
	if (ctx?.mode !== "tui" || !ctx?.hasUI || typeof ctx.ui?.custom !== "function") {
		ctx.ui?.notify?.("/ccstyle requires TUI mode", "warning");
		return;
	}

	await ctx.ui.custom((tui: any, theme: any, _keybindings: any, done: () => void) => {
		const modeSetting = {
			id: "mode",
			label: "Mode",
			description: modeSettingDescription(config.mode),
			currentValue: config.mode === "compact" ? "compact (Experimental)" : config.mode,
			values: ["on", "compact (Experimental)", "off"],
		};
		// Tracks whether the Exclude-tools submenu is open so Tab switches sections
		// only at the top level (mirrors Zentui settings: Tab = switch sections).
		let excludeSubmenuOpen = false;
		const excludeSetting = {
			id: "excludeRenderers",
			label: "Exclude tools",
			description: excludeRenderersDescription(config.excludeRenderers),
			currentValue: formatExcludeRenderers(config.excludeRenderers),
			submenu: (_current: string, closeSubmenu: (selected?: string) => void) => {
				excludeSubmenuOpen = true;
				return buildExcludeRenderersSubmenu(
					() => {
						excludeSubmenuOpen = false;
						excludeSetting.currentValue = formatExcludeRenderers(config.excludeRenderers);
						excludeSetting.description = excludeRenderersDescription(config.excludeRenderers);
						closeSubmenu();
					},
					() => {
						excludeSetting.currentValue = formatExcludeRenderers(config.excludeRenderers);
						excludeSetting.description = excludeRenderersDescription(config.excludeRenderers);
						hooks.refreshCurrentTranscript(ctx);
					},
				);
			},
		};
		const inputClipSetting = {
			id: "inputClip",
			label: "Input clip",
			description:
				"Max columns for path/command/name in single and grouped tool summaries. Enter to type a custom value.",
			currentValue: String(config.inputClip),
			values: [...INPUT_CLIP_VALUES],
			submenu: (_current: string, closeSubmenu: (selected?: string) => void) =>
				buildNumberInputSubmenu(theme, inputClipSetting, closeSubmenu),
		};
		const diffViewSetting = {
			id: "diffViewMode",
			label: "Diff layout",
			description: diffViewModeDescription(config.diffViewMode),
			currentValue: config.diffViewMode,
			values: [...DIFF_VIEW_MODES],
		};
		const diffIndicatorSetting = {
			id: "diffIndicatorMode",
			label: "Diff indicator",
			description: diffIndicatorDescription(config.diffIndicatorMode),
			currentValue: config.diffIndicatorMode,
			values: [...DIFF_INDICATOR_MODES],
		};
		const diffSplitSetting = {
			id: "diffSplitMinWidth",
			label: "Split min width",
			description:
				"Minimum terminal width before auto/split layout uses side-by-side columns. Enter to type a custom value.",
			currentValue: String(config.diffSplitMinWidth),
			values: [...DIFF_SPLIT_MIN_WIDTH_VALUES],
			submenu: (_current: string, closeSubmenu: (selected?: string) => void) =>
				buildNumberInputSubmenu(theme, diffSplitSetting, closeSubmenu),
		};
		const diffCollapsedSetting = {
			id: "editDiffCollapsedLines",
			label: "Edit collapsed lines",
			description:
				"How many edit/diff body lines to show before the expand hint (Ctrl+O / click). Write uses its own setting below.",
			currentValue: String(config.editDiffCollapsedLines),
			values: [...DIFF_COLLAPSED_LINES_VALUES],
			submenu: (_current: string, closeSubmenu: (selected?: string) => void) =>
				buildNumberInputSubmenu(theme, diffCollapsedSetting, closeSubmenu),
		};
		const writeDiffCollapsedSetting = {
			id: "writeDiffCollapsedLines",
			label: "Write collapsed lines",
			description:
				"Write-only collapsed body lines. 0 shows ↳ created + expand hint (stats stay on the title). Enter to type a custom value.",
			currentValue: String(config.writeDiffCollapsedLines),
			values: [...WRITE_DIFF_COLLAPSED_LINES_VALUES],
			submenu: (_current: string, closeSubmenu: (selected?: string) => void) =>
				buildNumberInputSubmenu(theme, writeDiffCollapsedSetting, closeSubmenu),
		};
		const diffWordWrapSetting = {
			id: "diffWordWrap",
			label: "Diff word wrap",
			description: config.diffWordWrap
				? "Long diff lines wrap within the panel width."
				: "Long diff lines are truncated to the panel width.",
			currentValue: config.diffWordWrap ? "on" : "off",
			values: ["on", "off"],
		};
		const expandedInputSetting = {
			id: "expandedInputMaxLines",
			label: "Expanded input lines",
			description:
				"Max Input section lines in an expanded tool card. Overflow shows click to show more. Default 5.",
			currentValue: String(config.expandedInputMaxLines),
			values: [...EXPANDED_INPUT_MAX_LINES_VALUES],
			submenu: (_current: string, closeSubmenu: (selected?: string) => void) =>
				buildNumberInputSubmenu(theme, expandedInputSetting, closeSubmenu),
		};
		const expandedOutputSetting = {
			id: "expandedOutputMaxLines",
			label: "Expanded output lines",
			description:
				"Max Output section lines in an expanded tool card. Overflow shows click to show more. Default 10.",
			currentValue: String(config.expandedOutputMaxLines),
			values: [...EXPANDED_OUTPUT_MAX_LINES_VALUES],
			submenu: (_current: string, closeSubmenu: (selected?: string) => void) =>
				buildNumberInputSubmenu(theme, expandedOutputSetting, closeSubmenu),
		};
		const expandedMaxSetting = {
			id: "expandedPreviewMaxLines",
			label: "Expanded max lines",
			description:
				"Max diff/TaskList body lines when expanded. Tool Input/Output use the two settings above.",
			currentValue: String(config.expandedPreviewMaxLines),
			values: [...EXPANDED_PREVIEW_MAX_LINES_VALUES],
			submenu: (_current: string, closeSubmenu: (selected?: string) => void) =>
				buildNumberInputSubmenu(theme, expandedMaxSetting, closeSubmenu),
		};
		const thinkingTitleSetting = {
			id: "useSummaryTitlesAsThinkingTitle",
			label: "Summary title",
			description: "Use the latest provider summary as the active thinking title.",
			currentValue: config.useSummaryTitlesAsThinkingTitle ? "on" : "off",
			values: ["on", "off"],
		};
		const thinkingPreviewSetting = {
			id: "previewLines",
			label: "Preview lines",
			description: "Preview content lines (blank lines skipped); 0 hides the body.",
			currentValue: String(config.previewLines),
			values: [...THINKING_PREVIEW_LINES_VALUES],
			submenu: (_current: string, closeSubmenu: (selected?: string) => void) =>
				buildNumberInputSubmenu(theme, thinkingPreviewSetting, closeSubmenu),
		};
		const thinkingAnimationSetting = {
			id: "animationIntervalMs",
			label: "Animation interval ms",
			description: "Streaming refresh interval: duration tick and compact summary sweep.",
			currentValue: String(config.animationIntervalMs),
			values: [...THINKING_ANIMATION_INTERVAL_VALUES],
			submenu: (_current: string, closeSubmenu: (selected?: string) => void) =>
				buildNumberInputSubmenu(theme, thinkingAnimationSetting, closeSubmenu),
		};
		const thinkingExpandedSetting = {
			id: "thinkingExpandedMaxLines",
			label: "Expanded max lines",
			description:
				"Expanded thinking shows this many tail lines first; expand again for the full body.",
			currentValue: String(config.thinkingExpandedMaxLines),
			values: [...THINKING_EXPANDED_MAX_LINES_VALUES],
			submenu: (_current: string, closeSubmenu: (selected?: string) => void) =>
				buildNumberInputSubmenu(theme, thinkingExpandedSetting, closeSubmenu),
		};
		const thinkingDimSetting = {
			id: "dimThinkingText",
			label: "Dim thinking text",
			description: config.dimThinkingText
				? "Thinking text uses the theme's dim color."
				: "Keep the default thinking text color.",
			currentValue: config.dimThinkingText ? "on" : "off",
			values: ["on", "off"],
		};
		const startupHeaderSetting = {
			id: "showStartupHeader",
			label: "Startup header",
			description: config.showStartupHeader
				? "Show the custom startup header (mascot + tips + Loaded) on new sessions."
				: "Use Pi's native startup header instead.",
			currentValue: config.showStartupHeader ? "on" : "off",
			values: ["on", "off"],
		};
		const startupAnimationSetting = {
			id: "startupAnimation",
			label: "Header animation",
			description: config.startupAnimation
				? "Play the π mascot build-up once per process."
				: "Always show the settled mascot frame (also skips replay on /reload).",
			currentValue: config.startupAnimation ? "on" : "off",
			values: ["on", "off"],
		};
		const quietStartupSetting = {
			id: "quietStartup",
			label: "Quiet startup",
			description: config.quietStartup
				? "Hide Pi's native startup resource listing (header Loaded panel covers it). Next session applies."
				: "Keep Pi's native startup resource listing.",
			currentValue: config.quietStartup ? "on" : "off",
			values: ["on", "off"],
		};
		const scrollStepSetting = {
			id: "scrollStepLines",
			label: "Scroll step",
			description: "Mouse wheel scroll lines in fullscreen mode.",
			currentValue: String(config.scrollStepLines),
			values: [...SCROLL_STEP_LINES_VALUES],
			submenu: (_current: string, closeSubmenu: (selected?: string) => void) =>
				buildNumberInputSubmenu(theme, scrollStepSetting, closeSubmenu),
		};
		const completionBellSetting = {
			id: "completionBellAfterSec",
			label: "Completion bell",
			description:
				"Ring the terminal bell when a turn takes longer than N seconds. 0 disables. Enter to type a custom value.",
			currentValue: String(config.completionBellAfterSec),
			values: [...COMPLETION_BELL_AFTER_SEC_VALUES],
			submenu: (_current: string, closeSubmenu: (selected?: string) => void) =>
				buildNumberInputSubmenu(theme, completionBellSetting, closeSubmenu),
		};
		const livePreviewLinesSetting = {
			id: "liveToolPreviewLines",
			label: "Live preview lines",
			description: "Bash tail preview rows while running and after settle.",
			currentValue: String(config.liveToolPreviewLines),
			values: [...LIVE_TOOL_PREVIEW_LINES_VALUES],
			submenu: (_current: string, closeSubmenu: (selected?: string) => void) =>
				buildNumberInputSubmenu(theme, livePreviewLinesSetting, closeSubmenu),
		};

		// 额外功能开关：注册于扩展加载期，切换后需重启（/reload）生效。
		const sessionReferenceToggle = featureToggleSetting(
			"enableSessionReference",
			"Session reference",
			"@ session mentions search & inject referenced session context. Next restart applies.",
			"Session reference disabled.",
			config.enableSessionReference,
		);
		const subagentAutocompleteToggle = featureToggleSetting(
			"enableSubagentAutocomplete",
			"Subagent autocomplete",
			"@ subagent mentions suggest agents and inject delegation instructions. Next restart applies.",
			"Subagent autocomplete disabled.",
			config.enableSubagentAutocomplete,
		);
		const contextCommandToggle = featureToggleSetting(
			"enableContextCommand",
			"Context usage",
			"/context shows context-window distribution with previews. Next restart applies.",
			"Context command disabled.",
			config.enableContextCommand,
		);
		const agentSummaryToggle = featureToggleSetting(
			"enableAgentSummary",
			"Agent summary",
			"Append per-round tool stats after each agent turn. Next restart applies.",
			"Agent summary disabled.",
			config.enableAgentSummary,
		);
		const workingMessageToggle = featureToggleSetting(
			"enableWorkingMessage",
			"Working message",
			"Extend Working... footer with token count and elapsed time. Next restart applies.",
			"Native Working... footer only.",
			config.enableWorkingMessage,
		);
		const aliasesToggle = featureToggleSetting(
			"enableAliases",
			"Aliases",
			"/clear and /exit aliases enabled. Next restart applies.",
			"Aliases disabled.",
			config.enableAliases,
		);
		const imagePasterToggle = featureToggleSetting(
			"enableImagePaster",
			"Image paster",
			"Pasted/dropped image paths become first-class attachments. Next restart applies.",
			"Image paster disabled.",
			config.enableImagePaster,
		);
		const clipboardPasteToggle = featureToggleSetting(
			"enableClipboardPaste",
			"Clipboard paste",
			"Ctrl+V pastes clipboard images or text on Windows. Next restart applies.",
			"Clipboard paste disabled.",
			config.enableClipboardPaste,
		);
		const livePreviewToggle = featureToggleSetting(
			"liveToolPreview",
			"Live bash preview",
			"Show bash output tail while running and after settle. Next restart applies.",
			"Live bash preview disabled, Pending-only.",
			config.liveToolPreview,
		);
		const statuslineToggle = featureToggleSetting(
			"enableStatusline",
			"Statusline",
			"Two-line footer: model/ctx/cost/mcp/ext + cwd/git. Own statusline.json. Next restart applies.",
			"Statusline disabled, Pi native footer only.",
			readStatuslineConfig().enabled,
		);
		const featureToggles: Record<string, { apply: (on: boolean) => void }> = {
			enableSessionReference: sessionReferenceToggle,
			enableSubagentAutocomplete: subagentAutocompleteToggle,
			enableContextCommand: contextCommandToggle,
			enableAgentSummary: agentSummaryToggle,
			enableWorkingMessage: workingMessageToggle,
			enableAliases: aliasesToggle,
			enableImagePaster: imagePasterToggle,
			enableClipboardPaste: clipboardPasteToggle,
			liveToolPreview: livePreviewToggle,
		};

		const onSettingChange = (id: string, value: string) => {
			// 状态栏走独立 statusline.json，不进主配置。
			if (id === "enableStatusline") {
				writeStatuslineConfig({ enabled: value === "on" });
				statuslineToggle.apply(value === "on");
				ctx.ui.notify(`Updated enableStatusline: ${value} (next restart)`, "info");
				return;
			}
			// 额外功能开关：字段名与配置布尔字段一一对应，切换后重启生效。
			const featureToggle = featureToggles[id];
			if (featureToggle) {
				updateConfig({ [id]: value === "on" } as Partial<Config>);
				featureToggle.apply(value === "on");
				ctx.ui.notify(`Updated ${id}: ${value} (next restart)`, "info");
				return;
			}
			switch (id) {
				case "inputClip":
					updateConfig({
						inputClip: pickPositiveInt(value, DEFAULT_CONFIG.inputClip, 8, 500),
					});
					inputClipSetting.currentValue = String(config.inputClip);
					break;
				case "mode": {
					// 选项值带 Experimental 标记，选择后还原为真实 mode 值。
					const mode: CompactStyleMode =
						value === "compact (Experimental)" ? "compact" : (value as CompactStyleMode);
					modeSetting.description = modeSettingDescription(mode);
					hooks.applyStyleMode(mode, ctx, toolGrouping);
					return;
				}
				case "excludeRenderers":
					excludeSetting.currentValue = formatExcludeRenderers(config.excludeRenderers);
					excludeSetting.description = excludeRenderersDescription(config.excludeRenderers);
					return;
				case "diffViewMode":
					updateConfig({ diffViewMode: value as DiffViewMode });
					diffViewSetting.description = diffViewModeDescription(config.diffViewMode);
					break;
				case "diffIndicatorMode":
					updateConfig({ diffIndicatorMode: value as DiffIndicatorMode });
					diffIndicatorSetting.description = diffIndicatorDescription(config.diffIndicatorMode);
					break;
				case "diffSplitMinWidth":
					updateConfig({
						diffSplitMinWidth: pickPositiveInt(value, DEFAULT_CONFIG.diffSplitMinWidth, 40, 300),
					});
					diffSplitSetting.currentValue = String(config.diffSplitMinWidth);
					break;
				case "editDiffCollapsedLines":
					updateConfig({
						editDiffCollapsedLines: pickPositiveInt(
							value,
							DEFAULT_CONFIG.editDiffCollapsedLines,
							1,
							500,
						),
					});
					diffCollapsedSetting.currentValue = String(config.editDiffCollapsedLines);
					break;
				case "writeDiffCollapsedLines":
					updateConfig({
						writeDiffCollapsedLines: pickPositiveInt(
							value,
							DEFAULT_CONFIG.writeDiffCollapsedLines,
							0,
							500,
						),
					});
					writeDiffCollapsedSetting.currentValue = String(config.writeDiffCollapsedLines);
					break;
				case "diffWordWrap":
					updateConfig({ diffWordWrap: value === "on" });
					diffWordWrapSetting.description = config.diffWordWrap
						? "Long diff lines wrap within the panel width."
						: "Long diff lines are truncated to the panel width.";
					break;
				case "expandedInputMaxLines":
					updateConfig({
						expandedInputMaxLines: pickPositiveInt(
							value,
							DEFAULT_CONFIG.expandedInputMaxLines,
							1,
							5_000,
						),
					});
					expandedInputSetting.currentValue = String(config.expandedInputMaxLines);
					break;
				case "expandedOutputMaxLines":
					updateConfig({
						expandedOutputMaxLines: pickPositiveInt(
							value,
							DEFAULT_CONFIG.expandedOutputMaxLines,
							1,
							5_000,
						),
					});
					expandedOutputSetting.currentValue = String(config.expandedOutputMaxLines);
					break;
				case "expandedPreviewMaxLines":
					updateConfig({
						expandedPreviewMaxLines: pickPositiveInt(
							value,
							DEFAULT_CONFIG.expandedPreviewMaxLines,
							10,
							50_000,
						),
					});
					expandedMaxSetting.currentValue = String(config.expandedPreviewMaxLines);
					break;
				case "useSummaryTitlesAsThinkingTitle":
					updateConfig({ useSummaryTitlesAsThinkingTitle: value === "on" });
					break;
				case "previewLines":
					updateConfig({ previewLines: pickPositiveInt(value, DEFAULT_CONFIG.previewLines, 0) });
					thinkingPreviewSetting.currentValue = String(config.previewLines);
					break;
				case "animationIntervalMs":
					updateConfig({
						animationIntervalMs: pickPositiveNumber(value, DEFAULT_CONFIG.animationIntervalMs),
					});
					thinkingAnimationSetting.currentValue = String(config.animationIntervalMs);
					break;
				case "thinkingExpandedMaxLines":
					updateConfig({
						thinkingExpandedMaxLines: pickPositiveInt(
							value,
							DEFAULT_CONFIG.thinkingExpandedMaxLines,
							10,
							50_000,
						),
					});
					thinkingExpandedSetting.currentValue = String(config.thinkingExpandedMaxLines);
					break;
				case "dimThinkingText":
					updateConfig({ dimThinkingText: value === "on" });
					thinkingDimSetting.description = config.dimThinkingText
						? "Thinking text uses the theme's dim color."
						: "Keep the default thinking text color.";
					break;
				case "showStartupHeader":
					updateConfig({ showStartupHeader: value === "on" });
					startupHeaderSetting.description = config.showStartupHeader
						? "Show the custom startup header (mascot + tips + Loaded) on new sessions."
						: "Use Pi's native startup header instead.";
					// 实时切换：on → 自定义 header；off → 官方默认 header。
					applyStartupHeader(ctx);
					break;
				case "startupAnimation":
					updateConfig({ startupAnimation: value === "on" });
					startupAnimationSetting.description = config.startupAnimation
						? "Play the π mascot build-up once per process."
						: "Always show the settled mascot frame (also skips replay on /reload).";
					break;
				case "quietStartup": {
					const on = value === "on";
					updateConfig({ quietStartup: on });
					quietStartupSetting.description = on
						? "Hide Pi's native startup resource listing (header Loaded panel covers it). Next session applies."
						: "Keep Pi's native startup resource listing.";
					// 显式写入 Pi 自家配置（~/.pi/agent/settings.json），下会话生效。
					try {
						createQuietStartupFile().write(on);
					} catch {
						/* best effort */
					}
					break;
				}
				case "scrollStepLines":
					updateConfig({
						scrollStepLines: pickPositiveInt(value, DEFAULT_CONFIG.scrollStepLines, 1, 50),
					});
					scrollStepSetting.currentValue = String(config.scrollStepLines);
					break;
				case "completionBellAfterSec":
					updateConfig({
						completionBellAfterSec: pickPositiveInt(
							value,
							DEFAULT_CONFIG.completionBellAfterSec,
							0,
							3600,
						),
					});
					completionBellSetting.currentValue = String(config.completionBellAfterSec);
					break;
				case "liveToolPreviewLines":
					updateConfig({
						liveToolPreviewLines: pickPositiveInt(
							value,
							DEFAULT_CONFIG.liveToolPreviewLines,
							1,
							50,
						),
					});
					livePreviewLinesSetting.currentValue = String(config.liveToolPreviewLines);
					break;
				default:
					return;
			}
			compactThinking?.updateConfig(getCompactThinkingConfig());
			hooks.refreshCurrentTranscript(ctx);
			ctx.ui.notify(`Updated ${id}: ${value}`, "info");
		};

		const sections: CcstyleSection[] = [
			{
				id: "style",
				label: "Style",
				items: [modeSetting, excludeSetting],
			},
			{
				id: "diff",
				label: "Diff",
				items: [
					diffViewSetting,
					diffIndicatorSetting,
					diffSplitSetting,
					diffCollapsedSetting,
					writeDiffCollapsedSetting,
					diffWordWrapSetting,
				],
			},
			{
				id: "thinking",
				label: "Thinking",
				items: [
					thinkingTitleSetting,
					thinkingPreviewSetting,
					thinkingAnimationSetting,
					thinkingExpandedSetting,
					thinkingDimSetting,
				],
			},
			{
				id: "ui",
				label: "UI",
				items: [
					expandedInputSetting,
					expandedOutputSetting,
					expandedMaxSetting,
					inputClipSetting,
					startupHeaderSetting,
					startupAnimationSetting,
					quietStartupSetting,
					scrollStepSetting,
					completionBellSetting,
					livePreviewLinesSetting,
				],
			},
			{
				id: "feature",
				label: "Feature",
				items: [
					sessionReferenceToggle.setting,
					subagentAutocompleteToggle.setting,
					contextCommandToggle.setting,
					agentSummaryToggle.setting,
					workingMessageToggle.setting,
					aliasesToggle.setting,
					imagePasterToggle.setting,
					clipboardPasteToggle.setting,
					statuslineToggle.setting,
				],
			},
		];

		let activeSection = 0;
		const settingsTheme = getSettingsListTheme();
		const lists = sections.map(
			(section) =>
				new SettingsList(
					section.items,
					Math.min(8, Math.max(section.items.length, 1)),
					settingsTheme,
					onSettingChange,
					() => done(),
					{ enableSearch: false },
				),
		);

		const activeList = () => lists[activeSection]!;

		const switchSection = (delta: number) => {
			if (excludeSubmenuOpen) return;
			activeSection = (activeSection + delta + sections.length) % sections.length;
		};

		/** 数值项：当前选中项有 submenu + values 时，Space 仅循环预设，不打开子面板。 */
		const cyclePresetInList = (list: InstanceType<typeof SettingsList>): boolean => {
			const internal = list as unknown as {
				submenuComponent: unknown;
				items: {
					id: string;
					currentValue: string;
					submenu?: unknown;
					values?: readonly string[];
				}[];
				selectedIndex: number;
			};
			if (internal.submenuComponent) return false;
			const item = internal.items[internal.selectedIndex];
			if (!item?.submenu || !item.values?.length) return false;
			const i = item.values.indexOf(item.currentValue);
			item.currentValue = item.values[i === -1 ? 0 : (i + 1) % item.values.length]!;
			onSettingChange(item.id, item.currentValue);
			return true;
		};

		return {
			render(width: number): string[] {
				const safeWidth = Math.max(0, Math.floor(width));
				const rule = renderPanelRule(theme, safeWidth);
				const body = activeList().render(safeWidth);
				// Drop SettingsList's built-in hint — the panel footer below is the single source.
				while (body.length > 0 && body[body.length - 1] === "") body.pop();
				const listHintIndex = body.findIndex(
					(line) =>
						typeof line === "string" &&
						(line.includes("Enter/Space to change") || line.includes("Esc to cancel")),
				);
				const listBody = listHintIndex >= 0 ? body.slice(0, listHintIndex) : body;
				while (listBody.length > 0 && listBody[listBody.length - 1] === "") listBody.pop();

				// Frame: top rule · tabs · mid rule · settings · mid rule · footer · bottom rule
				return [
					rule,
					renderSectionTabBar(theme, sections, activeSection, safeWidth),
					rule,
					...listBody,
					rule,
					truncateToWidth(
						theme.fg(
							"dim",
							"  Enter/Space to change · Enter on numbers types a custom value · Tab/Shift+Tab to switch sections · Esc to close",
						),
						safeWidth,
					),
					rule,
				];
			},
			invalidate() {
				for (const list of lists) list.invalidate();
			},
			handleInput(data: string) {
				if (!excludeSubmenuOpen && isForwardTabKey(data)) {
					switchSection(1);
					tui.requestRender();
					return;
				}
				if (!excludeSubmenuOpen && isBackTabKey(data)) {
					switchSection(-1);
					tui.requestRender();
					return;
				}
				const list = activeList();
				// Space 循环预设（数值项不进子面板）；Enter 打开子面板输入自定义值。
				if (data === " " && cyclePresetInList(list)) {
					tui.requestRender();
					return;
				}
				list.handleInput?.(data);
				tui.requestRender();
			},
		};
	});
	// 面板卸下后主 transcript 重新挂载；再刷一次，吃掉打开期间扫树失败的切换。
	hooks.refreshCurrentTranscript(ctx, toolGrouping);
}
