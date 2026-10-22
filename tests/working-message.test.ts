import assert from "node:assert/strict";
import test from "node:test";
import { parseAnsiRgb } from "../extensions/feature/shell/spinner-color.ts";
import { _resetSpinnerSettingsCache } from "../extensions/feature/shell/spinner-settings.ts";
import {
	colorSweep,
	hexToAnsiFg,
	resolveShimmerColors,
	shimmerPosition,
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

test("tool call argument deltas count toward the token total", async () => {
	const { events, messages, ctx } = install();
	await events.get("turn_start")?.({}, ctx);
	await events.get("message_update")?.(
		{ assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: {} } },
		ctx,
	);
	// 写文件这类工具的参数走 toolcall_delta。
	await events.get("message_update")?.(
		{
			assistantMessageEvent: {
				type: "toolcall_delta",
				contentIndex: 0,
				delta: '{"path":"a.txt"}',
				partial: {},
			},
		},
		ctx,
	);
	assert.match(messages.at(-1) ?? "", /↓ 4 tokens/);
	await events.get("turn_end")?.({}, ctx);
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

test("shimmer ping-pong turns around without snapping past the last char", () => {
	// 旧公式把 total 当折返点，峰值会冲到 total 再跳回 total-1-ε；新公式在
	// total-1 折返，扫光到词尾后平滑返回。
	assert.ok(Math.abs(shimmerPosition(9.9, 10) - 8.1) < 1e-9);
	assert.ok(Math.abs(shimmerPosition(10.1, 10) - 7.9) < 1e-9);
	assert.ok(Math.abs(shimmerPosition(0.5, 10) - 0.5) < 1e-9);
	// 相邻 16ms 帧（最长动词 interval=90ms，约 0.18 帧）位置连续。
	for (const total of [2, 3, 10, 21]) {
		for (let frame = 0; frame < 3 * (total - 1); frame += 0.18) {
			const delta = Math.abs(shimmerPosition(frame + 0.18, total) - shimmerPosition(frame, total));
			assert.ok(delta <= 0.19, `total=${total} frame=${frame} jump=${delta}`);
		}
	}
});

test("a second factory instance (project-trust preload) must not freeze the live shimmer", async () => {
	// Pi 在 project-trust 预检时会先跑一遍全部扩展工厂，再跑最终实例。
	// 若代际在工厂执行时领取，先加载的实例会立刻“过期”，shimmer 每帧
	// 自退订、只能靠 message_update 重订阅 —— 表现为扫光卡住。
	const live = install();
	const pretrust = install();
	// 只有真正绑定会话的实例才会收到 session_start。
	await live.events.get("session_start")?.({}, live.ctx);
	await live.events.get("turn_start")?.({}, live.ctx);
	// 未绑定会话的实例不应影响 live 实例。
	assert.equal(pretrust.messages.length, 0);

	const before = live.messages.length;
	await new Promise((resolve) => setTimeout(resolve, 80));
	assert.ok(live.messages.length > before + 1, "live instance keeps shimmering");

	await live.events.get("session_shutdown")?.({}, live.ctx);
});

test("shimmer survives a transient stale ctx", async () => {
	const { events, messages } = install();
	let stale = false;
	const ctx = {
		get hasUI() {
			if (stale) throw new Error("stale");
			return true;
		},
		ui: { setWorkingMessage: (message?: string) => messages.push(message) },
	};
	await events.get("turn_start")?.({}, ctx);
	// 单次 stale 探测不应永久停掉扫光；下一拍恢复即可继续。
	stale = true;
	await new Promise((resolve) => setTimeout(resolve, 40));
	stale = false;
	const before = messages.length;
	await new Promise((resolve) => setTimeout(resolve, 80));
	assert.ok(messages.length > before + 1, "stale 恢复后扫光继续推进");
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
