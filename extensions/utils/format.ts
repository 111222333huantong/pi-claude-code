import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeToolResultText } from "./tool-result-sanitize.ts";

/** 毫秒 → "1h 2m 3s"/"2m 3s"/"3s"；低于 1 秒返回 ""（省略）。 */
export function formatDuration(ms: number): string {
	const totalSec = Math.floor(ms / 1000);
	if (totalSec < 1) return "";
	const hours = Math.floor(totalSec / 3600);
	const minutes = Math.floor((totalSec % 3600) / 60);
	const seconds = totalSec % 60;
	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

/** 文本单行化：去换行空白，超宽按列宽截断加省略号。 */
export function oneLine(value: unknown, max = 96): string {
	const text = sanitizeToolResultText(String(value ?? ""), 4096)
		.replace(/\s+/g, " ")
		.trim();
	return truncateByWidth(text, max);
}

/** 把一行文本补齐到固定可见宽度，超宽时截断并追加省略号。 */
export function padLine(text: string, width: number): string {
	const truncated = truncateToWidth(text, width, "…");
	return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

/**
 * 按可见列宽截断纯文本（CJK 计 2 列，不断半个宽字符），超宽追加省略号。
 * ASCII 下与 `slice(0, max-1) + "…"` 逐字一致；不注入 ANSI，可安全用于摘要。
 */
export function truncateByWidth(text: string, max: number, ellipsis = "…"): string {
	if (max <= 0) return "";
	if (visibleWidth(text) <= max) return text;
	const budget = Math.max(0, max - visibleWidth(ellipsis));
	let width = 0;
	let end = 0;
	for (const char of text) {
		const w = visibleWidth(char);
		if (width + w > budget) break;
		width += w;
		end += char.length;
	}
	return text.slice(0, end) + ellipsis;
}
