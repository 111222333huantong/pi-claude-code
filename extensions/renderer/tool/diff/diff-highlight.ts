import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";
import { config } from "../../../config/config.ts";
import { sanitizeToolResultText } from "../../../utils/tool-result-sanitize.ts";
import { sanitizeAnsiForThemedOutput } from "./ansi-utils.ts";
import type { DiffSpan } from "./diff-inline.ts";
import {
	applyInlineSpanHighlight,
	type DiffPalette,
	type DiffTheme,
	getLineBackground,
	resolveShikiTheme,
} from "./diff-palette.ts";
import type { DiffLineEntry, ParsedDiffEntry } from "./diff-parse.ts";
import { normalizeCodeWhitespace } from "./diff-text.ts";
import { MAX_HL_CHARS, shikiHighlightCache } from "./shiki-highlight.ts";

export type CodeLineHighlighter = (line: string, entry: DiffLineEntry) => string;

function cleanCodeLine(line: string): string {
	return sanitizeToolResultText(line).replace(/\n/g, "");
}

export function shouldHighlightCodeBlock(code: string): boolean {
	return code.length <= MAX_HL_CHARS;
}

export function resolveLanguageFromPath(rawPath: string | undefined): string | undefined {
	if (!rawPath?.trim()) {
		return undefined;
	}
	const normalizedPath = rawPath.replace(/^@/, "").trim();
	if (!normalizedPath) {
		return undefined;
	}
	try {
		return getLanguageFromPath(normalizedPath);
	} catch {
		return undefined;
	}
}

export function createCodeLineHighlighter(
	language: string | undefined,
	theme: DiffTheme,
	entries: readonly ParsedDiffEntry[],
	invalidate?: () => void,
): CodeLineHighlighter {
	const codeEntries = entries.filter((entry): entry is DiffLineEntry => entry.kind === "line");
	const allCode = codeEntries
		.map((entry) => cleanCodeLine(normalizeCodeWhitespace(entry.content)))
		.join("\n");
	// Budget check stays on the whole visible code: over the limit nothing is highlighted.
	// Per-segment checks would let a huge diff highlight itself one segment at a time.
	const segmentLanguage = shouldHighlightCodeBlock(allCode) ? language : undefined;
	const highlightByEntry = new WeakMap<DiffLineEntry, CodeLineHighlighter>();
	let segment: DiffLineEntry[] = [];

	const flushSegment = () => {
		if (segment.length === 0) return;
		const highlight = createContiguousCodeLineHighlighter(
			segmentLanguage,
			theme,
			segment,
			invalidate,
		);
		for (const entry of segment) highlightByEntry.set(entry, highlight);
		segment = [];
	};

	// Omitted source cannot carry lexer state across a diff discontinuity.
	// Each segment is highlighted and cached on its own; the budget above still bounds one diff.
	for (const entry of entries) {
		if (entry.kind === "line") segment.push(entry);
		else flushSegment();
	}
	flushSegment();

	// 未注册条目只有渲染期物化的 omission（新对象）：回原文而非空行。
	return (line, entry) => highlightByEntry.get(entry)?.(line, entry) ?? line;
}

function createContiguousCodeLineHighlighter(
	language: string | undefined,
	theme: DiffTheme,
	codeEntries: readonly DiffLineEntry[],
	invalidate?: () => void,
): CodeLineHighlighter {
	const cleanLines = codeEntries.map((entry) =>
		cleanCodeLine(normalizeCodeWhitespace(entry.content)),
	);
	const code = cleanLines.join("\n");
	// A segment is a subset of the visible code, so `segmentLanguage` already carries
	// the total budget decision; only the per-segment highlight is left to decide here.
	const shouldHighlight = language !== undefined;
	const fallbackLines = shouldHighlight
		? (() => {
				try {
					return highlightCode(code, language).map(sanitizeAnsiForThemedOutput);
				} catch {
					return cleanLines.map(sanitizeAnsiForThemedOutput);
				}
			})()
		: cleanLines.map(sanitizeAnsiForThemedOutput);
	const fallbackByEntry = new WeakMap(
		codeEntries.map((entry, index) => [entry, fallbackLines[index] ?? cleanLines[index] ?? ""]),
	);
	if (!shouldHighlight) return (line, entry) => fallbackByEntry.get(entry) ?? line;

	const shikiTheme = resolveShikiTheme(theme);
	let highlightedByEntry: WeakMap<DiffLineEntry, string> | undefined;
	const resolveHighlighted = () => {
		if (highlightedByEntry) return;
		const highlighted = shikiHighlightCache.get(
			code,
			language,
			shikiTheme,
			fallbackLines,
			invalidate,
		);
		if (highlighted) {
			highlightedByEntry = new WeakMap(
				codeEntries.map((entry, index) => [
					entry,
					sanitizeAnsiForThemedOutput(highlighted[index] ?? fallbackByEntry.get(entry) ?? ""),
				]),
			);
		}
	};
	resolveHighlighted();
	return (line, entry) => {
		resolveHighlighted();
		// 未注册条目只有物化 omission（新对象）：回原文而非空行；
		// 解析型省略 content 本来就是空串，行为不变。
		return highlightedByEntry?.get(entry) ?? fallbackByEntry.get(entry) ?? line;
	};
}

/**
 * 通用代码块着色（codemode 的 `code` 字段等）：先用 pi 的同步 highlightCode 打底，
 * 首帧就有颜色；再用 shiki 异步升级（与 diff 共用缓存与主题解析），落地后回调
 * invalidate 重画。返回行数组，按源行一一对应；语言不识或未就绪时给打底结果。
 */
export function createCodeBlockHighlighter(
	code: string,
	language: string | undefined,
	theme: DiffTheme,
	invalidate?: () => void,
): () => string[] {
	const cleanCode = sanitizeToolResultText(code).replace(/\r/g, "");
	const cleanLines = cleanCode.split("\n").map(cleanCodeLine);
	if (!language || !shouldHighlightCodeBlock(cleanCode)) {
		return () => cleanLines.map(sanitizeAnsiForThemedOutput);
	}
	let fallback: string[];
	try {
		fallback = highlightCode(cleanCode, language).map(sanitizeAnsiForThemedOutput);
	} catch {
		fallback = cleanLines.map(sanitizeAnsiForThemedOutput);
	}
	const shikiTheme = resolveShikiTheme(theme);
	let highlighted: string[] | undefined;
	const resolve = () => {
		if (highlighted) return;
		const result = shikiHighlightCache.get(cleanCode, language, shikiTheme, fallback, invalidate);
		if (result) highlighted = result.map(sanitizeAnsiForThemedOutput);
	};
	resolve();
	return () => {
		resolve();
		return highlighted ?? fallback;
	};
}

export function highlightDiffLine(
	codeText: string,
	entry: DiffLineEntry,
	inlineHighlights: WeakMap<DiffLineEntry, DiffSpan[]>,
	palette: DiffPalette,
	highlightLine: CodeLineHighlighter,
	containerBgAnsi: string | undefined,
): { highlighted: string; rowBg: string | undefined } {
	// claude 板：删行不做语法高亮（CC 实测行为），token 级强调底色照常。
	const skipSyntax = config.diffPalette === "claude" && entry.lineKind === "remove";
	const syntaxHighlighted = skipSyntax ? codeText : highlightLine(codeText, entry);
	const rowBg = getLineBackground(entry.lineKind, palette, false);
	const emphasisBg = getLineBackground(entry.lineKind, palette, true);
	const inlineSpans = inlineHighlights.get(entry) ?? [];
	const highlighted = applyInlineSpanHighlight(
		codeText,
		syntaxHighlighted,
		inlineSpans,
		emphasisBg,
		rowBg,
		containerBgAnsi,
	);
	return { highlighted, rowBg };
}
