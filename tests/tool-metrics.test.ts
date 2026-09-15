import assert from "node:assert/strict";
import test from "node:test";
import {
	attachExecuteMetrics,
	ELAPSED_MS_KEY,
	formatElapsedShort,
	formatTokens,
	OUTPUT_CHARS_KEY,
	shortenCwd,
} from "../extensions/utils/format.ts";
import {
	attachExecuteMetrics as attachMetrics2,
	formatElapsedShort as formatElapsedShort2,
	wrapExecuteWithMetrics,
} from "../extensions/utils/tool-metrics.ts";

test("formatTokens: 与 working-message/statusline 同口径（收口后唯一真相源）", () => {
	assert.equal(formatTokens(18), "18");
	assert.equal(formatTokens(999), "999");
	assert.equal(formatTokens(1400), "1.4k");
	assert.equal(formatTokens(12_000), "12k");
	assert.equal(formatTokens(46_000), "46k");
	assert.equal(formatTokens(-5), "0");
});

test("shortenCwd: HOME→~，前缀目录不误匹配，win 分隔符兼容", () => {
	assert.equal(shortenCwd("/home/u/proj", "/home/u"), "~/proj");
	assert.equal(shortenCwd("/home/u", "/home/u"), "~");
	assert.equal(shortenCwd("/home/u2/proj", "/home/u"), "/home/u2/proj");
	assert.equal(shortenCwd("C:\\Users\\w\\proj", "C:\\Users\\w"), "~\\proj");
	assert.equal(shortenCwd("", "/home/u"), "");
	assert.equal(shortenCwd("/x", ""), "/x");
});

test("tool-metrics: 与 format.ts 同口径（双源一致，防漂移）", () => {
	assert.equal(attachMetrics2, attachExecuteMetrics);
	assert.equal(formatElapsedShort2, formatElapsedShort);
});

test("attachExecuteMetrics: 写入耗时/字符数键，复用传入对象", () => {
	const details: Record<string, unknown> = { a: 1 };
	const out = attachExecuteMetrics(details, 1234, 56);
	assert.equal(out, details);
	assert.equal(out[ELAPSED_MS_KEY], 1234);
	assert.equal(out[OUTPUT_CHARS_KEY], 56);
	assert.equal(attachExecuteMetrics(undefined, 0, 0)[ELAPSED_MS_KEY], 0);
});

test("formatElapsedShort: <1s 省略，秒/分格式", () => {
	assert.equal(formatElapsedShort(999), "");
	assert.equal(formatElapsedShort(1_000), "1s");
	assert.equal(formatElapsedShort(62_000), "1m 2s");
	assert.equal(formatElapsedShort(NaN), "");
});

test("wrapExecuteWithMetrics: 成功透传结果，失败调 onRejected 并原错上抛", async () => {
	const ok = wrapExecuteWithMetrics(async () => 42);
	assert.equal(await ok(), 42);

	let seen: unknown;
	let seenMs = -1;
	const failing = wrapExecuteWithMetrics(
		async () => {
			throw new Error("boom");
		},
		(err, ms) => {
			seen = err;
			seenMs = ms;
		},
	);
	await assert.rejects(failing(), /boom/);
	assert.match(String((seen as Error)?.message), /boom/);
	assert.ok(seenMs >= 0);

	// onRejected 抛错不掩盖原始错误。
	const badCb = wrapExecuteWithMetrics(
		async () => {
			throw new Error("orig");
		},
		() => {
			throw new Error("cb");
		},
	);
	await assert.rejects(badCb(), /orig/);
});
