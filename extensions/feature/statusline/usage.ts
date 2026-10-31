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

/** 累加单条 session entry；输入未知形状一律容错，永不抛。 */
export function accumulateEntryUsage(total: UsageTotals, raw: unknown): void {
	if (!raw || typeof raw !== "object") return;
	const entry = raw as EntryLike;
	if (entry.type === "message") {
		if (entry.message?.role === "assistant") addUsage(total, entry.message.usage);
		return;
	}
	// toolResult / compaction / branch_summary / custom_message：带 usage 才加。
	addUsage(total, entry.usage);
}

/** 单遍累计；输入未知形状一律容错，永不抛。 */
export function summarizeUsage(entries: readonly unknown[]): UsageTotals {
	const total: UsageTotals = { ...EMPTY_USAGE_TOTALS };
	for (const raw of entries) accumulateEntryUsage(total, raw);
	return total;
}

/** collectUsage 需要的最小会话接口（SessionManager 天然满足）。 */
export interface UsageEntrySource {
	getLeafId(): string | null;
	getEntry(id: string): unknown;
	getBranch(): readonly unknown[];
}

export interface UsageCache {
	leafId: string | null;
	totals: UsageTotals;
}

/** 父链防环上限；正常会话远达不到，只防损坏的 parentId。 */
const MAX_PARENT_WALK = 100_000;

/**
 * 增量累计会话用量：叶子没变直接复用；叶子是缓存叶子的后代时只累加新增 entry；
 * 分支切换 / 回退 / compaction 导致找不到共同祖先时回退全量扫描。
 *
 * 返回新缓存；调用方原样保存即可（不修改传入的 cached）。
 */
export function collectUsage(
	source: UsageEntrySource,
	cached: UsageCache | null,
): { totals: UsageTotals; cache: UsageCache | null } {
	let leafId: string | null = null;
	try {
		leafId = source.getLeafId();
	} catch {
		return { totals: { ...EMPTY_USAGE_TOTALS }, cache: null };
	}
	if (cached && leafId !== null && cached.leafId === leafId) {
		return { totals: cached.totals, cache: cached };
	}

	if (cached && leafId !== null && cached.leafId !== null) {
		const delta: unknown[] = [];
		let cursor: string | null = leafId;
		let hit = false;
		for (let guard = 0; cursor !== null && guard < MAX_PARENT_WALK; guard++) {
			if (cursor === cached.leafId) {
				hit = true;
				break;
			}
			let entry: unknown;
			try {
				entry = source.getEntry(cursor);
			} catch {
				break;
			}
			if (!entry) break;
			delta.push(entry);
			const parentId = (entry as { parentId?: unknown }).parentId;
			cursor = typeof parentId === "string" ? parentId : null;
		}
		if (hit) {
			const totals = { ...cached.totals };
			for (let index = delta.length - 1; index >= 0; index--) {
				accumulateEntryUsage(totals, delta[index]);
			}
			return { totals, cache: { leafId, totals } };
		}
	}

	let totals: UsageTotals;
	try {
		totals = summarizeUsage(source.getBranch());
	} catch {
		totals = { ...EMPTY_USAGE_TOTALS };
	}
	return { totals, cache: leafId === null ? null : { leafId, totals } };
}
