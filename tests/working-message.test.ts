import assert from "node:assert/strict";
import test from "node:test";
import { parseAnsiRgb } from "../extensions/feature/shell/spinner-color.ts";
import { _resetSpinnerSettingsCache } from "../extensions/feature/shell/spinner-settings.ts";
import {
	colorSweep,
	hexToAnsiFg,
	resolveShimmerColors,
} from "../extensions/feature/shell/spinner-shimmer.ts";
import { _resetTicker } from "../extensions/feature/shell/spinner-ticker.ts";
import workingMessageExtension from "../extensions/feature/shell/working-message.ts";

function install() {
	const events = new Map<string, Function>();
	const messages: (string | undefined)[] = [];
	const ui = {
		setWorkingMessage(message?: string) {
			messages.push(message);
		},
	} as any;
	workingMessageExtension({
		on(name: string, handler: Function) {
			events.set(name, handler);
		},
	} as any);
	const ctx = { hasUI: true, ui };
	_resetTicker();
	_resetSpinnerSettingsCache();
	return { events, messages, ctx };
}

/** Strip ANSI escapes so assertions read the visible text. */
function visible(message: string | undefined): string {
	return (message ?? "").replace(/\u001B\[[0-9;]*m/g, "");
}

test("working message shows a verb with esc hint while streaming", async () => {
	const { events, messages, ctx } = install();

	await events.get("turn_start")?.({}, ctx);
	// A verb row is sent immediately: `<Verb>… (esc to interrupt)`.
	assert.match(visible(messages.at(-1)), /… \(esc to interrupt\)$/);

	const delta = "This is a streaming response body long enough to count some tokens.";
	await events.get("message_update")?.(
		{ assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
		ctx,
	);
	await events.get("message_update")?.(
		{ assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } },
		ctx,
	);
	const working = visible(messages.at(-1) ?? "");
	// working 行永不带耗时/速率（已迁到回合统计行）。
	assert.match(working, /↓ \d+ tokens\)$/);
	assert.doesNotMatch(working, /· \d+s\)$/);
	assert.doesNotMatch(working, /tok\/s/);

	await events.get("turn_end")?.({}, ctx);
	assert.match(
		visible(messages.at(-1) ?? ""),
		/^✻ Turn took \d+s$/,
		"turn end leaves a completion line",
	);

	// Shutdown remains idempotent (undefined = Pi's default message).
	await events.get("session_shutdown")?.({}, ctx);
	assert.equal(messages.at(-1), undefined);
});

test("token count accumulates across deltas and resets on the next turn", async () => {
	const { events, messages, ctx } = install();
	await events.get("turn_start")?.({}, ctx);

	await events.get("message_update")?.(
		{ assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "abcd" } },
		ctx,
	);
	assert.match(visible(messages.at(-1)), /↓ 1 tokens/);

	await events.get("message_update")?.(
		{ assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "abcd" } },
		ctx,
	);
	assert.match(visible(messages.at(-1) ?? ""), /↓ 2 tokens/);

	// text_end provides the full block; it must replace, not double-count, deltas.
	await events.get("message_update")?.(
		{
			assistantMessageEvent: {
				type: "text_end",
				contentIndex: 0,
				content: "abcdefgh",
				partial: {},
			},
		},
		ctx,
	);
	assert.match(visible(messages.at(-1) ?? ""), /↓ 2 tokens/);

	// A second text block accumulates independently by contentIndex.
	await events.get("message_update")?.(
		{ assistantMessageEvent: { type: "text_start", contentIndex: 1, partial: {} } },
		ctx,
	);
	await events.get("message_update")?.(
		{
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 1,
				delta: "abcdefgh",
				partial: {},
			},
		},
		ctx,
	);
	assert.match(visible(messages.at(-1) ?? ""), /↓ 4 tokens/);

	// Provider usage replaces the live estimate when available.
	await events.get("message_update")?.(
		{
			assistantMessageEvent: {
				type: "done",
				message: {
					content: [
						{ type: "text", text: "abcdefgh" },
						{ type: "text", text: "abcdefgh" },
					],
					usage: { output: 37 },
				},
			},
		},
		ctx,
	);
	assert.match(visible(messages.at(-1) ?? ""), /↓ 37 tokens/);

	// 同一条用户指令的下一段 turn 不清 token：工具后继续累计。
	await events.get("turn_end")?.({}, ctx);
	await events.get("turn_start")?.({}, ctx);
	assert.match(visible(messages.at(-1)), /… \(esc to interrupt\)$/);
});

test("elapsed never appears in the working status（计时已迁到统计行）", async () => {
	const { events, messages, ctx } = install();
	await events.get("turn_start")?.({}, ctx);
	await events.get("message_update")?.(
		{ assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi" } },
		ctx,
	);
	assert.match(visible(messages.at(-1) ?? ""), /↓ \d+ tokens\)$/, "token 计数立即出现");

	const realNow = Date.now;
	Date.now = () => realNow() + 5000;
	try {
		await events.get("message_update")?.(
			{ assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "!" } },
			ctx,
		);
		const later = visible(messages.at(-1) ?? "");
		assert.doesNotMatch(later, /· \d+s\)$/, "再久也不显示耗时");
		assert.doesNotMatch(later, /tok\/s/, "working 行不显示速率");
	} finally {
		Date.now = realNow;
	}
});

test("tool activity is named in the status line", async () => {
	const { events, messages, ctx } = install();
	await events.get("turn_start")?.({}, ctx);
	await events.get("tool_execution_start")?.({ toolCallId: "1", toolName: "read" }, ctx);
	await events.get("tool_execution_start")?.({ toolCallId: "2", toolName: "bash" }, ctx);
	assert.match(visible(messages.at(-1) ?? ""), /Reading 1 file, Running 1 shell command/);
	await events.get("tool_execution_end")?.({ toolCallId: "1" }, ctx);
	assert.match(visible(messages.at(-1) ?? ""), /Running 1 shell command/);
	assert.doesNotMatch(visible(messages.at(-1) ?? ""), /Reading/);
});

test("spinner shimmer helpers behave", () => {
	assert.equal(hexToAnsiFg("#b1b9f9"), "\u001B[38;2;177;185;249m");
	assert.equal(hexToAnsiFg("borderAccent"), null);
	assert.deepEqual(parseAnsiRgb("\u001B[38;2;10;20;30m"), { r: 10, g: 20, b: 30 });
	const { baseRgb } = resolveShimmerColors("\u001B[38;2;177;185;249m");
	assert.deepEqual(baseRgb, { r: 177, g: 185, b: 249 });
	// colorSweep never emits an empty frame and the band stays in width.
	const swept = colorSweep("Cooking…", 3, baseRgb, { r: 255, g: 255, b: 255 });
	assert.ok(swept.length > "Cooking…".length);
	assert.ok(visible(swept).endsWith("Cooking…"));
});

test("stalled hint appears after 30s idle without tools, suppressed while tools run", async () => {
	const { events, messages, ctx } = install();
	const realNow = Date.now;
	let now = 1_000_000;
	Date.now = () => now;
	try {
		await events.get("turn_start")?.({}, ctx);
		now += 10_000;
		await events.get("message_update")?.(
			{ assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi" } },
			ctx,
		);
		assert.doesNotMatch(visible(messages.at(-1) ?? ""), /stalled/);
		// 工具执行中不报（预期内等待）：用未知 id 触发重建但保留真工具。
		await events.get("tool_execution_start")?.({ toolCallId: "1", toolName: "bash" }, ctx);
		now += 60_000;
		await events.get("tool_execution_end")?.({ toolCallId: "unknown" }, ctx);
		assert.doesNotMatch(visible(messages.at(-1) ?? ""), /stalled/);
		await events.get("tool_execution_end")?.({ toolCallId: "1" }, ctx);
		// 真工具结束、31s 无活动 → 报 stalled。
		await events.get("tool_execution_end")?.({ toolCallId: "unknown" }, ctx);
		assert.match(visible(messages.at(-1) ?? ""), /stalled 1m 0s/);
	} finally {
		Date.now = realNow;
	}
});
