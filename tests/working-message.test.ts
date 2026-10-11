import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import workingMessageExtension from "../extensions/feature/shell/working-message.ts";
import { config } from "../extensions/config/config.ts";
import { installCompactMode } from "../extensions/renderer/compact-mode.ts";
import { setToolMouseTui } from "../extensions/renderer/mouse/scroll.ts";
import { WriteExecutionMetadataStore } from "../extensions/renderer/tool/diff/write-execution.ts";

initTheme("dark");

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
	return { events, messages, ctx };
}

test("working message appends token count and elapsed time while streaming", async () => {
	const { events, messages, ctx } = install();

	await events.get("turn_start")?.({}, ctx);
	// No tokens yet and under the timer threshold: keep Pi's default "Working...".
	assert.equal(messages.at(-1), undefined);

	const delta = "This is a streaming response body long enough to count some tokens.";
	await events.get("message_update")?.(
		{ assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
		ctx,
	);
	await events.get("message_update")?.(
		{ assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } },
		ctx,
	);
	const working = messages.at(-1);
	assert.match(working ?? "", /^Working\.\.\. \(↓ \d+ tokens · \d+s\)$/);

	await events.get("turn_end")?.({}, ctx);
	assert.equal(messages.at(-1), undefined, "turn end restores default without a completion line");
	assert.equal(
		messages.some((message) => message?.startsWith("✻ Turn took")),
		false,
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
	const first = messages.at(-1) ?? "";
	assert.match(first, /↓ 1 tokens/);

	await events.get("message_update")?.(
		{ assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "abcd" } },
		ctx,
	);
	assert.match(messages.at(-1) ?? "", /↓ 2 tokens/);

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
	assert.match(messages.at(-1) ?? "", /↓ 2 tokens/);

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
	assert.match(messages.at(-1) ?? "", /↓ 4 tokens/);

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
	assert.match(messages.at(-1) ?? "", /↓ 37 tokens/);

	// 同一条用户指令的下一段 turn 不清 token：工具后继续累计。
	await events.get("turn_end")?.({}, ctx);
	await events.get("turn_start")?.({}, ctx);
	assert.match(messages.at(-1) ?? "", /↓ 37 tokens/);
});

// 摘要行会被外层消息顶出视口：fullscreen 离开底部时才镜像摘要文案。
test("compact 活动回合：fullscreen 离开底部才镜像摘要，regular 不替换", async () => {
	const previousMode = config.mode;
	config.mode = "compact";
	// 官方 fullscreen 惰性 Proxy：requestRender 每次 get 返回新函数。
	const tui: any = {
		mode: "fullscreen",
		isFollowingOutput: false,
		get requestRender() {
			return () => {};
		},
	};
	setToolMouseTui(tui);
	const hooks = installCompactMode({ writeMetadata: new WriteExecutionMetadataStore() });
	try {
		const message = {
			role: "assistant",
			timestamp: 1,
			content: [{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "echo" } }],
		};
		const assistant = new AssistantMessageComponent(message as any, true) as any;
		assistant.updateContent(message);

		const { events, messages, ctx } = install();
		const pushDelta = () =>
			events.get("message_update")?.(
				{ assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "abcd" } },
				ctx,
			);

		await events.get("turn_start")?.({}, ctx);
		const mirrored = messages.at(-1) ?? "";
		assert.match(
			mirrored,
			/^Running\.\.\.(?: · [\d.]+m?s)?, bash×1/,
			`离开底部时应镜像摘要文案: ${mirrored}`,
		);
		assert.doesNotMatch(mirrored, /click to show more/, `不带展开入口: ${mirrored}`);
		assert.doesNotMatch(mirrored, /^Working\.\.\./, `不再走 Pi 默认文案: ${mirrored}`);

		// token 段仍附加在摘要后面；回合时长由摘要行自带，不叠 agent 计时。
		await pushDelta();
		const withTokens = messages.at(-1) ?? "";
		assert.match(withTokens, /bash×1 · ↓ 1 tokens/, `摘要后接 token: ${withTokens}`);

		// 跟回底部：摘要行重新可见，不镜像。
		tui.isFollowingOutput = true;
		await pushDelta();
		assert.match(messages.at(-1) ?? "", /^Working\.\.\. \(↓ \d+ tokens/, "在底部时不镜像");

		// regular：没有“离开底部”信号，即使不在底部也不替换。
		tui.mode = "regular";
		tui.isFollowingOutput = false;
		// 非惰性 Proxy：requestRender 固定，不再每次 get 返回新函数。
		Object.defineProperty(tui, "requestRender", {
			value: () => {},
			configurable: true,
			writable: true,
		});
		await pushDelta();
		assert.match(messages.at(-1) ?? "", /^Working\.\.\. \(↓ \d+ tokens/, "regular 不替换");

		// 最终回答接手：回合收尾（清空镜像），回到 fullscreen 离开底部也不再显示摘要。
		assistant.updateContent({
			role: "assistant",
			timestamp: 2,
			content: [{ type: "text", text: "done" }],
		});
		tui.mode = "fullscreen";
		Object.defineProperty(tui, "requestRender", {
			get: () => () => {},
			configurable: true,
		});
		await pushDelta();
		assert.match(messages.at(-1) ?? "", /^Working\.\.\. \(↓ \d+ tokens/, "回合结束后回落默认");
	} finally {
		hooks.shutdown();
		setToolMouseTui(null);
		config.mode = previousMode;
	}
});

// Pi 的 ctx 失效后 getter 会抛错；定时器里逃逸的异常会直接终止 Pi 进程 (#41)。
test("refresh timer stops quietly once the captured ctx goes stale", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { events, messages } = install();
	let stale = false;
	let probes = 0;
	const ctx = {
		get hasUI() {
			probes++;
			if (stale)
				throw new Error("This extension ctx is stale after session replacement or reload.");
			return true;
		},
		get ui() {
			if (stale) throw new Error("stale");
			return { setWorkingMessage: (message?: string) => messages.push(message) };
		},
	};

	await events.get("turn_start")?.({}, ctx);
	stale = true;
	assert.doesNotThrow(() => t.mock.timers.tick(1_000));
	const probesAfterStale = probes;
	t.mock.timers.tick(5_000);
	assert.equal(probes, probesAfterStale, "loop must stop after the stale probe");

	// 失效窗口内到达的事件也不应抛错或重新拉起循环。
	await events.get("message_update")?.(
		{ assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "abcd" } },
		ctx,
	);
	await events.get("turn_start")?.({}, ctx);
	await events.get("session_shutdown")?.({}, ctx);
});
