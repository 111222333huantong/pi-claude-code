import assert from "node:assert/strict";
import test from "node:test";
import workingMessageExtension from "../extensions/feature/shell/working-message.ts";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
	currentTokenRate,
	currentTtftMs,
	formatTokenRate,
	markFirstToken,
	resetTokenRate,
	sampleTokenRate,
} from "../extensions/feature/shell/token-rate.ts";

initTheme("dark");

function install() {
	const events = new Map<string, Function>();
	const ui = { setWorkingMessage() {} } as any;
	workingMessageExtension({
		on(name: string, handler: Function) {
			events.set(name, handler);
		},
	} as any);
	const ctx = { hasUI: true, ui };
	return { events, ctx };
}

test("formatTokenRate renders empty for no data, rounds below 1k, and uses k above", () => {
	assert.equal(formatTokenRate(0), "");
	assert.equal(formatTokenRate(-1), "");
	assert.equal(formatTokenRate(Number.NaN), "");
	assert.equal(formatTokenRate(42.4), "avg 42 tok/s");
	assert.equal(formatTokenRate(99.6), "avg 100 tok/s");
	assert.equal(formatTokenRate(1234), "avg 1.2k tok/s");
	assert.equal(formatTokenRate(10500), "avg 10.5k tok/s");
});

test("formatTokenRate appends TTFT only when present", () => {
	assert.equal(formatTokenRate(1200, 0), "avg 1.2k tok/s");
	assert.equal(formatTokenRate(1200, 812.4), "avg 1.2k tok/s (TTFT: 812ms)");
	assert.equal(formatTokenRate(1200, -5), "avg 1.2k tok/s");
});

test("rate samples average tokens over elapsed turn time", () => {
	resetTokenRate(0);
	assert.equal(currentTokenRate(), 0);

	resetTokenRate(1_000);
	sampleTokenRate(100, 11_000); // 100 tokens in 10s
	assert.equal(currentTokenRate(), 10);

	sampleTokenRate(300, 11_000); // 300 tokens in 10s
	assert.equal(currentTokenRate(), 30);
});

test("sampling without an active turn or zero tokens is ignored", () => {
	resetTokenRate(0);
	sampleTokenRate(500, Date.now());
	assert.equal(currentTokenRate(), 0);

	resetTokenRate(1_000);
	sampleTokenRate(0, 6_000);
	assert.equal(currentTokenRate(), 0);
});

test("resetTokenRate(startAt) restarts accumulation from a new turn start", () => {
	resetTokenRate(1_000);
	sampleTokenRate(100, 11_000); // 10 tok/s
	resetTokenRate(20_000);
	// 新回合刚开头没有样本时保持 0，而不是沿用上回合值
	assert.equal(currentTokenRate(), 0);
	sampleTokenRate(50, 20_500); // 50 tokens in 0.5s
	assert.equal(currentTokenRate(), 100);
});

test("TTFT records only the first content block of the turn and survives sampling", () => {
	resetTokenRate(1_000);
	assert.equal(currentTtftMs(), 0);
	markFirstToken(1_500); // first block: 500ms after turn start
	markFirstToken(2_000); // later block must not overwrite
	assert.equal(currentTtftMs(), 500);
	sampleTokenRate(100, 11_000); // sampling does not touch TTFT
	assert.equal(currentTtftMs(), 500);

	resetTokenRate(5_000);
	assert.equal(currentTtftMs(), 0, "new turn clears TTFT until the first block");
});

test("toolcall_start marks the first token like text/thinking starts", async () => {
	const { events, ctx } = install();

	await events.get("turn_start")?.({}, ctx);
	await new Promise((resolve) => setTimeout(resolve, 5));
	// 模型直接发起 tool call：没有 thinking/text，首块是 toolcall_start
	await events.get("message_update")?.(
		{ assistantMessageEvent: { type: "toolcall_start", partial: { usage: { output: 10 } } } },
		ctx,
	);
	assert.ok(currentTtftMs() > 0, "toolcall_start should record TTFT");
});
