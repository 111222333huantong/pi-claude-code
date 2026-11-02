/**
 * Compact 摘要与状态文本：纯函数，无组件状态。
 *
 * 从 compact-mode.ts 抽出的第一阶段模块，便于单独测试与复用；compact-mode
 * 继续 re-export 这些符号，外部导入路径保持不变。
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { sanitizeToolResultText } from "../utils/tool-result-sanitize.ts";
import { ASK_USER_QUESTION_TOOL_NAME } from "./tool/ask-user-question.ts";

/** compact 渲染层对 compact-thinking 的只读查询面（不建第二套计时器）。 */
export type CompactThinkingQuery = {
	getMessageThinkingDurationMs(messageTimestamp: number): number | undefined;
	isMessageThinkingActive?(messageTimestamp: number): boolean;
	getThinkingAnimationFrame?(): number;
	setCompactSummaryActive?(active: boolean): void;
};

export const EDIT_WRITE_TOOLS = new Set(["edit", "write"]);

/**
 * 留在外层的工具：不进摘要计数，折叠态也单独成行。
 * edit/write 走 compact 自己的 rich diff；ask_user_question 走 default 模式的专用渲染
 *（标题 (+N) 加折叠问答树）。
 */
export const OUTER_TOOLS = new Set([...EDIT_WRITE_TOOLS, ASK_USER_QUESTION_TOOL_NAME]);

type CompactThinkingTheme = Pick<Theme, "fg" | "italic" | "bold">;

/** 与 compact-thinking 主渲染器共用的静态文字样式。 */
export function styleCompactThinkingText(
	text: string,
	theme: CompactThinkingTheme | undefined,
	bold = false,
): string {
	if (!theme) return text;
	const colored = typeof theme.fg === "function" ? theme.fg("dim", text) : text;
	const weighted = bold && typeof theme.bold === "function" ? theme.bold(colored) : colored;
	return typeof theme.italic === "function" ? theme.italic(weighted) : weighted;
}

/** 与 compact-thinking 主渲染器共用的活动思考扫光动画。 */
export function animateCompactThinkingText(
	text: string,
	theme: CompactThinkingTheme | undefined,
	animationFrame: number,
	boldBase = false,
): string {
	if (!theme) return text;
	const characters = Array.from(text);
	if (characters.length === 0) return "";
	const highlightWidth = Math.max(1, Math.min(5, Math.ceil(characters.length * 0.28)));
	const start = (animationFrame % (characters.length + highlightWidth)) - highlightWidth;
	const end = start + highlightWidth;
	const before = characters.slice(0, Math.max(0, start)).join("");
	const highlighted = characters
		.slice(Math.max(0, start), Math.min(characters.length, end))
		.join("");
	const after = characters.slice(Math.max(0, end)).join("");
	const highlightedColored =
		highlighted && typeof theme.fg === "function" ? theme.fg("text", highlighted) : highlighted;
	const highlightedWeighted =
		highlightedColored && typeof theme.bold === "function"
			? theme.bold(highlightedColored)
			: highlightedColored;
	const highlightedText =
		highlightedWeighted && typeof theme.italic === "function"
			? theme.italic(highlightedWeighted)
			: highlightedWeighted;

	return (
		styleCompactThinkingText(before, theme, boldBase) +
		highlightedText +
		styleCompactThinkingText(after, theme, boldBase)
	);
}

export function formatThoughtDuration(durationMs: number) {
	if (durationMs < 1_000) {
		return `${Math.max(1, Math.round(durationMs))}ms`;
	}

	const totalSeconds = Math.max(1, Math.round(durationMs / 1_000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes === 0) return `${seconds}s`;
	return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

/** assistant stopReason → 外层状态文案（与 Pi 原生口径对齐）+ 种类（配色用）。 */
export function messageStopStatus(
	message: any,
): { text: string; kind: "aborted" | "error" | "length" } | undefined {
	const reason = message?.stopReason;
	if (reason === "aborted") {
		return {
			text:
				message.errorMessage && message.errorMessage !== "Request was aborted"
					? String(message.errorMessage)
					: "Operation aborted",
			kind: "aborted",
		};
	}
	if (reason === "error") {
		return { text: `Error: ${message.errorMessage || "Unknown error"}`, kind: "error" };
	}
	if (reason === "length") {
		return { text: "Response was truncated before completion.", kind: "length" };
	}
	return undefined;
}

export function roundStopStatus(
	messages: Iterable<any>,
): { text: string; kind: "aborted" | "error" | "length" } | undefined {
	for (const message of messages) {
		const status = messageStopStatus(message);
		if (status) return status;
	}
	return undefined;
}

/**
 * 逐条 assistant message 的摘要文本（无工具计数时可为空串）：
 * 时长 = max(thinking query, durationFloorMs 挂钟)；工具首次出现顺序；read 路径去重。
 */
export function buildMessagesSummary(
	messages: Iterable<any>,
	query?: CompactThinkingQuery,
	runningActiveOverride?: boolean,
	durationFloorMs?: number,
): string {
	const parts: string[] = [];
	const counts = new Map<string, number>();
	const readPaths = new Set<string>();
	const durationTimestamps = new Set<number>();
	let durationMs = 0;
	let runningActive = false;

	for (const message of messages) {
		if (typeof message?.timestamp === "number" && !durationTimestamps.has(message.timestamp)) {
			durationTimestamps.add(message.timestamp);
			if (query?.isMessageThinkingActive?.(message.timestamp)) runningActive = true;
			const value = query?.getMessageThinkingDurationMs(message.timestamp);
			if (typeof value === "number" && Number.isFinite(value) && value > 0) durationMs += value;
		}
		const content = Array.isArray(message?.content) ? message.content : [];
		for (const item of content) {
			if (item?.type !== "toolCall") continue;
			const rawName = typeof item.name === "string" ? item.name : "tool";
			if (OUTER_TOOLS.has(rawName)) continue;
			const name = sanitizeToolResultText(rawName);
			if (rawName.split(".").pop() === "read") {
				const args = item.arguments ?? item.args ?? {};
				const path = args.path ?? args.file_path ?? args.file;
				if (typeof path === "string" && path.length > 0) {
					if (readPaths.has(path)) continue;
					readPaths.add(path);
				}
			}
			counts.set(name, (counts.get(name) ?? 0) + 1);
		}
	}

	if (
		typeof durationFloorMs === "number" &&
		Number.isFinite(durationFloorMs) &&
		durationFloorMs > durationMs
	) {
		durationMs = durationFloorMs;
	}

	runningActive = runningActiveOverride ?? runningActive;
	if (runningActive) {
		parts.push(durationMs > 0 ? `Running... · ${formatThoughtDuration(durationMs)}` : "Running...");
	} else if (durationMs > 0) parts.push(`Ran for ${formatThoughtDuration(durationMs)}`);
	for (const [name, count] of counts) parts.push(`${name}×${count}`);
	return parts.join(", ");
}

export function buildMessageSummary(
	message: any,
	query?: CompactThinkingQuery,
	durationFloorMs?: number,
): string {
	return buildMessagesSummary([message], query, undefined, durationFloorMs);
}
