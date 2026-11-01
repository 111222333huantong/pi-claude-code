import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { measureWidth } from "../../../utils/width.ts";

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
	return count === 1 ? singular : plural;
}

export function splitWriteContentLines(content: string): string[] {
	if (!content) {
		return [];
	}

	const normalized = content.replace(/\r/g, "");
	const lines = normalized.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines;
}

export function normalizeCodeWhitespace(text: string): string {
	return text.replace(/\t/g, "    ");
}

export function fitToWidth(text: string, width: number): string {
	// 先量一次：diff 行几乎都带 `│`/`▎` 这类非 ASCII 字形，truncateToWidth 会因此
	// 走整行字素切分（约 25µs/行）。已经放得下时直接补空格，省掉这次重扫。
	// measureWidth 对「ASCII + 装饰字形」走单遍扫描，其余回落 visibleWidth。
	const measured = measureWidth(text);
	if (measured === width) return text;
	if (measured < width) return `${text}${" ".repeat(width - measured)}`;
	const trimmed = truncateToWidth(text, width, "");
	const gap = Math.max(0, width - visibleWidth(trimmed));
	return gap > 0 ? `${trimmed}${" ".repeat(gap)}` : trimmed;
}

/** 单条逻辑行最多展开成多少视觉行；超过就截断并以 `…` 收尾（delta 的 wrap-max-lines 思路）。 */
export const MAX_WRAPPED_LINES = 24;

export function wrapToWidth(text: string, width: number, wordWrap: boolean): string[] {
	if (width <= 0) {
		return [""];
	}

	if (!wordWrap) {
		return [fitToWidth(text, width)];
	}

	const wrapped = wrapTextWithAnsi(text, width);
	if (wrapped.length === 0) {
		return [fitToWidth("", width)];
	}

	// 压缩后的 JS/CSS 可能是一行几万字符；全量换行会把折叠区撑到几千行。
	// 只保留前 N 个视觉行，最后一行的文本裁到 width-1 再补 `…`。
	const capped =
		wrapped.length > MAX_WRAPPED_LINES
			? [
					...wrapped.slice(0, MAX_WRAPPED_LINES - 1),
					withEllipsis(wrapped[MAX_WRAPPED_LINES - 1]!, width),
				]
			: wrapped;

	return capped.map((line) => fitToWidth(line, width));
}

function withEllipsis(line: string, width: number): string {
	const room = Math.max(0, width - 1);
	const clipped = visibleWidth(line) > room ? truncateToWidth(line, room, "") : line;
	return `${clipped}…`;
}
