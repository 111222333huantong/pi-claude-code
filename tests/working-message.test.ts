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
	// 耐心阈值内：token 计数先出现，elapsed 压着不放（1.5s 前是噪音）。
	assert.match(working, /↓ \d+ tokens\)$/);
	assert.doesNotMatch(working, /· \d+s\)$/);

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

	// Provider usage replaces the live chars/4 estimate when available.
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

	// A new turn resets both estimated and provider counts.
	await events.get("turn_end")?.({}, ctx);
	await events.get("turn_start")?.({}, ctx);
	assert.match(visible(messages.at(-1)), /… \(esc to interrupt\)$/);
});

test("elapsed reveals only after the 1.5s patience threshold", async () => {
	const { events, messages, ctx } = install();
	await events.get("turn_start")?.({}, ctx);
	await events.get("message_update")?.(
		{ assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi" } },
		ctx,
	);
	const early = visible(messages.at(-1) ?? "");
	assert.match(early, /↓ \d+ tokens\)$/, "token 计数立即出现");
	assert.doesNotMatch(early, /· \d+s\)$/, "1.5s 内不显示耗时");

	const realNow = Date.now;
	Date.now = () => realNow() + 2000;
	try {
		await events.get("message_update")?.(
			{ assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "!" } },
			ctx,
		);
		assert.match(visible(messages.at(-1) ?? ""), /· \d+s\)$/, "过阈值后耗时现身");
	} finally {
		Date.now = realNow;
	}
});

test("tok/s shows a sliding-window rate once samples span enough time", async () => {
	const { events, messages, ctx } = install();
	const delta = (text: string) =>
		events.get("message_update")?.(
			{ assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } },
			ctx,
		);
	const usage = (output: number) =>
		events.get("message_update")?.(
			{
				assistantMessageEvent: {
					type: "done",
					message: { content: [{ type: "text", text: "x" }], usage: { output } },
				},
			},
			ctx,
		);

	await events.get("turn_start")?.({}, ctx);
	await events.get("message_update")?.(
		{ assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
		ctx,
	);
	await usage(100);
	await delta("a"); // 触发 sync → 记样本 {t0, 100}
	assert.doesNotMatch(visible(messages.at(-1) ?? ""), /tok\/s/, "样本跨度 <1s 不出速率");

	const realNow = Date.now;
	try {
		// +500ms：跨度仍不足 1s，速率压着。
		Date.now = () => realNow() + 500;
		await usage(400);
		await delta("b");
		assert.doesNotMatch(visible(messages.at(-1) ?? ""), /tok\/s/);

		// +2s：窗口内 (700-100) tok / 2s = 350.0 tok/s。
		Date.now = () => realNow() + 2000;
		await usage(700);
		await delta("c");
		const rated = visible(messages.at(-1) ?? "");
		const rate = Number(/⚡ ([\d.]+) tok\/s/.exec(rated)?.[1]);
		assert.ok(Number.isFinite(rate) && Math.abs(rate - 350) < 2, `窗口速率 ≈350，got: ${rated}`);
	} finally {
		Date.now = realNow;
	}

	// 新一轮 turn 重置样本，不带残留速率。
	await events.get("turn_end")?.({}, ctx);
	await events.get("turn_start")?.({}, ctx);
	await events.get("message_update")?.(
		{ assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "seed" } },
		ctx,
	);
	assert.doesNotMatch(visible(messages.at(-1) ?? ""), /tok\/s/);
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
