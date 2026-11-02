import { truncateToWidth } from "@earendil-works/pi-tui";
import type { EditDiffCollapsedLines, ToolDisplayConfig } from "../../../config/config.ts";
import { measureWidth } from "../../../utils/width.ts";
import { renderAllHintText, showMoreHintText } from "../names.ts";
import type { SplitDiffRow } from "./diff-inline.ts";
import type { RenderedRow } from "./diff-layout.ts";
import { type DiffTheme, stabilizeBackgroundResets } from "./diff-palette.ts";
import { countDiffLineEntries, type ParsedDiffEntry } from "./diff-parse.ts";
import {
	buildCollapsedDiffHintText,
	clampRenderedLinesToWidth,
	clampRenderedLineToWidth,
} from "./line-width-safety.ts";

const DIFF_WIDTH_OPS = {
	measure: measureWidth,
	truncate: (text: string, maxWidth: number): string => truncateToWidth(text, maxWidth, ""),
};

export function clampDiffLineToWidth(text: string, width: number): string {
	return stabilizeBackgroundResets(clampRenderedLineToWidth(text, width, DIFF_WIDTH_OPS));
}

export function clampDiffLinesToWidth(lines: string[], width: number): string[] {
	return clampRenderedLinesToWidth(lines, width, DIFF_WIDTH_OPS).map((line) =>
		stabilizeBackgroundResets(line),
	);
}

function renderDiffSpacerLine(width: number): string {
	const safeWidth = Math.max(0, width);
	return safeWidth > 0 ? " ".repeat(safeWidth) : "";
}

/**
 * 展开态的安全上限（渲染后的视觉行）。超过时先渲染前缀并给
 * `… N more diff lines · click to render all`，再点一次才全量。
 * 2000 行足以覆盖绝大多数 edit/write；更大的 diff 多半是在看生成物。
 */
export const EXPANDED_DIFF_MAX_LINES = 2000;

/**
 * `editDiffCollapsedLines: "auto"` 的分界：增删合计不超过该值时整段展开，
 * 超过则只留一行变更摘要 + 展开入口。小改不吵、大改不淹 scrollback。
 */
export const AUTO_EDIT_COLLAPSE_MAX_CHANGED_LINES = 16;

export function shouldAutoCollapseEdit(stats: { added: number; removed: number }): boolean {
	return stats.added + stats.removed > AUTO_EDIT_COLLAPSE_MAX_CHANGED_LINES;
}

/**
 * Body lines to render before the remainder hint. Collapsed diffs use the configured
 * line limit; expanded diffs render fully up to EXPANDED_DIFF_MAX_LINES, and only
 * `renderAll` (second click) lifts the cap.
 */
export function resolveDiffDisplayLimit(
	expanded: boolean,
	maxCollapsedLines: EditDiffCollapsedLines,
	renderAll = false,
): number {
	if (expanded) return renderAll ? Number.POSITIVE_INFINITY : EXPANDED_DIFF_MAX_LINES;
	// auto 的“大 diff”分支在渲染前已收成摘要行；走到这里说明是“小 diff 全显”。
	if (maxCollapsedLines === "auto") return EXPANDED_DIFF_MAX_LINES;
	return Math.max(1, maxCollapsedLines);
}

export function resolveWriteCollapsedLimit(
	config: Pick<ToolDisplayConfig, "writeDiffCollapsedLines">,
): number {
	return Math.max(0, config.writeDiffCollapsedLines);
}

/**
 * How many source rows/entries to fully highlight+render before applyLineLimit.
 * Extra headroom covers word-wrap expansion so the display limit can still fill.
 */
export function resolveDiffProcessBudget(displayLimit: number, wordWrap: boolean): number {
	if (!Number.isFinite(displayLimit) || displayLimit <= 0) {
		return Number.POSITIVE_INFINITY;
	}
	return wordWrap ? displayLimit * 2 + 8 : displayLimit + 4;
}

export function takeEntriesForLineBudget(
	entries: ParsedDiffEntry[],
	maxLineEntries: number,
): { entries: ParsedDiffEntry[]; totalLineEntries: number; processedLineEntries: number } {
	const totalLineEntries = countDiffLineEntries(entries);
	if (!Number.isFinite(maxLineEntries) || maxLineEntries >= totalLineEntries) {
		return { entries, totalLineEntries, processedLineEntries: totalLineEntries };
	}
	const limited: ParsedDiffEntry[] = [];
	let processedLineEntries = 0;
	for (const entry of entries) {
		if (entry.kind === "line") {
			if (processedLineEntries >= maxLineEntries) break;
			processedLineEntries++;
		}
		limited.push(entry);
	}
	return { entries: limited, totalLineEntries, processedLineEntries };
}

export function takeSplitRowsForBudget(
	rows: SplitDiffRow[],
	maxRows: number,
): { rows: SplitDiffRow[]; totalRows: number; processedRows: number } {
	const totalRows = rows.length;
	if (!Number.isFinite(maxRows) || maxRows >= totalRows) {
		return { rows, totalRows, processedRows: totalRows };
	}
	const limited = rows.slice(0, maxRows);
	return { rows: limited, totalRows, processedRows: limited.length };
}

export function applyLineLimit(
	rows: RenderedRow[],
	width: number,
	expanded: boolean,
	maxCollapsedLines: EditDiffCollapsedLines,
	totalHunks: number,
	theme: DiffTheme,
	/**
	 * When the caller only rendered a prefix of the full diff, pass the unprocessed
	 * remainder so the collapse hint still reflects total hidden content.
	 */
	unprocessedLogicalRows = 0,
	hovered = false,
	/** 展开态第二次点击后为 true：解除 EXPANDED_DIFF_MAX_LINES 上限。 */
	renderAll = false,
): { lines: string[]; hintLine?: string } {
	const limit = resolveDiffDisplayLimit(expanded, maxCollapsedLines, renderAll);
	const safeUnprocessed = Math.max(0, unprocessedLogicalRows);
	if (limit === 0 || (rows.length <= limit && safeUnprocessed === 0)) {
		return { lines: rows.map((row) => clampDiffLineToWidth(row.text, width)) };
	}

	const shown = rows.length <= limit ? rows : rows.slice(0, limit);
	const remaining = Math.max(0, rows.length - shown.length) + safeUnprocessed;
	if (remaining === 0) {
		return { lines: shown.map((row) => clampDiffLineToWidth(row.text, width)) };
	}
	const visibleHunks = new Set(
		shown
			.map((row) => row.hunkIndex)
			.filter((hunkIndex): hunkIndex is number => typeof hunkIndex === "number" && hunkIndex > 0),
	);
	const hiddenHunks = Math.max(0, totalHunks - visibleHunks.size);
	const hintText = buildCollapsedDiffHintText(
		{
			remainingLines: remaining,
			hiddenHunks,
			...(expanded ? { hintLabel: renderAllHintText() } : {}),
		},
		width,
		DIFF_WIDTH_OPS,
	);

	const clickLabel = expanded ? renderAllHintText() : showMoreHintText();
	const clickIndex = hintText.lastIndexOf(clickLabel);
	// 展开态不会再截断，剩下的分支必是折叠态提示。
	// 提示文本与其余折叠卡一致用 dim，hover 时 clickLabel 提到 text。
	const styledHint =
		clickIndex >= 0
			? theme.fg("muted", hintText.slice(0, clickIndex)) +
				theme.fg(hovered ? "text" : "dim", clickLabel) +
				theme.fg("muted", hintText.slice(clickIndex + clickLabel.length))
			: theme.fg("muted", hintText);
	return {
		lines: [
			...shown.map((row) => clampDiffLineToWidth(row.text, width)),
			renderDiffSpacerLine(width),
			clampDiffLineToWidth(styledHint, width),
		],
		hintLine: hintText,
	};
}
