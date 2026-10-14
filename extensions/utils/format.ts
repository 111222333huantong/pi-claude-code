import { homedir } from "node:os";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeToolResultText } from "./tool-result-sanitize.ts";

/** 执行耗时/输出量键与短格式（真相源在 tool-metrics.ts，此处重导出防漂移）。 */
export {
	attachExecuteMetrics,
	ELAPSED_MS_KEY,
	formatElapsedShort,
	OUTPUT_CHARS_KEY,
} from "./tool-metrics.ts";
/** token/计数缩写：<1k 原数，<1M 用 k，≥1M 用 M。footer 与 working message 共用。 */
export function formatTokenCount(value: number): string {
	if (value < 1000) return `${value}`;
	if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
	if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
	if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	return `${Math.round(value / 1_000_000)}M`;
}

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

/** Claude-style 紧凑 token 计数：18 / 1.4k / 12k（working-message 与 statusline 同口径）。 */
export function formatTokens(value: number): string {
	const n = Math.max(0, Math.round(value));
	if (n < 1000) return String(n);
	const k = n / 1000;
	if (k < 10) {
		const oneDecimal = Math.round(k * 10) / 10;
		return `${oneDecimal % 1 === 0 ? oneDecimal.toFixed(0) : oneDecimal.toFixed(1)}k`;
	}
	return `${Math.round(k)}k`;
}

/**
 * cwd 缩写：HOME → `~`（`~` 后保留分隔符）。
 * 与 naive `startsWith(home)` 不同：`/home/user2` 不会被 `/home/user` 误匹配；
 * Windows 下同时识别 `/` 与 `\` 分隔符。
 */
export function shortenCwd(cwd: string, home: string = homedir()): string {
	if (!cwd) return cwd;
	if (!home) return cwd;
	if (cwd === home) return "~";
	if (cwd.startsWith(`${home}/`) || cwd.startsWith(`${home}\\`)) {
		return `~${cwd.slice(home.length)}`;
	}
	return cwd;
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
