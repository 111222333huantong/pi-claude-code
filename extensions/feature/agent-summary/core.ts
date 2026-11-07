/**
 * Agent 回合摘要：统计一次 agent 运行的工具使用并格式化成摘要文本。
 *
 * 分类：bash / read / edit / write / other（精确工具名；MCP 风格名归 other）。
 * 计数：bash/powershell 按调用次数；read/edit/write 按非空 path/file_path 去重；other 按调用次数。
 * 失败单独累计；另记回合耗时与输出 tokens（tok/s = output ÷ 回合耗时）。
 *
 * 呈现：`summarySegments` 分段（文字 + 语义色），渲染层自己拼行并上色；
 * `summaryMarkdown` 保留给旧调用与测试。尾段 `· 52.5s · 30.4 tok/s`。
 * 不要经 Markdown 渲染：pi 的 Markdown 组件会剥掉输入里的终端序列，数字会失去语义色。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatDuration } from "../../utils/format.ts";
import { currentTtftMs, formatTtft } from "../shell/token-rate.ts";

/** 工具分类。 */
export type AgentToolCategory = "bash" | "read" | "edit" | "write" | "other";

/** 一次 agent 回合的统计快照。 */
export type AgentSummaryData = {
	commands: number;
	reads: number;
	edits: number;
	writes: number;
	others: number;
	failed: number;
	durationMs: number;
	/** 本回合 assistant 输出 tokens 总和；旧持久化 entry 无此字段（省略 tok/s 段）。 */
	outputTokens?: number;
	/** 首 token 延迟毫秒（读 token-rate 单例）；无首 token 时省略 TTFT 段。 */
	ttftMs?: number;
};

export function classifyTool(toolName: string): AgentToolCategory {
	const base = toolName.split(".").pop() ?? toolName;
	if (base === "bash" || base === "powershell") return "bash";
	if (base === "read") return "read";
	if (base === "edit") return "edit";
	if (base === "write") return "write";
	return "other";
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function toolPath(args?: Record<string, unknown> | null): string | undefined {
	const path = args?.path ?? args?.file_path;
	return nonEmptyString(path) ? path : undefined;
}

/** 累积一次 agent 回合的工具统计；agent_start 时新建实例。 */
export class AgentRunSummary {
	toolCount = 0;
	commandCount = 0;
	readFiles = new Set<string>();
	editFiles = new Set<string>();
	writeFiles = new Set<string>();
	otherCount = 0;
	failedCount = 0;
	outputTokens = 0;

	readonly startedAt: number;

	constructor(startedAt = Date.now()) {
		this.startedAt = startedAt;
	}

	/** tool_execution_start 时调用。 */
	recordToolStart(toolName: string, args?: Record<string, unknown> | null): void {
		this.toolCount++;
		const path = toolPath(args);
		switch (classifyTool(toolName)) {
			case "bash":
				this.commandCount++;
				break;
			case "read":
				if (path) this.readFiles.add(path);
				break;
			case "edit":
				if (path) this.editFiles.add(path);
				break;
			case "write":
				if (path) this.writeFiles.add(path);
				break;
			default:
				this.otherCount++;
		}
	}

	/** tool_execution_end 时调用；isError 为 true 计入失败。 */
	recordToolResult(isError: boolean): void {
		if (isError) this.failedCount++;
	}

	/** agent_end 时一次性记入本回合 assistant 输出 tokens。 */
	recordUsage(outputTokens: number): void {
		if (Number.isFinite(outputTokens) && outputTokens > 0) this.outputTokens += outputTokens;
	}

	snapshot(now = Date.now()): AgentSummaryData {
		return {
			commands: this.commandCount,
			reads: this.readFiles.size,
			edits: this.editFiles.size,
			writes: this.writeFiles.size,
			others: this.otherCount,
			failed: this.failedCount,
			durationMs: now - this.startedAt,
			outputTokens: this.outputTokens,
		};
	}
}

const plural = (count: number) => (count === 1 ? "" : "s");

/** 输出顺序：bash → read → edit → write → other → failed。 */
function summaryParts(data: AgentSummaryData): string[] {
	const parts: string[] = [];
	if (data.commands) parts.push(`ran ${data.commands} command${plural(data.commands)}`);
	if (data.reads) parts.push(`read ${data.reads} file${plural(data.reads)}`);
	if (data.edits) parts.push(`edited ${data.edits} file${plural(data.edits)}`);
	if (data.writes) parts.push(`wrote ${data.writes} file${plural(data.writes)}`);
	if (data.others) parts.push(`${data.others} other tool${plural(data.others)}`);
	if (data.failed) parts.push(`${data.failed} failed`);
	return parts;
}

/**
 * 本回合 assistant 消息的 output usage 求和。
 * agent_end.messages 是本 run 的 newMessages（非全历史），按 assistant 角色过滤；
 * usage/output 缺失或非法按 0 跳过。
 */
function sumUsageOutput(messages: readonly unknown[] | undefined): number {
	let total = 0;
	for (const raw of messages ?? []) {
		const message = raw as { role?: unknown; usage?: { output?: unknown } } | null;
		if (message?.role !== "assistant") continue;
		const output = Number(message.usage?.output);
		if (Number.isFinite(output) && output > 0) total += Math.round(output);
	}
	return total;
}

/** 毫秒 → 精确时长（秒保留 1 位小数）：`52.5s` / `1m 2.5s` / `1h 3m 2.5s`。统计行专用，不动共享 formatDuration。 */
function formatDurationPrecise(ms: number): string {
	const totalSec = ms / 1000;
	const hours = Math.floor(totalSec / 3600);
	const minutes = Math.floor((totalSec % 3600) / 60);
	const seconds = totalSec - hours * 3600 - minutes * 60;
	if (hours > 0) return `${hours}h ${minutes}m ${seconds.toFixed(1)}s`;
	if (minutes > 0) return `${minutes}m ${seconds.toFixed(1)}s`;
	return `${seconds.toFixed(1)}s`;
}

/**
 * tok/s = output tokens ÷ 回合墙钟秒数（与展示时长同分母，整回合平均口径）。
 * tokens 缺失/为 0、时长 <1s、或速率过小（toFixed 后为 0.0）时返回 null 省略该段。
 */
function tokenRate(data: AgentSummaryData): number | null {
	const tokens = data.outputTokens ?? 0;
	if (tokens <= 0 || data.durationMs < 1_000) return null;
	const rate = tokens / (data.durationMs / 1000);
	return rate < 0.05 ? null : rate;
}

/** 摘要段：一段文字 + 语义色；数字上色由渲染层完成。 */
export type SummarySegment = { text: string; tone: "success" | "failed" };

export function summarySegments(data: AgentSummaryData): SummarySegment[] {
	const parts = summaryParts(data);
	if (parts.length === 0) return [];
	const capitalizeFirst = (part: string, first: boolean) => {
		const verb = part.match(/^[a-z]+/)?.[0] ?? "";
		return first && verb ? verb[0].toUpperCase() + verb.slice(1) + part.slice(verb.length) : part;
	};
	return parts.map((part, index) => ({
		text: capitalizeFirst(part, index === 0),
		tone: part.endsWith("failed") ? "failed" : "success",
	}));
}

/** 统计尾段：有速率 → `52.5s · 30.4 tok/s · TTFT 812ms`；无速率 → 旧格式 `49s`（旧 entry 兼容）。 */
export function summaryTail(data: AgentSummaryData): string {
	const rate = tokenRate(data);
	const ttft =
		typeof data.ttftMs === "number" && data.ttftMs > 0 ? ` · TTFT ${formatTtft(data.ttftMs)}` : "";
	return rate !== null
		? `${formatDurationPrecise(data.durationMs)} · ${rate.toFixed(1)} tok/s${ttft}`
		: `${formatDuration(data.durationMs)}${ttft}`;
}

export function summaryMarkdown(
	data: AgentSummaryData,
	colors: { success: string; failed: string } = { success: "", failed: "" },
): string {
	const segments = summarySegments(data);
	if (segments.length === 0) return "";
	const paintNumber = (code: string, part: string) =>
		code ? part.replace(/(\d+)/, `${code}$1\x1b[0m`) : part;
	const text = segments
		.map((segment) =>
			paintNumber(segment.tone === "failed" ? colors.failed : colors.success, segment.text),
		)
		.join(", ");
	const tail = summaryTail(data);
	const line = tail ? `${text} · ${tail}` : text;
	return `> *${line}*`;
}

/**
 * 绑定 pi 事件到摘要统计：
 * - before_agent_start 重置（一次用户请求一次；agent_start 会在重试/续跑时重复）
 * - tool_execution_start / end 累计
 * - agent_end 从 event.messages 求和 assistant output usage（每个低层 run 都要记）
 * - agent_settled 回调（此时重试/恢复/排队工作都已结束；toolCount < minToolCount 跳过）
 */
export function bindAgentSummary(
	pi: ExtensionAPI,
	onSummary: (data: AgentSummaryData) => void,
): void {
	let summary = new AgentRunSummary();
	pi.on("before_agent_start", async () => {
		summary = new AgentRunSummary();
	});
	pi.on("tool_execution_start", async (event) => {
		summary.recordToolStart(event.toolName, event.args);
	});
	pi.on("tool_execution_end", async (event) => {
		summary.recordToolResult(event.isError === true);
	});
	pi.on("agent_end", async (event) => {
		// 防御转换：测试 harness 会以无参调用；messages 只在真实 AgentEndEvent 上存在。
		const messages = (event as { messages?: readonly unknown[] } | undefined)?.messages;
		summary.recordUsage(sumUsageOutput(messages));
	});
	pi.on("agent_settled", async () => {
		if (summary.toolCount < 2) return;
		const data = summary.snapshot();
		// TTFT 读 token-rate 单例（跨 turn 保持到下一条用户指令，settled 时仍有效）；
		// 无首 token 时不设字段，保持旧 entry 形状。
		const ttft = currentTtftMs();
		if (ttft > 0) data.ttftMs = ttft;
		onSummary(data);
	});
}
