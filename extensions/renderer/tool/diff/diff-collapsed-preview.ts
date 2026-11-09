/**
 * 折叠 diff 的“先看一眼”预览。
 *
 * 大 diff 折叠后只剩 `+42 -7 · click to show more`，用户得先展开才知道改得对不对。
 * 这里从第一处改动往前带一行 context，取 N 行，用和展开态同一套行号/背景/指示条
 * 渲染，但跳过 Shiki：折叠态本来就是为了省掉全量高亮，预览也不该把它重新拉起来。
 */
import type { DiffIndicatorMode } from "../../../config/config.ts";
import { buildInlineHighlightMap, buildSplitRows } from "./diff-inline.ts";
import type { RenderedRow } from "./diff-layout.ts";
import { renderUnified } from "./diff-layout.ts";
import { type DiffTheme, resolveDiffPalette } from "./diff-palette.ts";
import { type DiffLineEntry, getLineNumberWidth, type ParsedDiffEntry } from "./diff-parse.ts";
import { normalizeDiffRenderWidth } from "./diff-presentation.ts";

/**
 * 从第一处改动往前带一行 context，最多 maxLines 行。
 * 替换块按 diff 顺序先删后加；只取前几行会全是删除，所以预算在删/加之间对半分，
 * 保证预览里两侧都能看到。全是 context 时取开头。
 */
export function selectCollapsedPreviewEntries(
	entries: ParsedDiffEntry[],
	maxLines: number,
): DiffLineEntry[] {
	if (maxLines <= 0) return [];
	const lines = entries.filter((entry): entry is DiffLineEntry => entry.kind === "line");
	if (lines.length === 0) return [];
	const firstChange = lines.findIndex((entry) => entry.lineKind !== "context");
	if (firstChange < 0) return lines.slice(0, maxLines);

	const contextBefore = firstChange > 0 ? [lines[firstChange - 1]!] : [];
	let blockEnd = firstChange;
	while (blockEnd < lines.length && lines[blockEnd]!.lineKind !== "context") blockEnd++;
	const block = lines.slice(firstChange, blockEnd);
	const budget = Math.max(0, maxLines - contextBefore.length);
	if (block.length <= budget) return [...contextBefore, ...block];

	const removals = block.filter((entry) => entry.lineKind === "remove");
	const adds = block.filter((entry) => entry.lineKind === "add");
	const chosen = new Set<DiffLineEntry>();
	const half = Math.ceil(budget / 2);
	for (const entry of removals.slice(0, Math.min(removals.length, half))) chosen.add(entry);
	for (const entry of adds.slice(0, Math.max(0, budget - chosen.size))) chosen.add(entry);
	// 只有删除或只有新增时，把剩下的名额补满。
	for (const entry of block) {
		if (chosen.size >= budget) break;
		chosen.add(entry);
	}
	return [...contextBefore, ...block.filter((entry) => chosen.has(entry)).slice(0, budget)];
}

export function renderCollapsedPreview(
	entries: DiffLineEntry[],
	options: {
		width: number;
		theme: DiffTheme;
		indicatorMode: DiffIndicatorMode;
		/** 与展开态共用行号列宽，展开时缩进不跳。 */
		lineNumberWidth?: number;
	},
): RenderedRow[] {
	const width = normalizeDiffRenderWidth(options.width);
	if (width === 0 || entries.length === 0) return [];
	const splitRows = buildSplitRows(entries);
	return renderUnified(
		entries,
		{
			width,
			theme: options.theme,
			inlineHighlights: buildInlineHighlightMap(splitRows),
			palette: resolveDiffPalette(options.theme),
			// 预览不跑 Shiki：省掉一次全量高亮，视觉上也只需分清 +/-。
			highlightLine: (line) => line,
			containerBgAnsi: undefined,
			// 折叠预览固定 1 行 1 条：否则一条长代码换行后能把 3 行预览撑成十几行，
			// 反而把下面的内容挤走。完整内容展开再看。
			wordWrap: false,
			indicatorMode: options.indicatorMode,
			showHashlineAnchors: false,
		},
		options.lineNumberWidth ?? getLineNumberWidth(entries, false),
	);
}
