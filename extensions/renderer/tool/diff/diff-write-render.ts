import { type Component, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { structuredPatch } from "diff";
import { sanitizeToolResultText } from "../../../utils/tool-result-sanitize.ts";
import { showMoreHintText } from "../show-more-hint.ts";
import {
	createDiffRenderCache,
	type DiffRenderOptions,
	type DisplayConfigInput,
	displayConfigCacheKey,
	RICH_DIFF_COMPONENT,
	resolveDiffIndicatorMode,
	resolveLiveDisplayConfig,
} from "./diff-component.ts";
import { renderDiffFrameLine, renderSingleDiffRow, renderWriteHeader } from "./diff-header.ts";
import {
	type CodeLineHighlighter,
	createCodeLineHighlighter,
	resolveLanguageFromPath,
} from "./diff-highlight.ts";
import {
	buildInlineHighlightMap,
	buildSplitRows,
	type DiffSpan,
	type SplitDiffRow,
} from "./diff-inline.ts";
import {
	canRenderSplitLayout,
	type DiffRenderContext,
	type RenderedRow,
	renderCompact,
	renderSplit,
	renderUnified,
} from "./diff-layout.ts";
import {
	applyLineLimit,
	clampDiffLinesToWidth,
	clampDiffLineToWidth,
	resolveDiffDisplayLimit,
	resolveDiffProcessBudget,
	resolveWriteCollapsedLimit,
	takeEntriesForLineBudget,
	takeSplitRowsForBudget,
} from "./diff-limits.ts";
import { type DiffTheme, resolveDiffPalette } from "./diff-palette.ts";
import {
	collectDiffStats,
	type DiffLineEntry,
	type DiffStats,
	getLineNumberWidth,
	type ParsedDiffEntry,
} from "./diff-parse.ts";
import {
	buildDiffSummaryText,
	type DiffPresentationMode,
	normalizeDiffRenderWidth,
	resolveDiffPresentationMode,
} from "./diff-presentation.ts";
import { splitWriteContentLines } from "./diff-text.ts";

/** structuredPatch hunk 上下文行数：与 edit 路径及 cc-tools `parseDiff` 对齐。 */
const WRITE_DIFF_CONTEXT_LINES = 3;

/**
 * 行数组拼回 Myers 输入：统一补末尾换行，避免 JsDiff 把 "b\n" 与 "b"
 * 判成不同行（旧行模型是 split 后的纯行，无换行概念）。
 */
function joinWriteLines(lines: string[]): string {
	if (lines.length === 0) return "";
	const text = lines.join("\n");
	return text.endsWith("\n") ? text : `${text}\n`;
}

function pushWriteLineEntry(
	entries: ParsedDiffEntry[],
	lineKind: "context" | "remove" | "add",
	oldLineNumber: number | null,
	newLineNumber: number | null,
	content: string,
	hunkIndex: number,
): void {
	const marker = lineKind === "context" ? " " : lineKind === "remove" ? "-" : "+";
	entries.push({
		kind: "line",
		lineKind,
		oldLineNumber,
		newLineNumber,
		fallbackLineNumber: `${newLineNumber ?? oldLineNumber ?? ""}`,
		content,
		raw: `${marker}${content}`,
		hunkIndex,
	});
}

function buildWriteEntries(lines: string[]): ParsedDiffEntry[] {
	return lines.map((line, index) => ({
		kind: "line",
		lineKind: "add",
		oldLineNumber: null,
		newLineNumber: index + 1,
		fallbackLineNumber: `${index + 1}`,
		content: line,
		raw: `+${line}`,
		hunkIndex: 1,
	}));
}

/**
 * 覆盖写 diff：JsDiff Myers（`structuredPatch`，O(ND) 线性内存）替代手写
 * O(N*M) LCS 全矩阵。抄 cc-tools `parseDiff`（`context: 3`），行号取自 hunk 头。
 * 无 hunk（内容完全一致）→ 全量 context，保持旧行为（不显示 "(empty file)"）。
 */
function buildWriteOverwriteEntries(oldLines: string[], newLines: string[]): ParsedDiffEntry[] {
	const patch = structuredPatch(
		"",
		"",
		joinWriteLines(oldLines),
		joinWriteLines(newLines),
		"",
		"",
		{
			context: WRITE_DIFF_CONTEXT_LINES,
		},
	);
	if (patch.hunks.length === 0) {
		return oldLines.map((line, index) => ({
			kind: "line",
			lineKind: "context",
			oldLineNumber: index + 1,
			newLineNumber: index + 1,
			fallbackLineNumber: `${index + 1}`,
			content: line,
			raw: ` ${line}`,
			hunkIndex: 1,
		}));
	}
	const entries: ParsedDiffEntry[] = [];
	patch.hunks.forEach((hunk, hunkOrdinal) => {
		const hunkIndex = hunkOrdinal + 1;
		let oldLineNumber = hunk.oldStart;
		let newLineNumber = hunk.newStart;
		for (const hunkLine of hunk.lines) {
			const marker = hunkLine[0];
			const content = hunkLine.slice(1);
			if (marker === "\\") continue; // "\ No newline at end of file"
			if (marker === " ") {
				pushWriteLineEntry(entries, "context", oldLineNumber, newLineNumber, content, hunkIndex);
				oldLineNumber++;
				newLineNumber++;
				continue;
			}
			if (marker === "-") {
				pushWriteLineEntry(entries, "remove", oldLineNumber, null, content, hunkIndex);
				oldLineNumber++;
				continue;
			}
			if (marker === "+") {
				pushWriteLineEntry(entries, "add", null, newLineNumber, content, hunkIndex);
				newLineNumber++;
				continue;
			}
			// 未知标记：按 context 保底，不丢行。
			pushWriteLineEntry(entries, "context", oldLineNumber, newLineNumber, content, hunkIndex);
			oldLineNumber++;
			newLineNumber++;
		}
	});

	return entries;
}

interface WriteDiffData {
	entries: ParsedDiffEntry[];
	splitRows: SplitDiffRow[];
	inlineHighlights: WeakMap<DiffLineEntry, DiffSpan[]>;
	lineNumberWidth: number;
	stats: DiffStats;
	hunkCount: number;
}

interface WriteOverwriteGuard {
	previousLineCount: number;
	nextLineCount: number;
}

const MAX_WRITE_OVERWRITE_DIFF_LINES = 4000;
/** 双边字符总量封顶（超长单行同样熔断；Myers 本身线性内存，此为渲染侧保护）。 */
const MAX_WRITE_OVERWRITE_DIFF_CHARS = 2_000_000;

function buildApproximateWriteStats(
	lineCount: number,
	previousLineCount: number,
	hasComparablePrevious: boolean,
): DiffStats {
	const removed = hasComparablePrevious ? previousLineCount : 0;
	const added = lineCount;
	const hasContent = lineCount > 0 || removed > 0;
	return {
		added,
		removed,
		context: 0,
		hunks: hasContent ? 1 : 0,
		files: 1,
		lines: added + removed,
	};
}

function buildWriteDiffData(entries: ParsedDiffEntry[]): WriteDiffData {
	const splitRows = buildSplitRows(entries);
	const inlineHighlights = buildInlineHighlightMap(splitRows);
	const lineNumberWidth = getLineNumberWidth(entries);
	const hunkCount = entries.reduce((max, entry) => Math.max(max, entry.hunkIndex), 0);
	const stats = collectDiffStats(entries, hunkCount, 1);
	return {
		entries,
		splitRows,
		inlineHighlights,
		lineNumberWidth,
		stats,
		hunkCount,
	};
}

function resolveWriteOverwriteGuard(
	previousLines: string[],
	nextLines: string[],
): WriteOverwriteGuard | undefined {
	const previousLineCount = previousLines.length;
	const nextLineCount = nextLines.length;
	if (
		previousLineCount > MAX_WRITE_OVERWRITE_DIFF_LINES ||
		nextLineCount > MAX_WRITE_OVERWRITE_DIFF_LINES
	) {
		return { previousLineCount, nextLineCount };
	}
	if (previousLineCount === 0 || nextLineCount === 0) {
		return undefined;
	}
	// 字符总量封顶：O(总字符) 一遍累加，遇超即停。
	let chars = 0;
	for (const line of previousLines) {
		chars += line.length + 1;
		if (chars > MAX_WRITE_OVERWRITE_DIFF_CHARS) {
			return { previousLineCount, nextLineCount };
		}
	}
	for (const line of nextLines) {
		chars += line.length + 1;
		if (chars > MAX_WRITE_OVERWRITE_DIFF_CHARS) {
			return { previousLineCount, nextLineCount };
		}
	}
	return undefined;
}

function buildWriteOverwriteGuardText(guard: WriteOverwriteGuard, width: number): string {
	const safeWidth = normalizeDiffRenderWidth(width);
	if (safeWidth === 0) {
		return "";
	}

	const candidates = [
		`↳ overwrite diff omitted (${guard.previousLineCount} → ${guard.nextLineCount} lines)`,
		`↳ overwrite diff omitted (${guard.previousLineCount}→${guard.nextLineCount})`,
		"↳ overwrite diff omitted",
		"diff omitted",
		"…",
	];
	for (const candidate of candidates) {
		if (visibleWidth(candidate) <= safeWidth) {
			return candidate;
		}
	}
	return truncateToWidth(candidates[candidates.length - 1] ?? "", safeWidth, "");
}

function renderWriteOverwriteGuardRows(
	guard: WriteOverwriteGuard,
	width: number,
	theme: DiffTheme,
): string[] {
	return renderSingleDiffRow(buildWriteOverwriteGuardText(guard, width), "warning", width, theme);
}

/** Folded write with `writeDiffCollapsedLines: 0`: `↳ created • click to show more`. */
function renderWriteCollapsedHintLine(
	wasOverwrite: boolean,
	width: number,
	theme: DiffTheme,
	hovered: boolean,
	headerLabel?: string,
): string[] {
	const safeWidth = normalizeDiffRenderWidth(width);
	if (safeWidth === 0) {
		return [""];
	}
	const actionLabel = headerLabel?.trim() || (wasOverwrite ? "overwritten" : "created");
	const clickLabel = showMoreHintText();
	const candidates = [`↳ ${actionLabel} • ${clickLabel}`, `↳ ${actionLabel}`, actionLabel, "…"];
	let text = candidates[candidates.length - 1] ?? "…";
	for (const candidate of candidates) {
		if (visibleWidth(candidate) <= safeWidth) {
			text = candidate;
			break;
		}
	}
	if (visibleWidth(text) > safeWidth) {
		text = truncateToWidth(text, safeWidth, "");
	}
	const clickIndex = text.lastIndexOf(clickLabel);
	const styled =
		hovered && clickIndex >= 0
			? theme.fg("muted", text.slice(0, clickIndex)) +
				theme.fg("text", clickLabel) +
				theme.fg("muted", text.slice(clickIndex + clickLabel.length))
			: theme.fg("muted", text);
	return [clampDiffLineToWidth(styled, safeWidth)];
}

/**
 * write 变更行统计（compact 单行用）：与正文同一套 Myers 算法。
 * 新文件 = 全部新内容为 added；覆盖已有文件精确统计。
 * content 非字符串、元数据缺失或超出行数/字符预算时返回 undefined（不显示计数）。
 */
export function countWriteDiffStats(
	content: string | undefined,
	previousContent: string | undefined,
	fileExistedBeforeWrite: boolean | undefined,
): { added: number; removed: number } | undefined {
	if (typeof content !== "string" || fileExistedBeforeWrite === undefined) return undefined;
	const lines = splitWriteContentLines(sanitizeToolResultText(content));
	if (fileExistedBeforeWrite === false) return { added: lines.length, removed: 0 };
	if (typeof previousContent !== "string") return undefined;
	const previousLines = splitWriteContentLines(sanitizeToolResultText(previousContent));
	if (previousLines.length === 0 || lines.length === 0) {
		return { added: lines.length, removed: previousLines.length };
	}
	if (
		previousLines.length > MAX_WRITE_OVERWRITE_DIFF_LINES ||
		lines.length > MAX_WRITE_OVERWRITE_DIFF_LINES
	) {
		return undefined;
	}
	const patch = structuredPatch(
		"",
		"",
		joinWriteLines(previousLines),
		joinWriteLines(lines),
		"",
		"",
		{
			context: 0,
		},
	);
	let added = 0;
	let removed = 0;
	for (const hunk of patch.hunks) {
		for (const hunkLine of hunk.lines) {
			if (hunkLine[0] === "+") added++;
			else if (hunkLine[0] === "-") removed++;
		}
	}
	return { added, removed };
}

/** 流式头预览行数（折叠）：pending 时无视 writeDiffCollapsedLines，保证“在写”可见。 */
export const STREAMING_WRITE_PREVIEW_LINES = 6;
/** 流式头预览行数（展开）。 */
export const STREAMING_WRITE_PREVIEW_LINES_EXPANDED = 20;

export interface StreamingWritePreview {
	head: string;
	rows: string[];
}

/**
 * write 参数流式中的轻量预告：incoming 原文前 N 行（中性 gutter，不做 diff）。
 * 内容还没发完时 diff 无意义；只 split 前缀（大文件也便宜），块到即刷，
 * 不进 Myers/指纹/防抖。无可见行返回 undefined，由调用方回落 Pending 行。
 * 行框与 unified diff 同形（`▌ N │ 内容`），颜色中性：落定后自然变成红绿。
 */
export function buildStreamingWritePreview(
	content: string,
	width: number,
	theme: DiffTheme,
	timing: string,
	lead: string,
	maxLines: number = STREAMING_WRITE_PREVIEW_LINES,
): StreamingWritePreview | undefined {
	const safeWidth = normalizeDiffRenderWidth(width);
	if (safeWidth === 0 || typeof content !== "string") return undefined;
	const lines = splitWriteContentLines(sanitizeToolResultText(content));
	if (lines.length === 0 || !lines.some((line) => line.trim())) return undefined;
	const total = lines.length;
	// 头部钉死：永远显示前 N 行，只往下长，不重写——视觉最稳，不闪。
	// 流式再快也只是 more 计数涨 + 逐行冒出来（用户定稿）。
	const shown = lines.slice(0, Math.max(1, maxLines));
	const numberWidth = Math.max(2, String(total).length);
	const rows = shown.map((line, index) => {
		const number = String(index + 1).padStart(numberWidth, " ");
		return clampDiffLineToWidth(
			`${theme.fg("dim", "▌")} ${theme.fg("dim", number)} ${theme.fg("dim", "│")} ${line}`,
			safeWidth,
		);
	});
	if (total > shown.length) {
		rows.push(
			clampDiffLineToWidth(theme.fg("muted", `… +${total - shown.length} more lines`), safeWidth),
		);
	}
	return {
		head: clampDiffLineToWidth(
			theme.fg("muted", `${lead} Writing ${total} lines…${timing}`),
			safeWidth,
		),
		rows,
	};
}

export function renderWriteDiffResult(
	content: string | undefined,
	options: DiffRenderOptions,
	config: DisplayConfigInput,
	theme: DiffTheme,
	fallbackText: string,
): Component {
	const safeFallbackText = sanitizeToolResultText(fallbackText);
	if (typeof content !== "string") {
		if (!safeFallbackText.trim()) {
			return new Text(theme.fg("muted", "↳ write completed"), 0, 0);
		}
		return new Text(theme.fg("toolOutput", safeFallbackText), 0, 0);
	}

	const filePath = options.filePath?.trim() || "(unknown path)";
	const lines = splitWriteContentLines(sanitizeToolResultText(content));
	const previousLines =
		typeof options.previousContent === "string"
			? splitWriteContentLines(sanitizeToolResultText(options.previousContent))
			: [];
	const hasComparablePrevious =
		options.fileExistedBeforeWrite === true && typeof options.previousContent === "string";
	const approximateStats = buildApproximateWriteStats(
		lines.length,
		previousLines.length,
		hasComparablePrevious,
	);
	const palette = resolveDiffPalette(theme);
	// Keep the panel transparent; changed rows and inline spans retain their own highlights.
	const containerBgAnsi = undefined;
	const language = resolveLanguageFromPath(filePath);
	const cache = createDiffRenderCache();
	let highlightLine: CodeLineHighlighter | undefined;
	let detailedData: WriteDiffData | undefined;

	function getDetailedData(): WriteDiffData {
		if (detailedData) {
			return detailedData;
		}
		const entries = hasComparablePrevious
			? buildWriteOverwriteEntries(previousLines, lines)
			: buildWriteEntries(lines);
		detailedData = buildWriteDiffData(entries);
		highlightLine = createCodeLineHighlighter(language, theme, entries, () => {
			cache.invalidate();
			options.invalidate?.();
		});
		return detailedData;
	}

	return {
		[RICH_DIFF_COMPONENT]: true,
		render(width: number): string[] {
			// Live config: panel can change indicator/wrap/limits after this component is created.
			const live = resolveLiveDisplayConfig(config);
			const wordWrap = live.diffWordWrap;
			const indicatorMode = resolveDiffIndicatorMode(live);
			const configKey = displayConfigCacheKey(live);
			const safeWidth = normalizeDiffRenderWidth(width);
			const resolvedMode = resolveDiffPresentationMode(
				live,
				safeWidth,
				canRenderSplitLayout(safeWidth),
			);
			const mode: DiffPresentationMode = hasComparablePrevious
				? resolvedMode
				: resolvedMode === "split"
					? "unified"
					: resolvedMode;
			const hovered = options.isHovered?.() ?? false;
			const cached = cache.get(safeWidth, options.expanded, mode, configKey, hovered);
			if (cached) {
				return cached;
			}

			const writeCollapsedLimit = resolveWriteCollapsedLimit(live);
			const statsOnlyCollapsed = !options.expanded && writeCollapsedLimit === 0;
			if (statsOnlyCollapsed) {
				return cache.set(
					safeWidth,
					options.expanded,
					mode,
					configKey,
					hovered,
					clampDiffLinesToWidth(
						renderWriteCollapsedHintLine(
							options.fileExistedBeforeWrite === true,
							safeWidth,
							theme,
							hovered,
							options.headerLabel,
						),
						safeWidth,
					),
				);
			}

			const header = renderWriteHeader(
				options.fileExistedBeforeWrite === true,
				safeWidth,
				theme,
				options.headerLabel,
			);
			// 超限熔断：行数/字符总量封顶（Myers 线性内存，此为渲染侧保护）。
			const overwriteGuard = hasComparablePrevious
				? resolveWriteOverwriteGuard(previousLines, lines)
				: undefined;
			if (overwriteGuard) {
				return cache.set(
					safeWidth,
					options.expanded,
					mode,
					configKey,
					hovered,
					clampDiffLinesToWidth(
						[header, ...renderWriteOverwriteGuardRows(overwriteGuard, safeWidth, theme)],
						safeWidth,
					),
				);
			}

			if (mode === "summary") {
				const summaryRows =
					approximateStats.lines === 0
						? [header]
						: [
								header,
								...renderSingleDiffRow(
									buildDiffSummaryText(approximateStats, safeWidth),
									"toolOutput",
									safeWidth,
									theme,
								),
							];
				return cache.set(
					safeWidth,
					options.expanded,
					mode,
					configKey,
					hovered,
					clampDiffLinesToWidth(summaryRows, safeWidth),
				);
			}

			const data = getDetailedData();
			const displayLimit = resolveDiffDisplayLimit(
				options.expanded,
				writeCollapsedLimit,
				live.expandedPreviewMaxLines,
			);
			const processBudget = resolveDiffProcessBudget(displayLimit, wordWrap);
			const entryBudget = takeEntriesForLineBudget(data.entries, processBudget);
			const splitBudget = takeSplitRowsForBudget(data.splitRows, processBudget);
			const inlineHighlights =
				splitBudget.processedRows < splitBudget.totalRows
					? buildInlineHighlightMap(splitBudget.rows)
					: data.inlineHighlights;
			const renderCtx: DiffRenderContext = {
				width: safeWidth,
				theme,
				inlineHighlights,
				palette,
				highlightLine: highlightLine!,
				containerBgAnsi,
				wordWrap,
				indicatorMode,
				showHashlineAnchors: false,
			};
			const bodyRows: RenderedRow[] =
				entryBudget.entries.length === 0
					? [{ text: theme.fg("muted", "(empty file)"), hunkIndex: null }]
					: mode === "split"
						? renderSplit(splitBudget.rows, renderCtx, data.lineNumberWidth)
						: mode === "compact"
							? renderCompact(entryBudget.entries, renderCtx)
							: renderUnified(entryBudget.entries, renderCtx, data.lineNumberWidth);
			const unprocessedLogicalRows =
				mode === "split"
					? Math.max(0, splitBudget.totalRows - splitBudget.processedRows)
					: Math.max(0, entryBudget.totalLineEntries - entryBudget.processedLineEntries);

			const bodyWithLimit = applyLineLimit(
				bodyRows,
				safeWidth,
				options.expanded,
				writeCollapsedLimit,
				live.expandedPreviewMaxLines,
				data.hunkCount,
				theme,
				unprocessedLogicalRows,
				hovered,
			);
			const frame = renderDiffFrameLine(safeWidth, theme);
			const renderedLines =
				mode === "unified" ? [header, frame, ...bodyWithLimit, frame] : [header, ...bodyWithLimit];
			const finalLines = clampDiffLinesToWidth(renderedLines, safeWidth);
			return cache.set(safeWidth, options.expanded, mode, configKey, hovered, finalLines);
		},
		invalidate: cache.invalidate,
	} as Component;
}
