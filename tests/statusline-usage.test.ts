import assert from "node:assert/strict";
import test from "node:test";
import { summarizeUsage } from "../extensions/feature/statusline/usage.ts";

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
