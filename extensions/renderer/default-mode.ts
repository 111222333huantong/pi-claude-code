/**
 * default mode（config.mode === "on"）：Claude Code 风格工具卡渲染。
 *
 * 经 ToolExecutionComponent 原型补丁接管 call/result；edit/write 走 rich diff。
 * 生命周期对齐 compact-mode：installDefaultMode → hooks.shutdown。
 */
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type CompactStyleMode, config, getToolDisplayConfig } from "../config/config.ts";
import {
	COMPONENT_TOOL_RENDER_MODE,
	GLOBAL_TOOL_RENDER_PATCH,
	patchRegistry,
	TOOL_EXPANDED_BACKGROUND_PATCH,
} from "../utils/patch-keys.ts";
import { queuedToolGlyph, TOOL_GUTTER_WIDTH, toolStatusGlyph } from "../utils/tool-loading-icon.ts";
import { formatElapsedShort } from "../utils/tool-metrics.ts";
import { isToolCallHovered } from "./mouse/hover.ts";
import { BASH_LIVE_PREVIEW_LINES, bashLivePreview } from "./tool/bash-preview.ts";
import {
	buildStreamingWritePreview,
	countWriteDiffStats,
	STREAMING_WRITE_PREVIEW_LINES,
	STREAMING_WRITE_PREVIEW_LINES_EXPANDED,
} from "./tool/diff/diff-renderer.ts";
import { renderRichToolResult, type WriteExecutionMetadataStore } from "./tool/diff/index.ts";
import { renderPendingDiffPreview } from "./tool/diff/pending-preview.ts";
import { getMessageDisplayTheme } from "./tool/message-display.ts";
import {
	fitToolCallSummary,
	humanizeMcpToolName,
	humanizeToolLabel,
	isLikelyQuietCommand,
	toolCallSummary,
} from "./tool/names.ts";

/** humanizeMcpToolName 主实现在 names.ts；此处转出保对外签名不变。 */
export { humanizeMcpToolName };

import {
	classifyToolFailure,
	clearAnimation,
	countLines,
	failureSummaryText,
	hasExpandableDetail,
	insetComponent,
	isInMinDisplayWindow,
	isToolExpanded,
	MAX_ERROR_PREVIEW_LINES,
	outputLineCount,
	QUEUED_HINT_AFTER_MS,
	queuedHintVisible,
	renderCollapsedToolResultToWidth,
	renderExpandedToolResult,
	resolveToolActivityPhase,
	resolveToolVisualState,
	scheduleAnimation,
	scheduleQueuedHintRefresh,
	setToolVisualState,
	stampQueuedSince,
	textFromResult,
	toolIconColor,
	toolViewportWidth,
} from "./tool/result.ts";
import { showMoreHintText } from "./tool/show-more-hint.ts";

// 子代理派生工具自带专用渲染器（tintinweb 的 Agent / arhen 的 subagent），
// ccstyle 必须保留：派生计划图等多行体是单行摘要表达不了的。
const DEDICATED_RENDERER_TOOLS = new Set(["Agent", "subagent"]);

export type DefaultModeHooks = {
	/** 本安装是否仍持有全局工具渲染补丁。 */
	isOwner(): boolean;
	shutdown(): void;
};

type ToolRenderMethods = {
	hasRendererDefinition: (...args: any[]) => boolean;
	getRenderShell: (...args: any[]) => "default" | "self";
	getCallRenderer: (...args: any[]) => any;
	getResultRenderer: (...args: any[]) => any;
};

type GlobalToolRenderPatch = {
	version: 2;
	prototype: any;
	active: boolean;
	mode: () => CompactStyleMode;
	wrap: (tool: any) => any;
	byDefinition: WeakMap<object, any>;
	byName: Map<string, any>;
	downstream: ToolRenderMethods;
	installed: ToolRenderMethods;
};

type ToolExpandedBackgroundPatch = {
	active: boolean;
	prototype: any;
	installed: (...args: any[]) => void;
	original: (...args: any[]) => void;
	dispose: () => void;
};

export function shouldRenderRichDiff(
	mode: CompactStyleMode,
	toolName: string,
	isError: boolean,
): boolean {
	return mode === "on" && !isError && (toolName === "edit" || toolName === "write");
}

export function isMcpToolDefinition(definition: any, toolName: string): boolean {
	const label = typeof definition?.label === "string" ? definition.label.trim() : "";
	if (/^MCP(?::|$)/i.test(label)) return true;
	if (toolName === "mcp" || /^mcp[_:-]|[_:-]mcp[_:-]/i.test(toolName)) return true;
	if (label) return false;
	const description = typeof definition?.description === "string" ? definition.description : "";
	return /\bModel Context Protocol\b/i.test(description);
}

/** 排除名单内且自带 renderer 的工具保留原渲染。 */
export function preservesOriginalRenderer(
	extensionDefinition: any,
	toolName: string,
	builtInToolDefinition?: any,
	excludeRenderers: readonly string[] = config.excludeRenderers,
): boolean {
	if (!excludeRenderers.includes(toolName)) return false;
	return [extensionDefinition, builtInToolDefinition].some(
		(definition) =>
			definition?.renderShell === "self" ||
			typeof definition?.renderCall === "function" ||
			typeof definition?.renderResult === "function",
	);
}

function renderDefault(tool: any, slot: "renderCall" | "renderResult", args: any[], fallback = "") {
	try {
		if (typeof tool?.[slot] === "function") return tool[slot](...args);
	} catch {
		// Fall through to raw fallback.
	}
	return new Text(fallback, 0, 0);
}

type ParsedTask = { id: string; status: string; subject: string };

function parseTaskList(text: string): ParsedTask[] {
	return text
		.split("\n")
		.map((line) => line.match(/^#(\d+) \[([^\]]+)] (.+)$/))
		.filter((match): match is RegExpMatchArray => Boolean(match))
		.map((match) => ({ id: match[1]!, status: match[2]!, subject: match[3]! }));
}

function taskListSummary(tasks: ParsedTask[]): string {
	const counts = { pending: 0, in_progress: 0, completed: 0 };
	for (const task of tasks) {
		if (task.status in counts) counts[task.status as keyof typeof counts]++;
	}
	return [
		`${tasks.length} tasks`,
		counts.in_progress ? `${counts.in_progress} in progress` : "",
		counts.pending ? `${counts.pending} pending` : "",
		counts.completed ? `${counts.completed} completed` : "",
	]
		.filter(Boolean)
		.join(" • ");
}

function renderExpandedTaskResult(
	toolName: string,
	text: string,
	theme: any,
	isError: boolean,
): any | undefined {
	if (isError) return undefined;
	if (toolName === "TaskList") {
		const tasks = parseTaskList(text);
		if (!tasks.length) return undefined;
		const limit = Math.max(1, config.expandedPreviewMaxLines);
		const rows = tasks.slice(0, limit).map((task) => {
			const color =
				task.status === "completed"
					? "success"
					: task.status === "in_progress"
						? "warning"
						: "muted";
			return `${theme.fg("accent", `#${task.id}`)} ${theme.fg(color, task.status)} ${theme.fg("dim", task.subject)}`;
		});
		if (tasks.length > rows.length)
			rows.push(theme.fg("muted", `… ${tasks.length - rows.length} more tasks`));
		// 贴左：外层展开卡片 Box(1,1) 提供 1 格 padding
		return new Text(
			`↳ ${theme.fg("muted", taskListSummary(tasks))}\n${rows.map((r) => `  ${r}`).join("\n")}`,
			0,
			0,
		);
	}
	const line = text.trim();
	if (!line || line.includes("\n")) return undefined;
	let formatted: string | undefined;
	const createMatch =
		toolName === "TaskCreate" ? line.match(/^Task #(\d+) created successfully: (.+)$/) : null;
	const updateMatch = toolName === "TaskUpdate" ? line.match(/^Updated task #(\d+) (.+)$/) : null;
	if (createMatch) {
		formatted = `${theme.fg("success", "Created task")} ${theme.fg("accent", `#${createMatch[1]}`)} ${theme.fg("muted", createMatch[2])}`;
	} else if (updateMatch) {
		formatted = `${theme.fg("success", "Updated task")} ${theme.fg("accent", `#${updateMatch[1]}`)} ${theme.fg("muted", updateMatch[2])}`;
	} else if (toolName === "TaskExecute") {
		formatted = `${theme.fg("success", "Started")} ${theme.fg("muted", line)}`;
	} else if (toolName === "TaskStop") {
		formatted = `${theme.fg("success", "Stopped")} ${theme.fg("muted", line)}`;
	}
	return formatted ? new Text(`↳ ${formatted}`, 0, 0) : undefined;
}

/** bash live 尾预览正文：永远只有一个 `↳ `（首行锚点），其余行 4 空格缩进
 * 与 `…` 内容列对齐。折叠态经 insetComponent 后为 `   ↳ …` + `     …`。
 * 不够折叠时首行即第一行输出（如 `   ↳ hi`），与其他单行结果一致。 */
function bashLivePreviewBody(
	preview: { header: string | null; tail: string[] },
	theme: any,
	expanded: boolean,
): unknown {
	const rows = [
		...(preview.header ? [`↳ ${preview.header}`] : []),
		...preview.tail.map((line, index) =>
			index === 0 && preview.header == null ? `↳ ${line}` : `    ${line}`,
		),
	];
	const body = {
		render(innerWidth: number): string[] {
			const width = Math.max(1, innerWidth);
			return rows.map((line) => truncateToWidth(theme.fg("muted", line), width, ""));
		},
		invalidate() {},
	};
	return expanded ? body : insetComponent(body);
}

/** 用 ccstyle call/result 包装任意工具定义。 */
function createCcstyleTool(
	originalTool: any,
	writeExecutionMetadata: WriteExecutionMetadataStore,
): any {
	const toolName = originalTool.name;
	const label = isMcpToolDefinition(originalTool, toolName)
		? humanizeMcpToolName(toolName)
		: originalTool.label || toolName;

	return {
		...originalTool,
		renderShell: "self",
		renderCall(args: any, theme: any, context: any) {
			if (config.mode !== "on") {
				return renderDefault(originalTool, "renderCall", [args, theme, context], String(toolName));
			}

			const visualState = resolveToolVisualState(context);
			// 四态：queued（静态 dim 点，无动画）/ running / success / error。
			// 落定 700ms 内仍按 running 呈现（最小可读时长），防快工具一闪而过。
			const phase = resolveToolActivityPhase(context);
			const inMinWindow = isInMinDisplayWindow(context?.state);
			const displayRunning = phase === "running" || inMinWindow;
			const isQueued = !displayRunning && phase === "queued";
			// 动画只跟 running：排队行静态，不蹭共享 tick。
			if (displayRunning) scheduleAnimation(context);
			else clearAnimation(context);
			if (isQueued && context != null) {
				const queuedSince = stampQueuedSince(context);
				scheduleQueuedHintRefresh(context, QUEUED_HINT_AFTER_MS - (Date.now() - queuedSince));
			} else if (context?.state) {
				// 离开 queued 即清提示计时（单发定时器自带 unref，见 armStateTimer）。
				const queuedTimer = context.state.ccstyleQueuedHintTimer;
				if (queuedTimer !== undefined) {
					try {
						clearTimeout(queuedTimer);
					} catch {
						// ignore
					}
					context.state.ccstyleQueuedHintTimer = undefined;
				}
				if (context.state.ccstyleQueuedSince !== undefined) {
					context.state.ccstyleQueuedSince = undefined;
				}
			}
			const summary = toolCallSummary(toolName, args, {
				title: label === toolName ? humanizeToolLabel(label) : label,
				variant: "default",
				cwd: context?.cwd,
			});
			let writeStatsText = "";
			let writeStatsStyled = "";
			if (toolName === "write" && visualState === "success") {
				const meta = writeExecutionMetadata.get(context?.toolCallId);
				const stats = countWriteDiffStats(
					typeof args?.content === "string" ? args.content : undefined,
					meta?.previousContent,
					meta?.fileExistedBeforeWrite,
				);
				if (stats) {
					writeStatsText = ` (+${stats.added} -${stats.removed})`;
					writeStatsStyled = ` ${theme.fg("dim", "(")}${theme.fg("success", `+${stats.added}`)} ${theme.fg("error", `-${stats.removed}`)}${theme.fg("dim", ")")}`;
					// 落盘耗时 ≥1s 才缀标题（短写零噪音；元数据缺失时不显示）。
					const elapsed = formatElapsedShort(meta?.elapsedMs ?? 0);
					if (elapsed) {
						writeStatsText += ` ·${elapsed}`;
						writeStatsStyled += theme.fg("dim", ` ·${elapsed}`);
					}
				}
			}
			const extraText = writeStatsText || summary.detail;
			const extraStyled = writeStatsStyled || theme.fg("dim", summary.detail);
			// bash live 行数 + 执行耗时：只在执行中显示（落定同拍隐藏，
			// 仅 bash，避免改动 edit/write 标题）。
			const liveState = (context?.state ?? {}) as {
				_liveLineCount?: unknown;
				ccstylePendingSince?: unknown;
			};
			const showLive = toolName === "bash" && displayRunning && context?.executionStarted;
			const liveCountText =
				showLive && typeof liveState._liveLineCount === "number" && liveState._liveLineCount > 0
					? ` · ${liveState._liveLineCount} lines`
					: "";
			let liveElapsedText = "";
			if (showLive && typeof liveState.ccstylePendingSince === "number") {
				const elapsedSec = Math.max(
					0,
					Math.floor((Date.now() - liveState.ccstylePendingSince) / 1000),
				);
				if (elapsedSec > 0) liveElapsedText = ` · ${elapsedSec}s`;
			}
			const fullExtraText = `${extraText}${liveElapsedText}${liveCountText}`;
			const fullExtraStyled = `${extraStyled}${theme.fg("dim", liveElapsedText)}${theme.fg("dim", liveCountText)}`;
			let cachedWidth: number | undefined;
			let cachedBody: string | undefined;
			const expanded = Boolean(context?.expanded);
			return {
				render(width: number) {
					// 动画字形逐 paint 取新鲜值（墙钟推导），不进宽度缓存：
					// 否则 pending 标题的盲文冻在 renderCall 调用时刻，只随参数块跳动，
					// 肉眼就是走走停停（beat 日志 188/29/63ms 实锤）。正文截断仍缓存。
					// gutter 恒占 2 列（字形 1 + 空格 1），各状态同宽，标题不抖。
					// 状态亦逐 paint 重算：最小可读窗口结束即翻 ✓/✗，不等下一次 updateDisplay。
					const freshPhase = resolveToolActivityPhase(context);
					const freshRunning = freshPhase === "running" || isInMinDisplayWindow(context?.state);
					const freshQueued = !freshRunning && freshPhase === "queued";
					const freshColor = freshQueued ? "dim" : toolIconColor(context);
					const glyph = freshQueued
						? queuedToolGlyph()
						: freshRunning
							? toolStatusGlyph("running")
							: toolStatusGlyph(freshPhase === "error" ? "error" : "success");
					const liveIcon = theme.fg(freshColor, glyph);
					const viewportWidth = toolViewportWidth(width);
					// 展开态贴左（外层 Box 已 pad 1）；折叠 self-shell 保留 1 格前导空格
					const lead = expanded ? "" : " ";
					if (cachedBody === undefined || cachedWidth !== width) {
						cachedWidth = width;
						const callWidth = Math.max(0, viewportWidth - TOOL_GUTTER_WIDTH - (expanded ? 0 : 1));
						const mainWidth = Math.max(0, callWidth - visibleWidth(fullExtraText));
						// 路径按最终可用宽度中间截断，避免整行二次截断隐藏文件名。
						cachedBody = `${theme.fg("toolTitle", fitToolCallSummary(summary, mainWidth))}${fullExtraStyled}`;
					}
					const titleLine = truncateToWidth(`${lead}${liveIcon} ${cachedBody}`, viewportWidth, "");
					// write 参数流式行：renderResult 只有 result 存在才跑，参数流式阶段
					//（可长达几十秒）到不了；renderCall 跟 updateArgs 走，块到必调。
					// 与 result 侧用 argsComplete 互斥，不 double 显示。
					if (
						toolName === "write" &&
						(isQueued || displayRunning) &&
						context?.argsComplete !== true &&
						typeof args?.content === "string"
					) {
						const streamLead = expanded ? "↳ " : "   ↳ ";
						const preview = buildStreamingWritePreview(
							args.content,
							width,
							theme,
							"",
							streamLead,
							expanded ? STREAMING_WRITE_PREVIEW_LINES_EXPANDED : STREAMING_WRITE_PREVIEW_LINES,
						);
						if (preview) {
							const streamRows = expanded
								? [preview.head, ...preview.rows]
								: [preview.head, ...preview.rows.map((row) => ` ${row}`)];
							return [titleLine, ...streamRows];
						}
					}
					// 排队超 2s 且无流式预览可看时，挂 dim 的 Waiting… 第二行。
					if (isQueued && queuedHintVisible(context?.state)) {
						const hintLead = expanded ? "↳ " : "   ↳ ";
						return [titleLine, theme.fg("dim", `${hintLead}Waiting…`)];
					}
					return [titleLine];
				},
				invalidate() {},
			};
		},
		renderResult(result: any, options: any, theme: any, context: any) {
			if (config.mode !== "on") {
				return renderDefault(
					originalTool,
					"renderResult",
					[result, options, theme, context],
					textFromResult(result),
				);
			}

			const expanded = isToolExpanded(options, context);
			if (options?.isPartial) {
				// 流式态：running（executionStarted）才 braille 转圈 + 秒级耗时；
				// queued 排队行静态，不蹭共享 tick（标题行同理）。
				const running = Boolean(context?.executionStarted);
				const state = context != null ? (context.state ?? {}) : {};
				if (context != null) context.state = state;
				if (typeof state.ccstylePendingSince !== "number") state.ccstylePendingSince = Date.now();
				if (running) scheduleAnimation(context);
				else clearAnimation(context);
				const elapsedSec = Math.max(0, Math.floor((Date.now() - state.ccstylePendingSince) / 1000));
				const timing = elapsedSec > 0 ? ` · ${elapsedSec}s` : "";
				const lead = expanded ? "↳" : "   ↳";
				// edit/write 参数已完整时即显示内存投影 diff（预告片），不等落盘；
				// 投影失败（缺参/超限/不匹配）回落原 Pending 行。
				if (
					config.mode === "on" &&
					(toolName === "edit" || toolName === "write") &&
					context?.argsComplete === true &&
					!options?.isError &&
					!context?.isError
				) {
					const previewToolCallId = context?.toolCallId;
					const preview = renderPendingDiffPreview(toolName, context, {
						expanded,
						isHovered: () => isToolCallHovered(previewToolCallId),
						invalidate: () => context?.invalidate?.(),
						displayConfig: getToolDisplayConfig,
						theme,
					});
					if (preview) {
						// 单盲文规矩：头不带转圈（标题在转就够了）， timing 保留。
						const previewHead = theme.fg("muted", `${lead} Preview…${timing}`);
						const body = {
							render(innerWidth: number): string[] {
								return [previewHead, ...preview.render(innerWidth)];
							},
							invalidate() {
								preview.invalidate?.();
							},
						};
						return expanded ? body : insetComponent(body);
					}
				}
				// write 流式头预览（兜底）：参数已齐但预告片失败（缺文件/超限/不匹配）时，
				// 给 incoming 原文前 N 行。参数流式阶段走 renderCall（必经之路），
				// 这里只处理 argsComplete，与那边互斥，不 double 显示。
				// 轻量（只 split 前缀），块到即刷，不进 Myers/指纹/防抖。
				if (
					toolName === "write" &&
					context?.argsComplete === true &&
					typeof context?.args?.content === "string" &&
					!options?.isError &&
					!context?.isError
				) {
					const streamingArgs = context.args;
					const streamingBody = {
						render(innerWidth: number): string[] {
							const preview = buildStreamingWritePreview(
								streamingArgs.content,
								innerWidth,
								theme,
								timing,
								lead,
								expanded ? STREAMING_WRITE_PREVIEW_LINES_EXPANDED : STREAMING_WRITE_PREVIEW_LINES,
							);
							if (!preview) {
								if (!running) {
									return [theme.fg("dim", `${lead} ${queuedToolGlyph()} Queued…`)];
								}
								return [
									theme.fg("muted", `${lead} ${toolStatusGlyph("running")} Pending…${timing}`),
								];
							}
							return [preview.head, ...preview.rows];
						},
						invalidate() {},
					};
					return expanded ? streamingBody : insetComponent(streamingBody);
				}
				// bash live 尾预览：执行中取输出尾部窗口；空输出回落 Pending…。
				if (
					config.liveToolPreview !== false &&
					toolName === "bash" &&
					!options?.isError &&
					!context?.isError
				) {
					const liveLimit = Math.max(1, config.liveToolPreviewLines || BASH_LIVE_PREVIEW_LINES);
					const live = bashLivePreview(textFromResult(result), liveLimit);
					if (live.total > 0) {
						if (context != null) {
							const liveState = context.state ?? {};
							liveState._liveLineCount = live.total;
							context.state = liveState;
						}
						return bashLivePreviewBody(live, theme, expanded);
					}
				}
				// 展开态贴左（Box 提供 1 格 pad）；折叠态保持 3 格对齐标题
				// write 参数流式中已由 renderCall 展示头预览（updateArgs 必经），
				// result 侧回空行：不重复，不蹭第二个盲文。
				if (
					toolName === "write" &&
					typeof context?.args?.content === "string" &&
					context?.argsComplete !== true
				) {
					return new Text("", 0, 0);
				}
				// 排队态无预览可看时回静态 Queued…（dim，不转）；起跑后才 braille Pending…。
				if (!running) {
					const queued = `${lead} ${queuedToolGlyph()} Queued…`;
					return new Text(theme.fg("dim", queued), 0, 0);
				}
				const pending = `${lead} ${toolStatusGlyph("running")} Pending…${timing}`;
				return new Text(theme.fg("muted", pending), 0, 0);
			}

			const isError = options?.isError || context?.isError;
			setToolVisualState(context, isError ? "error" : "success");
			const toolCallId = context?.toolCallId;
			if (shouldRenderRichDiff(config.mode, toolName, Boolean(isError))) {
				// getter 保证 Diff indicator / wrap / limits 下次绘制即更新
				const richResult = renderRichToolResult(
					toolName,
					result,
					{
						...options,
						expanded,
						// 全局共享状态避免 /reload 后旧 result renderer 闭包失联
						isHovered: () => isToolCallHovered(toolCallId),
					},
					theme,
					context,
					writeExecutionMetadata,
					getToolDisplayConfig,
				);
				// 展开态由 Box(1,1) 提供内边距；折叠态 inset 一级缩进
				if (richResult) return expanded ? richResult : insetComponent(richResult);
			}

			const text = textFromResult(result, expanded);
			const args = context?.args;
			if (expanded) {
				const taskResult = renderExpandedTaskResult(toolName, text, theme, Boolean(isError));
				if (taskResult) return taskResult;
			}
			const tasks = !isError && toolName === "TaskList" ? parseTaskList(text) : [];
			const outputLines = outputLineCount(result) || countLines(text);
			const lineWord = outputLines === 1 ? "line" : "lines";
			const action = toolName === "read" ? "loaded" : "returned";
			// 失败三级分流：取消/拒绝/中断是用户动作（dim 短语），真错误归一化
			// 前缀 + 去 <error> 标签（红）。中断与 compact-mode 同词。
			const failureKind = isError && tasks.length === 0 ? classifyToolFailure(text) : undefined;
			const isUserHalt =
				failureKind === "cancelled" || failureKind === "rejected" || failureKind === "interrupted";
			const detailColor = isUserHalt ? "dim" : isError ? "error" : "muted";
			const rendered = tasks.length
				? taskListSummary(tasks)
				: isError
					? failureSummaryText(text)
					: outputLines
						? `${outputLines} ${lineWord} ${action}`
						: toolName === "bash" && isLikelyQuietCommand(args?.command)
							? "command completed (no output)"
							: "Done";
			const expandable = !expanded && (tasks.length > 0 || hasExpandableDetail(text, args));
			const hintText = showMoreHintText();
			const hintPrefix = expandable ? theme.fg("dim", " • ") : "";
			const hint = expandable ? hintPrefix + theme.fg("dim", hintText) : "";
			const hoveredHint = expandable ? hintPrefix + theme.fg("text", hintText) : "";
			if (expanded) {
				// 错误展开正文钳制到 MAX_ERROR_PREVIEW_LINES（默认 10，与配置默认值对齐），
				// 超限走 … +N more lines，不漫屏；正常输出仍尊重用户配置。
				const errorClamp = Boolean(isError);
				return renderExpandedToolResult(
					text || "",
					theme,
					Boolean(isError),
					context?.lastComponent,
					args,
					context,
					true, // mode=on：贴左，由外层 Box(1,1) 提供 1 格 padding
					errorClamp ? Math.min(config.expandedOutputMaxLines, MAX_ERROR_PREVIEW_LINES) : undefined,
					undefined,
				);
			}
			if (context?.state) context.state.ccstyleIoView = undefined;
			let cachedWidth: number | undefined;
			let cachedLine: string | undefined;
			let cachedHoveredLine: string | undefined;
			return {
				render(width: number) {
					if (cachedLine === undefined || cachedWidth !== width) {
						cachedWidth = width;
						cachedLine = theme.fg(
							detailColor,
							renderCollapsedToolResultToWidth(rendered, hint, width),
						);
						cachedHoveredLine = theme.fg(
							detailColor,
							renderCollapsedToolResultToWidth(rendered, hoveredHint, width),
						);
					}
					return [isToolCallHovered(toolCallId) ? cachedHoveredLine! : cachedLine];
				},
				invalidate() {},
			};
		},
	};
}

function syncToolShell(component: any, shell: "default" | "self"): void {
	const target = shell === "self" ? component.selfRenderContainer : component.contentBox;
	if (!target || !Array.isArray(component.children)) return;
	const candidates = new Set(
		[component.contentText, component.contentBox, component.selfRenderContainer].filter(Boolean),
	);
	const indexes = component.children
		.map((child: any, index: number) => (candidates.has(child) ? index : -1))
		.filter((index: number) => index >= 0);
	const targetIndex = indexes[0];
	// 构造期 getRenderShell 先于 Pi 挂载 shell；此处勿挂载，否则构造器会二次添加。
	if (targetIndex === undefined) return;
	component.children[targetIndex] = target;
	for (const index of indexes.sort((left: number, right: number) => right - left)) {
		if (index !== targetIndex) component.children.splice(index, 1);
	}
}

function shouldGloballyStyleTool(component: any, patch: GlobalToolRenderPatch): boolean {
	const extensionDefinition = component.toolDefinition;
	const builtInDefinition = component.builtInToolDefinition;
	const definition = extensionDefinition ?? builtInDefinition;
	const toolName = String(component.toolName || definition?.name || "");
	const useCcstyle =
		patch.mode() === "on" &&
		!DEDICATED_RENDERER_TOOLS.has(toolName) &&
		!preservesOriginalRenderer(extensionDefinition, toolName, builtInDefinition);
	component[COMPONENT_TOOL_RENDER_MODE] = useCcstyle;
	return useCcstyle;
}

function getGloballyStyledTool(component: any, patch: GlobalToolRenderPatch): any {
	const definition = component.toolDefinition ?? component.builtInToolDefinition;
	if (definition && typeof definition === "object") {
		let wrapped = patch.byDefinition.get(definition);
		if (!wrapped) {
			wrapped = patch.wrap(definition);
			patch.byDefinition.set(definition, wrapped);
		}
		return wrapped;
	}

	const name = String(component.toolName || "tool");
	let wrapped = patch.byName.get(name);
	if (!wrapped) {
		wrapped = patch.wrap({ name, label: name });
		patch.byName.set(name, wrapped);
	}
	return wrapped;
}

function prototypeToolRenderMethods(prototype: any): ToolRenderMethods {
	return {
		hasRendererDefinition: prototype.hasRendererDefinition,
		getRenderShell: prototype.getRenderShell,
		getCallRenderer: prototype.getCallRenderer,
		getResultRenderer: prototype.getResultRenderer,
	};
}

function isOwnershipAwarePatch(value: any): value is GlobalToolRenderPatch {
	if (value?.version !== 2 || !value?.installed || !value?.downstream) return false;
	return ["hasRendererDefinition", "getRenderShell", "getCallRenderer", "getResultRenderer"].every(
		(name) =>
			typeof value.installed[name] === "function" && typeof value.downstream[name] === "function",
	);
}

function downstreamForGlobalToolInstall(
	prototype: any,
	previous: GlobalToolRenderPatch | undefined,
): ToolRenderMethods {
	const current = prototypeToolRenderMethods(prototype);
	if (!previous || previous.prototype !== prototype || !isOwnershipAwarePatch(previous)) {
		return current;
	}
	return {
		hasRendererDefinition:
			current.hasRendererDefinition === previous.installed.hasRendererDefinition
				? previous.downstream.hasRendererDefinition
				: current.hasRendererDefinition,
		getRenderShell:
			current.getRenderShell === previous.installed.getRenderShell
				? previous.downstream.getRenderShell
				: current.getRenderShell,
		getCallRenderer:
			current.getCallRenderer === previous.installed.getCallRenderer
				? previous.downstream.getCallRenderer
				: current.getCallRenderer,
		getResultRenderer:
			current.getResultRenderer === previous.installed.getResultRenderer
				? previous.downstream.getResultRenderer
				: current.getResultRenderer,
	};
}

function disconnectGlobalToolRenderPatch(patch: GlobalToolRenderPatch | undefined): void {
	if (!patch) return;
	patch.active = false;
	patch.byDefinition = new WeakMap();
	patch.byName.clear();
}

function installGlobalToolRendering(
	writeExecutionMetadata: WriteExecutionMetadataStore,
): GlobalToolRenderPatch {
	const prototype = (ToolExecutionComponent as any).prototype;
	const previous = patchRegistry.get<GlobalToolRenderPatch>(GLOBAL_TOOL_RENDER_PATCH);
	const downstream = downstreamForGlobalToolInstall(prototype, previous);
	if (isOwnershipAwarePatch(previous)) disconnectGlobalToolRenderPatch(previous);

	const patch: GlobalToolRenderPatch = {
		version: 2,
		prototype,
		active: true,
		mode: () => config.mode,
		wrap: (tool: any) => createCcstyleTool(tool, writeExecutionMetadata),
		byDefinition: new WeakMap(),
		byName: new Map(),
		downstream,
		installed: undefined as any,
	};

	patch.installed = {
		hasRendererDefinition: function (this: any, ...args: any[]) {
			if (patch.active && shouldGloballyStyleTool(this, patch)) return true;
			return patch.downstream.hasRendererDefinition.apply(this, args);
		},
		getRenderShell: function (this: any, ...args: any[]) {
			if (!patch.active) return patch.downstream.getRenderShell.apply(this, args);
			const useCcstyle = shouldGloballyStyleTool(this, patch);
			const shell = useCcstyle
				? this.expanded
					? "default"
					: "self"
				: patch.downstream.getRenderShell.apply(this, args);
			syncToolShell(this, shell);
			return shell;
		},
		getCallRenderer: function (this: any, ...args: any[]) {
			if (patch.active && shouldGloballyStyleTool(this, patch)) {
				return getGloballyStyledTool(this, patch).renderCall;
			}
			return patch.downstream.getCallRenderer.apply(this, args);
		},
		getResultRenderer: function (this: any, ...args: any[]) {
			if (patch.active && shouldGloballyStyleTool(this, patch)) {
				return getGloballyStyledTool(this, patch).renderResult;
			}
			return patch.downstream.getResultRenderer.apply(this, args);
		},
	};

	prototype.hasRendererDefinition = patch.installed.hasRendererDefinition;
	prototype.getRenderShell = patch.installed.getRenderShell;
	prototype.getCallRenderer = patch.installed.getCallRenderer;
	prototype.getResultRenderer = patch.installed.getResultRenderer;
	patchRegistry.install(GLOBAL_TOOL_RENDER_PATCH, patch);
	return patch;
}

function deactivateGlobalToolRendering(patch: GlobalToolRenderPatch): void {
	if (!patch.active) return;
	disconnectGlobalToolRenderPatch(patch);
	const prototype = patch.prototype;
	if (prototype.hasRendererDefinition === patch.installed.hasRendererDefinition) {
		prototype.hasRendererDefinition = patch.downstream.hasRendererDefinition;
	}
	if (prototype.getRenderShell === patch.installed.getRenderShell) {
		prototype.getRenderShell = patch.downstream.getRenderShell;
	}
	if (prototype.getCallRenderer === patch.installed.getCallRenderer) {
		prototype.getCallRenderer = patch.downstream.getCallRenderer;
	}
	if (prototype.getResultRenderer === patch.installed.getResultRenderer) {
		prototype.getResultRenderer = patch.downstream.getResultRenderer;
	}
}

/** 展开面板背景统一为 user message 背景色；折叠行保持原生状态色。
 *  必须在 compact-mode 之后安装，shutdown 时先于 compact-mode 释放。 */
export function installToolExpandedBackground(): () => void {
	const previous = patchRegistry.get<ToolExpandedBackgroundPatch>(TOOL_EXPANDED_BACKGROUND_PATCH);
	if (previous) previous.dispose();
	const prototype = ToolExecutionComponent.prototype as unknown as { updateDisplay: () => void };
	const original = prototype.updateDisplay;
	const patch: ToolExpandedBackgroundPatch = {
		active: true,
		prototype,
		installed: function (this: any) {
			original.call(this);
			if (!patch.active || config.mode !== "on" || !this.expanded) return;
			// Agent/subagent tools render their own tree structure — skip ccstyle background.
			const toolName = String(this.toolName ?? this.toolDefinition?.name ?? "");
			if (DEDICATED_RENDERER_TOOLS.has(toolName)) {
				// contentBox is a Box (has setBgFn); selfRenderContainer is a Container (no setBgFn).
				if (this.contentBox?.setBgFn) this.contentBox.setBgFn(undefined);
				return;
			}
			const theme = getMessageDisplayTheme();
			if (!theme?.bg) return;
			const box = this.contentBox;
			// 展开最外层卡片：上下左右内间距 1 格
			if (box) {
				box.paddingX = 1;
				box.paddingY = 1;
				if (box.setBgFn) box.setBgFn((text: string) => theme.bg("userMessageBg", text));
			}
		},
		original,
		dispose: () => {
			patch.active = false;
			if (prototype.updateDisplay === patch.installed) {
				prototype.updateDisplay = original;
			}
			patchRegistry.dispose(TOOL_EXPANDED_BACKGROUND_PATCH, patch);
		},
	};
	prototype.updateDisplay = patch.installed;
	patchRegistry.install(TOOL_EXPANDED_BACKGROUND_PATCH, patch);
	return patch.dispose;
}

/** 安装 default mode 全局工具渲染补丁（不含展开背景，见 installToolExpandedBackground）。 */
export function installDefaultMode(
	writeExecutionMetadata: WriteExecutionMetadataStore,
): DefaultModeHooks {
	const globalToolRendering = installGlobalToolRendering(writeExecutionMetadata);
	return {
		isOwner() {
			return (
				patchRegistry.owns(GLOBAL_TOOL_RENDER_PATCH, globalToolRendering) &&
				globalToolRendering.active
			);
		},
		shutdown() {
			deactivateGlobalToolRendering(globalToolRendering);
		},
	};
}
