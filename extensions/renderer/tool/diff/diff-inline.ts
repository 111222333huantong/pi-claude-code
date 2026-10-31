import type {
	DiffLineEntry,
	DiffMetaEntry,
	DiffOmissionEntry,
	ParsedDiffEntry,
} from "./diff-parse.ts";
import { normalizeCodeWhitespace } from "./diff-text.ts";

export interface DiffSpan {
	start: number;
	end: number;
}

export interface SplitDiffRow {
	left?: DiffLineEntry;
	right?: DiffLineEntry;
	omission?: DiffOmissionEntry;
	meta?: DiffMetaEntry;
	hunkIndex: number | null;
}

const MAX_INLINE_DIFF_LINE_LENGTH = 700;
/** 非空白词元重合度低于此值视为改写，不叠加词级高亮（delta max-line-distance 的简化版）。 */
const MIN_INLINE_SIMILARITY = 0.25;

function tokenizeInlineDiff(input: string): Array<{ value: string; start: number; end: number }> {
	if (!input) {
		return [];
	}

	const tokens: Array<{ value: string; start: number; end: number }> = [];
	const pattern = /(\s+|[A-Za-z0-9_]+|[^A-Za-z0-9_\s])/g;
	let match: RegExpExecArray | null = pattern.exec(input);

	while (match !== null) {
		const value = match[0] ?? "";
		if (!value) {
			match = pattern.exec(input);
			continue;
		}
		tokens.push({
			value,
			start: match.index,
			end: match.index + value.length,
		});
		match = pattern.exec(input);
	}

	if (tokens.length === 0 && input.length > 0) {
		tokens.push({ value: input, start: 0, end: input.length });
	}

	return tokens;
}

export function mergeSpans(spans: DiffSpan[]): DiffSpan[] {
	if (spans.length <= 1) {
		return spans;
	}

	const sorted = [...spans].sort((a, b) => a.start - b.start);
	const merged: DiffSpan[] = [sorted[0]];

	for (let index = 1; index < sorted.length; index++) {
		const current = sorted[index];
		const previous = merged[merged.length - 1];
		if (!current || !previous) {
			continue;
		}

		if (current.start <= previous.end) {
			previous.end = Math.max(previous.end, current.end);
			continue;
		}

		merged.push({ ...current });
	}

	return merged;
}

function tokensToDiffSpans(
	text: string,
	tokens: Array<{ value: string; start: number; end: number }>,
	changedIndexes: Set<number>,
): DiffSpan[] {
	if (tokens.length === 0 || changedIndexes.size === 0) {
		return [];
	}

	const spans: DiffSpan[] = [];
	let start: number | null = null;
	let end = -1;

	for (let index = 0; index < tokens.length; index++) {
		if (!changedIndexes.has(index)) {
			if (start !== null && end > start) {
				spans.push({ start, end });
				start = null;
				end = -1;
			}
			continue;
		}

		const token = tokens[index];
		if (!token) {
			continue;
		}

		if (start === null) {
			start = token.start;
			end = token.end;
		} else {
			end = token.end;
		}
	}

	if (start !== null && end > start) {
		spans.push({ start, end });
	}

	const trimmed: DiffSpan[] = [];
	for (const span of spans) {
		let spanStart = span.start;
		let spanEnd = span.end;

		while (spanStart < spanEnd && /\s/.test(text[spanStart] ?? "")) {
			spanStart++;
		}
		while (spanEnd > spanStart && /\s/.test(text[spanEnd - 1] ?? "")) {
			spanEnd--;
		}
		if (spanEnd > spanStart) {
			trimmed.push({ start: spanStart, end: spanEnd });
		}
	}

	return mergeSpans(trimmed);
}

/**
 * 非空白词元的重合度（多重集合交集 / 较大集合大小）。
 * 只用它做「值不值得词级高亮」的闸门；真正的改动区间仍由 LCS 决定。
 */
function tokenSimilarity(
	leftTokens: Array<{ value: string }>,
	rightTokens: Array<{ value: string }>,
): number {
	const left = new Map<string, number>();
	const right = new Map<string, number>();
	let leftTotal = 0;
	let rightTotal = 0;
	for (const token of leftTokens) {
		if (!token.value.trim()) continue;
		left.set(token.value, (left.get(token.value) ?? 0) + 1);
		leftTotal++;
	}
	for (const token of rightTokens) {
		if (!token.value.trim()) continue;
		right.set(token.value, (right.get(token.value) ?? 0) + 1);
		rightTotal++;
	}
	if (leftTotal === 0 || rightTotal === 0) return 0;
	let common = 0;
	for (const [value, count] of left) {
		common += Math.min(count, right.get(value) ?? 0);
	}
	return common / Math.max(leftTotal, rightTotal);
}

export function computeInlineDiffSpans(
	leftLine: string,
	rightLine: string,
): { left: DiffSpan[]; right: DiffSpan[] } {
	if (leftLine === rightLine) {
		return { left: [], right: [] };
	}
	if (
		leftLine.length > MAX_INLINE_DIFF_LINE_LENGTH ||
		rightLine.length > MAX_INLINE_DIFF_LINE_LENGTH
	) {
		return { left: [], right: [] };
	}

	const leftTokens = tokenizeInlineDiff(leftLine);
	const rightTokens = tokenizeInlineDiff(rightLine);
	const leftCount = leftTokens.length;
	const rightCount = rightTokens.length;

	if (leftCount === 0 || rightCount === 0) {
		return {
			left: leftLine.trim().length > 0 ? [{ start: 0, end: leftLine.length }] : [],
			right: rightLine.trim().length > 0 ? [{ start: 0, end: rightLine.length }] : [],
		};
	}

	if (tokenSimilarity(leftTokens, rightTokens) < MIN_INLINE_SIMILARITY) {
		return { left: [], right: [] };
	}

	const table: number[][] = Array.from({ length: leftCount + 1 }, () =>
		Array<number>(rightCount + 1).fill(0),
	);

	for (let leftIndex = 1; leftIndex <= leftCount; leftIndex++) {
		const leftToken = leftTokens[leftIndex - 1];
		for (let rightIndex = 1; rightIndex <= rightCount; rightIndex++) {
			const rightToken = rightTokens[rightIndex - 1];
			if (leftToken?.value === rightToken?.value) {
				table[leftIndex][rightIndex] = (table[leftIndex - 1]?.[rightIndex - 1] ?? 0) + 1;
			} else {
				const top = table[leftIndex - 1]?.[rightIndex] ?? 0;
				const side = table[leftIndex]?.[rightIndex - 1] ?? 0;
				table[leftIndex][rightIndex] = Math.max(top, side);
			}
		}
	}

	const changedLeft = new Set<number>();
	const changedRight = new Set<number>();
	let leftCursor = leftCount;
	let rightCursor = rightCount;

	while (leftCursor > 0 && rightCursor > 0) {
		const leftToken = leftTokens[leftCursor - 1];
		const rightToken = rightTokens[rightCursor - 1];
		if (leftToken?.value === rightToken?.value) {
			leftCursor--;
			rightCursor--;
			continue;
		}

		const top = table[leftCursor - 1]?.[rightCursor] ?? 0;
		const side = table[leftCursor]?.[rightCursor - 1] ?? 0;
		if (top >= side) {
			changedLeft.add(leftCursor - 1);
			leftCursor--;
		} else {
			changedRight.add(rightCursor - 1);
			rightCursor--;
		}
	}

	while (leftCursor > 0) {
		changedLeft.add(leftCursor - 1);
		leftCursor--;
	}
	while (rightCursor > 0) {
		changedRight.add(rightCursor - 1);
		rightCursor--;
	}

	return {
		left: tokensToDiffSpans(leftLine, leftTokens, changedLeft),
		right: tokensToDiffSpans(rightLine, rightTokens, changedRight),
	};
}

function collectConsecutiveLineEntries(
	entries: ParsedDiffEntry[],
	startIndex: number,
	lineKind: DiffLineEntry["lineKind"],
): { collected: DiffLineEntry[]; nextIndex: number } {
	const collected: DiffLineEntry[] = [];
	let index = startIndex;
	while (index < entries.length) {
		const candidate = entries[index];
		if (candidate?.kind !== "line" || candidate?.lineKind !== lineKind) {
			break;
		}
		collected.push(candidate);
		index++;
	}
	return { collected, nextIndex: index };
}

export function buildSplitRows(entries: ParsedDiffEntry[]): SplitDiffRow[] {
	const rows: SplitDiffRow[] = [];
	let index = 0;

	while (index < entries.length) {
		const entry = entries[index];
		if (!entry) {
			break;
		}

		if (entry.kind === "omission") {
			rows.push({ omission: entry, hunkIndex: entry.hunkIndex || null });
			index++;
			continue;
		}

		if (entry.kind !== "line") {
			rows.push({ meta: entry, hunkIndex: entry.hunkIndex || null });
			index++;
			continue;
		}

		if (entry.lineKind === "remove") {
			const removedResult = collectConsecutiveLineEntries(entries, index, "remove");
			const removed = removedResult.collected;
			const addedResult = collectConsecutiveLineEntries(entries, removedResult.nextIndex, "add");
			const added = addedResult.collected;
			index = addedResult.nextIndex;

			const pairCount = Math.max(removed.length, added.length);
			for (let pairIndex = 0; pairIndex < pairCount; pairIndex++) {
				const left = removed[pairIndex];
				const right = added[pairIndex];
				rows.push({
					left,
					right,
					hunkIndex: left?.hunkIndex ?? right?.hunkIndex ?? null,
				});
			}
			continue;
		}

		if (entry.lineKind === "add") {
			rows.push({ right: entry, hunkIndex: entry.hunkIndex || null });
			index++;
			continue;
		}

		rows.push({ left: entry, right: entry, hunkIndex: entry.hunkIndex || null });
		index++;
	}

	return rows;
}

export function getCellLineNumber(line: DiffLineEntry, side: "left" | "right"): number | null {
	if (side === "left") {
		return line.oldLineNumber ?? (line.lineKind === "context" ? line.newLineNumber : null);
	}
	return line.newLineNumber ?? (line.lineKind === "context" ? line.oldLineNumber : null);
}

export function buildInlineHighlightMap(rows: SplitDiffRow[]): WeakMap<DiffLineEntry, DiffSpan[]> {
	const highlights = new WeakMap<DiffLineEntry, DiffSpan[]>();

	for (const row of rows) {
		if (!row.left || !row.right) {
			continue;
		}
		if (row.left.lineKind !== "remove" || row.right.lineKind !== "add") {
			continue;
		}

		const leftText = normalizeCodeWhitespace(row.left.content);
		const rightText = normalizeCodeWhitespace(row.right.content);
		const inline = computeInlineDiffSpans(leftText, rightText);
		if (inline.left.length > 0) {
			highlights.set(row.left, inline.left);
		}
		if (inline.right.length > 0) {
			highlights.set(row.right, inline.right);
		}
	}

	return highlights;
}
