/**
 * 会话用量累计（纯函数）：扫 session entries 累加 token 与 cost。
 *
 * 口径与 zhuxixi-pi-statusbar `cacheSummary` 对齐：
 * - assistant 消息（含 usage）全加；
 * - toolResult / compaction / branch_summary 带 usage 才加；
 * - 其余 entry 忽略。天然扛 compaction 与分支切换。
 */
import type { Usage } from "@earendil-works/pi-ai";

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export const EMPTY_USAGE_TOTALS: UsageTotals = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
};

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function addUsage(total: UsageTotals, usage: Partial<Usage> | undefined | null): void {
	if (!usage || typeof usage !== "object") return;
	if (isFiniteNumber(usage.input)) total.input += usage.input;
	if (isFiniteNumber(usage.output)) total.output += usage.output;
	if (isFiniteNumber(usage.cacheRead)) total.cacheRead += usage.cacheRead;
	if (isFiniteNumber(usage.cacheWrite)) total.cacheWrite += usage.cacheWrite;
	const costTotal = (usage.cost as { total?: unknown } | undefined)?.total;
	if (isFiniteNumber(costTotal)) total.cost += costTotal;
}

interface EntryLike {
	type?: unknown;
	message?: { role?: unknown; usage?: Partial<Usage> | null };
	usage?: Partial<Usage> | null;
}

/** 单遍累计；输入未知形状一律容错，永不抛。 */
export function summarizeUsage(entries: readonly unknown[]): UsageTotals {
	const total: UsageTotals = { ...EMPTY_USAGE_TOTALS };
	for (const raw of entries) {
		if (!raw || typeof raw !== "object") continue;
		const entry = raw as EntryLike;
		if (entry.type === "message") {
			if (entry.message?.role === "assistant") addUsage(total, entry.message.usage);
			continue;
		}
		// toolResult / compaction / branch_summary / custom_message：带 usage 才加。
		addUsage(total, entry.usage);
	}
	return total;
}
