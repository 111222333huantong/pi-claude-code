/**
 * Compact 的 edit/write 行与 rich diff 绘制。
 *
 * 从 compact-mode.ts 抽出：标题行、折叠/展开复用 mode=on 的 rich diff，
 * 已完成结果跨帧缓存；pending 不缓存，避免 loader 动画冻住。
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getToolDisplayConfig } from "../config/config.ts";
import { pendingDotColor, toolLoadingIcon } from "../utils/tool-loading-icon.ts";
import { formatElapsedShort } from "../utils/tool-metrics.ts";
import { sanitizeToolResultText } from "../utils/tool-result-sanitize.ts";
import { editWriteExpandedCard, themeOf } from "./compact-card.ts";
import { isToolCallHovered } from "./mouse/hover.ts";
import { styleChangeCounts } from "./tool/ccstyle-tool.ts";
import { displayConfigCacheKey } from "./tool/diff/diff-component.ts";
import {
	countEditDiffStats,
	countWriteDiffStats,
	isRichDiffComponent,
} from "./tool/diff/diff-renderer.ts";
import {
	buildStreamingWritePreview,
	renderRichToolResult,
	STREAMING_WRITE_PREVIEW_LINES,
} from "./tool/diff/index.ts";
import type { WriteExecutionMetadataStore } from "./tool/diff/write-execution.ts";
import { formatDisplayPath, showMoreHintText } from "./tool/names.ts";
import { expandedBodyComponent, insetComponent } from "./tool/result.ts";
import { renderExpandedToolResult } from "./tool/tool-io.ts";
import { toolCardBgSlot } from "./tool/tool-state.ts";

function compactEditWriteLine(
	component: any,
	width: number,
	writeMetadata?: WriteExecutionMetadataStore,
	options: { hint?: boolean; flushLeft?: boolean; showStats?: boolean } = {},
): string[] {
	const theme = themeOf();
	const name = String(component.toolName ?? "tool");
	const args = component.args ?? {};
	const path =
		typeof args.path === "string" && args.path
			? args.path
			: typeof args.file_path === "string" && args.file_path
				? args.file_path
				: "";
	const isError = component.result?.isError === true;
	const isPending = !component.result || component.isPartial === true;
	const icon = isError ? "✗" : isPending ? toolLoadingIcon() : "✓";
	// 执行中呼吸（accent↔dim，由共享 tick/回合 tick 驱动重绘）；排队未起跑保持 accent 常亮。
	const isRunning = isPending && Boolean(component?.executionStarted);
	const iconColor = isError
		? "error"
		: isPending
			? isRunning
				? pendingDotColor()
				: "accent"
			: "success";
	let statsText = "";
	let statsStyled = "";
	// 统计只显示一处：正文自带 +A -D 时标题不再重复（showStats=false）。
	if (!isError && !isPending && options.showStats !== false) {
		const writeMeta = name === "write" ? writeMetadata?.get(component.toolCallId) : undefined;
		const stats =
			name === "edit"
				? countEditDiffStats(component.result?.details)
				: name === "write"
					? countWriteDiffStats(
							typeof args.content === "string" ? args.content : undefined,
							writeMeta?.previousContent,
							writeMeta?.fileExistedBeforeWrite,
						)
					: undefined;
		if (stats) {
			const counts = styleChangeCounts(
				(color, text) => theme.fg(color, text),
				stats.added,
				stats.removed,
			);
			statsText = counts.text;
			statsStyled = counts.styled;
			const elapsed = formatElapsedShort(writeMeta?.elapsedMs ?? 0);
			if (elapsed) {
				statsText += ` ·${elapsed}`;
				statsStyled += theme.fg("dim", ` ·${elapsed}`);
			}
		}
	}
	// 展开卡 Box(1,1) 已 pad；折叠行自己留 1 格前导空格
	const iconPart = `${options.flushLeft ? "" : " "}${theme.fg(iconColor, icon)} `;
	const namePart = theme.fg("toolTitle", name);
	const clickable = options.hint !== false && component.expanded !== true;
	const clickText = clickable ? showMoreHintText() : "";
	const hintText = clickable ? ` · ${clickText}` : "";
	const fixedWidth =
		visibleWidth(iconPart) +
		visibleWidth(namePart) +
		visibleWidth(statsText) +
		visibleWidth(hintText);
	const pathWidth = Math.max(0, width - fixedWidth - (path ? 1 : 0));
	const pathPart =
		pathWidth > 0 && path ? ` ${formatDisplayPath(path, component.cwd, pathWidth)}` : "";
	// 圆点保持 dim；hover 只高亮可点击文字，与 compact 摘要行一致
	const hintPart = clickable
		? `${theme.fg("dim", " · ")}${theme.fg(isToolCallHovered(component.toolCallId) ? "text" : "dim", clickText)}`
		: "";
	const line = `${iconPart}${namePart}${theme.fg("muted", pathPart)}${statsStyled}${hintPart}`;
	return ["", truncateToWidth(line, width, "")];
}

/** 正文自带 +A -D 的声明：diff 组件自报，折叠行数/宽度这些细节由它自己判断。 */
function richDiffBodyShowsStats(component: unknown): boolean {
	const probe = (component as { bodyShowsStats?: () => boolean } | undefined)?.bodyShowsStats;
	return typeof probe === "function" && probe.call(component) === true;
}

/** expanded 写进 rich diff 闭包，折叠/展开分槽缓存，避免每帧 parseDiff。 */
const compactRichDiffCache = new WeakMap<
	object,
	{ result: unknown; collapsed?: unknown; expanded?: unknown }
>();

type CompactEditPaintHit = {
	width: number;
	theme: unknown;
	/** 展开卡的背景槽位同样参与命中判断。 */
	bgSlot: string;
	diffConfigKey: string;
	expanded: boolean;
	result: unknown;
	isPartial: boolean;
	args: unknown;
	hover: boolean;
	ioHover: unknown;
	lines: string[];
};
const compactEditPaintCache = new WeakMap<object, CompactEditPaintHit>();

function compactEditIoHover(component: any): unknown {
	const view = component?.resultRendererComponent;
	return typeof view?.getHoveredSection === "function" ? view.getHoveredSection() : null;
}

/**
 * compact edit/write：标题行 + mode=on 同一套 rich diff。
 * 折叠/展开都走 `renderRichToolResult`，limits 不另开一套。
 * 已完成的结果跨帧复用行；pending 不缓存，避免 loader 动画冻住。
 */
export function compactEditWriteLines(
	component: any,
	width: number,
	writeMetadata?: WriteExecutionMetadataStore,
): string[] {
	const expanded = component.expanded === true;
	const isPartial = component.isPartial === true;
	const pending = !component.result || isPartial;
	const hover = isToolCallHovered(component.toolCallId);
	const ioHover = compactEditIoHover(component);
	const theme = themeOf();
	const diffConfigKey = displayConfigCacheKey(getToolDisplayConfig());
	if (!pending) {
		const hit = compactEditPaintCache.get(component);
		if (
			hit &&
			hit.width === width &&
			hit.theme === theme &&
			hit.bgSlot === toolCardBgSlot(component) &&
			hit.diffConfigKey === diffConfigKey &&
			hit.expanded === expanded &&
			hit.result === component.result &&
			hit.isPartial === isPartial &&
			hit.args === component.args &&
			hit.hover === hover &&
			hit.ioHover === ioHover
		) {
			return hit.lines;
		}
	}
	const lines = paintCompactEditWrite(component, width, writeMetadata);
	if (!pending) {
		compactEditPaintCache.set(component, {
			width,
			theme,
			bgSlot: toolCardBgSlot(component),
			diffConfigKey,
			expanded,
			result: component.result,
			isPartial,
			args: component.args,
			hover,
			ioHover: compactEditIoHover(component),
			lines,
		});
	}
	return lines;
}

function paintCompactEditWrite(
	component: any,
	width: number,
	writeMetadata?: WriteExecutionMetadataStore,
): string[] {
	const theme = themeOf();
	const result = component.result;
	const expanded = component.expanded === true;
	const isError = result?.isError === true;
	const isPending = !result || component.isPartial === true;
	let candidate: unknown;
	if (!isPending && writeMetadata) {
		let entry = compactRichDiffCache.get(component);
		if (!entry || entry.result !== result) {
			entry = { result };
			compactRichDiffCache.set(component, entry);
		}
		const slot = expanded ? "expanded" : "collapsed";
		candidate = entry[slot];
		if (!isRichDiffComponent(candidate)) {
			candidate = renderRichToolResult(
				String(component.toolName ?? ""),
				result,
				{
					expanded,
					isPartial: component.isPartial === true,
					isError,
					isHovered: () => isToolCallHovered(component.toolCallId),
				},
				theme,
				component,
				writeMetadata,
				getToolDisplayConfig,
			);
			if (isRichDiffComponent(candidate)) entry[slot] = candidate;
		}
	}
	const hasRich = isRichDiffComponent(candidate);
	if (hasRich) {
		component.resultRendererComponent = candidate;
	}

	// 统计只显示一处：正文里已经有 +A -D（diff 头行/0 行摘要行）时标题不再重复。
	const showStats = !(hasRich && richDiffBodyShowsStats(candidate));
	const title = compactEditWriteLine(component, width, writeMetadata, {
		hint: !hasRich,
		showStats,
	});
	if (!hasRich && !expanded) {
		// pending write 流式头：与 on 模式同形（`↳ Writing N lines…` + 中性 gutter 行）。
		if (
			isPending &&
			String(component.toolName ?? "") === "write" &&
			typeof component.args?.content === "string"
		) {
			const preview = buildStreamingWritePreview(
				component.args.content,
				width,
				theme,
				"",
				"   ↳",
				STREAMING_WRITE_PREVIEW_LINES,
			);
			if (preview) return [...title, preview.head, ...preview.rows.map((row) => ` ${row}`)];
		}
		return title;
	}

	let detail: any;
	if (hasRich) {
		detail = expanded ? expandedBodyComponent(candidate) : insetComponent(candidate as any);
	} else {
		const outputText = sanitizeToolResultText(
			Array.isArray(result?.content)
				? result.content
						.filter((item: any) => item?.type === "text")
						.map((item: any) => String(item.text ?? ""))
						.join("\n")
				: "",
		);
		const state = component.state ?? {};
		component.state = state;
		detail = renderExpandedToolResult(
			outputText,
			theme,
			isError,
			state.ccstyleIoView,
			component.args,
			component,
			true, // 外层 Box(1,1) 已 pad
		);
		component.resultRendererComponent = detail;
	}

	if (!expanded) {
		return [...title, ...detail.render(width)];
	}

	const box = editWriteExpandedCard(theme, component);
	box.addChild({
		render(innerWidth: number): string[] {
			return compactEditWriteLine(component, innerWidth, writeMetadata, {
				hint: false,
				flushLeft: true,
				showStats,
			}).slice(1);
		},
		invalidate() {},
	});
	box.addChild(detail);
	// 与原生 ToolExecutionComponent 一样：Spacer(1) + Box，否则贴上一条 tool 少 1 行间距
	return ["", ...box.render(width)];
}
