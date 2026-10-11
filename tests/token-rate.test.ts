import assert from "node:assert/strict";
import test, { describe } from "node:test";
import workingMessageExtension from "../extensions/feature/shell/working-message.ts";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
	carryTokenRate,
	currentTokenRate,
	currentTtftMs,
	displayTokenRate,
	formatTokenRate,
	markFirstToken,
	pauseTokenRate,
	resetTokenRate,
	resumeTokenRate,
	sampleTokenRate,
} from "../extensions/feature/shell/token-rate.ts";

initTheme("dark");

// 模块级状态，必须串行；并行会互相清掉速率。
describe("token rate", { concurrency: false }, () => {
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
		assert.equal(formatTokenRate(1200, 812, "live"), "live 1.2k tok/s (TTFT: 812ms)");
	});

	test("live mode uses the trailing window and pauses across tool execution", () => {
		resetTokenRate(1_000);
		sampleTokenRate(100, 2_000);
		assert.equal(displayTokenRate("live"), 100, "窗口不足 250ms 时回退平均");

		sampleTokenRate(200, 2_500); // 窗口内 100 token / 0.5s
		assert.equal(displayTokenRate("live"), 200);
		assert.equal(displayTokenRate("average"), 200 / 1.5);

		pauseTokenRate(2_600);
		sampleTokenRate(1_000, 4_000); // 工具执行中不更新窗口，平均仍累计
		assert.equal(displayTokenRate("live"), 1_000 / 3, "暂停时回退平均");

		resumeTokenRate();
		sampleTokenRate(1_100, 4_200);
		sampleTokenRate(1_200, 4_600); // 恢复后窗口 100 token / 0.4s
		assert.equal(displayTokenRate("live"), 250);
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

	test("resetTokenRate(startAt) restarts accumulation from a new user prompt", () => {
		resetTokenRate(1_000);
		sampleTokenRate(100, 11_000); // 10 tok/s
		resetTokenRate(20_000);
		// 新指令刚开头没有样本时保持 0，而不是沿用上一段值
		assert.equal(currentTokenRate(), 0);
		sampleTokenRate(50, 20_500); // 50 tokens in 0.5s
		assert.equal(currentTokenRate(), 100);
	});

	test("carryTokenRate keeps the shown rate across a tool turn and adds the next segment", () => {
		resetTokenRate(1_000);
		sampleTokenRate(100, 11_000); // 10 tok/s
		carryTokenRate(100); // 工具调用结束，本段 token 结转
		assert.equal(currentTokenRate(), 10, "工具等待期间保留上一段速率");
		sampleTokenRate(0, 21_000); // 下一段还没有 token，不覆盖
		assert.equal(currentTokenRate(), 10);
		sampleTokenRate(100, 31_000); // 累计 200 token / 30s
		assert.equal(currentTokenRate(), 200 / 30);
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
		await events.get("turn_end")?.({}, ctx);
		await events.get("agent_end")?.({}, ctx);
	});

	test("a tool turn keeps the rate and TTFT until the next user prompt", async () => {
		const { events, ctx } = install();

		await events.get("before_agent_start")?.({}, ctx);
		await events.get("turn_start")?.({ timestamp: Date.now() - 1_000 }, ctx);
		await events.get("message_update")?.(
			{ assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: {} } },
			ctx,
		);
		await events.get("message_update")?.(
			{
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: 0,
					delta: "x".repeat(400),
					partial: { usage: { output: 100 } },
				},
			},
			ctx,
		);
		const rate = currentTokenRate();
		const ttft = currentTtftMs();
		assert.ok(rate > 0);
		assert.ok(ttft > 0);

		await events.get("turn_end")?.({}, ctx);
		assert.equal(currentTokenRate(), rate, "turn 结束不清速率");
		assert.equal(currentTtftMs(), ttft);

		// 工具结果之后的下一段 assistant 回复，仍属同一条用户指令。
		await events.get("turn_start")?.({}, ctx);
		assert.equal(currentTokenRate(), rate, "下一段 turn 不清速率");
		assert.equal(currentTtftMs(), ttft, "下一段 turn 不重记 TTFT");

		// 下一条用户指令才重置。
		await events.get("agent_end")?.({}, ctx);
		await events.get("before_agent_start")?.({}, ctx);
		await events.get("turn_start")?.({ timestamp: Date.now() }, ctx);
		assert.equal(currentTokenRate(), 0);
		assert.equal(currentTtftMs(), 0);
	});
});
