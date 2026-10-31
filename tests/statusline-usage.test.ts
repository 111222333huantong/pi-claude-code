import assert from "node:assert/strict";
import test from "node:test";
import {
	collectUsage,
	summarizeUsage,
	type UsageEntrySource,
} from "../extensions/feature/statusline/usage.ts";

const usage = (over: Record<string, unknown> = {}) => ({
	input: 100,
	output: 50,
	cacheRead: 10,
	cacheWrite: 5,
	totalTokens: 165,
	cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
	...over,
});

test("summarizeUsage: 累加 assistant 消息用量", () => {
	const total = summarizeUsage([
		{ type: "message", message: { role: "assistant", usage: usage() } },
		{
			type: "message",
			message: { role: "assistant", usage: usage({ input: 200, cost: { total: 0.1 } }) },
		},
	]);
	assert.equal(total.input, 300);
	assert.equal(total.output, 100);
	assert.equal(total.cost, 0.13);
});

test("summarizeUsage: user 消息与无用量 assistant 被忽略", () => {
	const total = summarizeUsage([
		{ type: "message", message: { role: "user", content: "hi" } },
		{ type: "message", message: { role: "assistant" } },
	]);
	assert.deepEqual(total, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
});

test("summarizeUsage: toolResult/compaction 带 usage 才加", () => {
	const total = summarizeUsage([
		{
			type: "toolResult",
			usage: usage({ input: 0, output: 7, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } }),
		},
		{
			type: "compaction",
			summary: "old",
			usage: usage({ input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } }),
		},
		{ type: "branch_summary", summary: "branch" },
		{ type: "custom_message", customType: "x" },
	]);
	assert.equal(total.output, 7);
	assert.equal(total.input, 1000);
	assert.equal(total.cost, 0.51);
});

test("summarizeUsage: 畸形输入容错永不抛", () => {
	const total = summarizeUsage([
		null,
		undefined,
		42,
		"str",
		{
			type: "message",
			message: { role: "assistant", usage: { input: "x", cost: { total: NaN } } },
		},
		{
			type: "message",
			message: { role: "assistant", usage: { input: Infinity, cost: { total: 1 } } },
		},
	]);
	assert.equal(total.input, 0);
	assert.equal(total.cost, 1);
});

type FakeEntry = { id: string; parentId: string | null; type: string; message?: any; usage?: any };

function fakeSource(entries: FakeEntry[], leaf: () => string | null) {
	let branchCalls = 0;
	const source: UsageEntrySource & { readonly branchCalls: () => number } = {
		getLeafId: leaf,
		getEntry: (id: string) => entries.find((entry) => entry.id === id),
		getBranch: () => {
			branchCalls++;
			const byId = new Map(entries.map((entry) => [entry.id, entry]));
			const path: FakeEntry[] = [];
			let cursor = leaf();
			while (cursor) {
				const entry = byId.get(cursor);
				if (!entry) break;
				path.push(entry);
				cursor = entry.parentId;
			}
			return path.reverse();
		},
		branchCalls: () => branchCalls,
	};
	return source;
}

test("collectUsage: 同一叶子复用缓存，新叶子只累加增量", () => {
	const root: FakeEntry = {
		id: "a",
		parentId: null,
		type: "message",
		message: { role: "assistant", usage: usage() },
	};
	const entries: FakeEntry[] = [root];
	let leaf: string | null = "a";
	const source = fakeSource(entries, () => leaf);

	const first = collectUsage(source, null);
	assert.equal(first.totals.cost, 0.03);
	assert.equal(source.branchCalls(), 1, "首次全量扫描");

	const same = collectUsage(source, first.cache);
	assert.equal(same.totals.cost, 0.03);
	assert.equal(source.branchCalls(), 1, "叶子未变不再扫描");

	entries.push({
		id: "b",
		parentId: "a",
		type: "message",
		message: {
			role: "assistant",
			usage: usage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.07 } }),
		},
	});
	leaf = "b";
	const delta = collectUsage(source, same.cache);
	assert.equal(delta.totals.cost, 0.1);
	assert.equal(source.branchCalls(), 1, "叶子是缓存叶子后代时只走增量");
});

test("collectUsage: 分支回退/切换时回退全量扫描", () => {
	const a: FakeEntry = {
		id: "a",
		parentId: null,
		type: "message",
		message: { role: "assistant", usage: usage() },
	};
	const b: FakeEntry = {
		id: "b",
		parentId: "a",
		type: "message",
		message: { role: "assistant", usage: usage({ cost: { total: 0.2 } }) },
	};
	const entries: FakeEntry[] = [a, b];
	let leaf: string | null = "b";
	const source = fakeSource(entries, () => leaf);

	const first = collectUsage(source, null);
	assert.equal(first.totals.cost, 0.23);

	leaf = "a";
	const rewound = collectUsage(source, first.cache);
	assert.equal(source.branchCalls(), 2, "回退到非后代叶子时全量重扫");
	assert.equal(rewound.totals.cost, 0.03, "旧分支的增量不会残留");
});

test("collectUsage: 读叶子失败时回退零值且不缓存", () => {
	const source: UsageEntrySource = {
		getLeafId: () => {
			throw new Error("stale");
		},
		getEntry: () => undefined,
		getBranch: () => [],
	};
	const result = collectUsage(source, { leafId: "old", totals: { ...usageTotals(0.5) } });
	assert.equal(result.totals.cost, 0);
	assert.equal(result.cache, null);
});

function usageTotals(cost: number) {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost };
}
