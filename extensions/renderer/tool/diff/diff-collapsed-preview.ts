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
 * 预览取“改动量最大”的那一段，而不是第一段。
 *
 * 追加到文件末尾时，diff 常把最后的 `}` 记成 `-}` / `+}`，第一段只有一对括号，
 * 真正新增的内容在后面；覆盖写也可能先来一行 `const x` → `export const x` 的小改名。
 * 只按顺序取第一段，3 行预算全被这种噪声吃掉，所以这里先挑最大的改动块。
 *
 * 块内再按删/加行数比例分配预算：追加块是 1 删 + 27 加时，3 行全给新增，
 * 不会浪费在唯一那行删除上。块本身放得下时才带一行非空 context 做定位。
 */
export function selectCollapsedPreviewEntries(
	entries: ParsedDiffEntry[],
	maxLines: number,
): DiffLineEntry[] {
	if (maxLines <= 0) return [];
	const blocks = collectChangeBlocks(entries);
	if (blocks.length === 0) {
		return entries
			.filter((entry): entry is DiffLineEntry => entry.kind === "line")
			.slice(0, maxLines);
	}

	let block = blocks[0]!;
	for (const candidate of blocks) {
		if (candidate.length > block.length) block = candidate;
	}

	const blockStart = entries.indexOf(block[0]!);
	let contextBefore: DiffLineEntry | undefined;
	for (let index = blockStart - 1; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.kind !== "line") break;
		if (entry.lineKind === "context" && entry.content.trim() !== "") {
			contextBefore = entry;
			break;
		}
	}

	// 块本身占满预算时不再带 context；否则留一行给改动前的定位行。
	const withContext = contextBefore !== undefined && block.length < maxLines;
	const budget = Math.max(0, maxLines - (withContext ? 1 : 0));
	if (block.length <= budget) {
		return withContext && contextBefore ? [contextBefore, ...block] : block;
	}

	const removals = block.filter((entry) => entry.lineKind === "remove");
	const adds = block.filter((entry) => entry.lineKind === "add");
	// 追加到末尾时 `-}` / `+}` 这类“两边一模一样”的行是纯噪声；空白行也不占预览名额。
	const removalContents = new Set(removals.map((entry) => entry.content));
	const addContents = new Set(adds.map((entry) => entry.content));
	const meaningfulRemovals = removals.filter(
		(entry) => entry.content.trim() !== "" && !addContents.has(entry.content),
	);
	const meaningfulAdds = adds.filter(
		(entry) => entry.content.trim() !== "" && !removalContents.has(entry.content),
	);
	const hasMeaningful = meaningfulRemovals.length + meaningfulAdds.length > 0;
	const previewRemovals = hasMeaningful ? meaningfulRemovals : removals;
	const previewAdds = hasMeaningful ? meaningfulAdds : adds;
	let removalQuota = Math.min(
		previewRemovals.length,
		Math.floor((budget * previewRemovals.length) / block.length),
	);
	let addQuota = Math.min(previewAdds.length, budget - removalQuota);
	// 一侧太短填不满预算时，把剩余名额补给另一侧。
	if (removalQuota + addQuota < budget) {
		removalQuota += Math.min(
			previewRemovals.length - removalQuota,
			budget - removalQuota - addQuota,
		);
	}
	if (removalQuota + addQuota < budget) {
		addQuota += Math.min(previewAdds.length - addQuota, budget - removalQuota - addQuota);
	}

	const chosen = new Set<DiffLineEntry>([
		...previewRemovals.slice(0, removalQuota),
		...previewAdds.slice(0, addQuota),
	]);
	const preview = block.filter((entry) => chosen.has(entry));
	return withContext && contextBefore ? [contextBefore, ...preview] : preview;
}

/** 连续的非 context 行算一个改动块；omission/meta 也视为分隔，避免跨 hunk 拼接。 */
function collectChangeBlocks(entries: ParsedDiffEntry[]): DiffLineEntry[][] {
	const blocks: DiffLineEntry[][] = [];
	let current: DiffLineEntry[] = [];
	const flush = () => {
		if (current.length > 0) {
			blocks.push(current);
			current = [];
		}
	};
	for (const entry of entries) {
		if (entry.kind === "line") {
			if (entry.lineKind === "context") flush();
			else current.push(entry);
		} else {
			flush();
		}
	}
	flush();
	return blocks;
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
