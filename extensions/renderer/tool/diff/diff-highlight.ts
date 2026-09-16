import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";
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
	const cleanLines = codeEntries.map((entry) =>
		cleanCodeLine(normalizeCodeWhitespace(entry.content)),
	);
	const code = cleanLines.join("\n");
	const shouldHighlight = !!language && shouldHighlightCodeBlock(code);
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

export function highlightDiffLine(
	codeText: string,
	entry: DiffLineEntry,
	inlineHighlights: WeakMap<DiffLineEntry, DiffSpan[]>,
	palette: DiffPalette,
	highlightLine: CodeLineHighlighter,
	containerBgAnsi: string | undefined,
): { highlighted: string; rowBg: string | undefined } {
	const syntaxHighlighted = highlightLine(codeText, entry);
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
