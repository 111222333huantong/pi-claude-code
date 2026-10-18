import assert from "node:assert/strict";
import test from "node:test";
import {
	CustomMessageComponent,
	ExtensionRunner,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { config } from "../extensions/config/config.ts";
import extension from "../extensions/index.ts";
import claudeCodeStyleExtension from "../extensions/renderer/index.ts";
import {
	installSubagentNotificationRenderer,
	refreshSubagentNotifications,
} from "../extensions/renderer/tool/subagent-notification.ts";
import { PROTOTYPE_ORIGINAL_KEY } from "../extensions/utils/patch-keys.ts";

initTheme("dark");

// 单独成文件：入口会装各模块的全局补丁，不能污染其他渲染测试。
const TYPE = "subagent-notification";
const PATCH_KEY = Symbol.for("pi.ccstyle.subagent-notification-renderer-patch");
const runnerPrototype = ExtensionRunner.prototype as any;
const nativeLookup = runnerPrototype.getMessageRenderer;

/** 本插件入口在扩展加载期注册的消息渲染器（不进 TUI 会话）。 */
function entryRenderers(): Map<string, unknown> {
	const renderers = new Map<string, unknown>();
	const pi: any = new Proxy(
		{},
		{
			get(_target, prop) {
				if (prop === "events") return { on: () => () => {}, emit() {} };
				if (prop === "registerMessageRenderer") {
					return (customType: string, renderer: unknown) => renderers.set(customType, renderer);
				}
				return () => {};
			},
		},
	);
	extension(pi);
	return renderers;
}

const ours = entryRenderers();
const lookupAfterLoad = runnerPrototype.getMessageRenderer;

const stripAnsi = (line: string) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

function rows(component: { render(width: number): string[] }): string[] {
	return component
		.render(120)
		.map((line) => stripAnsi(line).trimEnd())
		.filter(Boolean);
}

const DETAILS = { id: "6dae0e11-9341-43b", status: "completed", toolUses: 2 };

function notification(details: unknown) {
	return {
		role: "custom",
		customType: TYPE,
		content: "<task-notification>…</task-notification>",
		display: true,
		details,
		timestamp: 1,
	} as any;
}

/** pi-subagents 渲染器的替身：记下收到的消息，画一行可辨认的视图。 */
function upstreamRenderer() {
	const seen: unknown[] = [];
	const renderer = (message: unknown) => {
		seen.push(message);
		return new Text("upstream view", 0, 0);
	};
	return Object.assign(renderer, { seen });
}

/** 按加载顺序排列各扩展的 messageRenderers，走真实的 ExtensionRunner 查找方法。 */
function lookup(extensions: Map<string, unknown>[], customType = TYPE): any {
	return runnerPrototype.getMessageRenderer.call(
		{ extensions: extensions.map((messageRenderers) => ({ messageRenderers })) },
		customType,
	);
}

function card(renderer: unknown, message = notification(DETAILS)) {
	return new CustomMessageComponent(message, renderer as any);
}

function withMode(mode: typeof config.mode, run: () => void): void {
	const previous = config.mode;
	config.mode = mode;
	try {
		run();
	} finally {
		config.mode = previous;
	}
}

function withPatch(run: () => void): void {
	const dispose = installSubagentNotificationRenderer();
	try {
		run();
	} finally {
		dispose();
	}
}

const FINISHED_ROW = /^ ✓ Subagent Finished 6dae0e11-9341-43b · 2 tool uses/;

test("loading the extension registers no notification renderer and leaves the lookup alone", () => {
	assert.equal(ours.has(TYPE), false, "registering would hide pi-subagents' renderer in off mode");
	assert.equal(lookupAfterLoad, nativeLookup, "outside a TUI session the lookup is not patched");
	assert.equal((globalThis as any)[PATCH_KEY], undefined);
});

test("our view wins whether pi-subagents loads before or after us", () => {
	withPatch(() =>
		withMode("on", () => {
			const upstream = upstreamRenderer();
			const subagents = new Map<string, unknown>([[TYPE, upstream]]);
			for (const order of [
				[subagents, ours],
				[ours, subagents],
			]) {
				assert.match(rows(card(lookup(order)))[0]!, FINISHED_ROW);
			}
			assert.equal(upstream.seen.length, 0);

			const other = () => new Text("other", 0, 0);
			const others = new Map<string, unknown>([["other-notification", other]]);
			assert.equal(lookup([subagents, others, ours], "other-notification"), other);
			assert.equal(lookup([subagents, ours], "unknown-notification"), undefined);
		}),
	);
});

test("without pi-subagents a saved notification still renders; off falls back to Pi's generic card", () => {
	withPatch(() => {
		const renderer = lookup([ours]);
		assert.equal(typeof renderer, "function");
		withMode("compact", () => {
			assert.match(rows(card(renderer))[0]!, FINISHED_ROW);
			for (const details of [undefined, null]) {
				assert.deepEqual(rows(card(renderer, notification(details))), [
					" ✓ Subagent Finished · click to show more",
				]);
			}
		});
		withMode("off", () => {
			const generic = rows(card(renderer));
			assert.equal(generic[0]!.trim(), "[subagent-notification]");
			assert.deepEqual(generic, rows(card(undefined)), "same as Pi with no renderer at all");
		});
	});
});

test("off hands the message to pi-subagents untouched and mounted cards follow later toggles", () => {
	withPatch(() => {
		const upstream = upstreamRenderer();
		const renderer = lookup([new Map<string, unknown>([[TYPE, upstream]]), ours]);
		const message = notification({
			id: "6dae0e11-9341-43b",
			status: "completed",
			toolUses: 2,
			others: [{ id: "second", status: "error", error: "boom" }],
		});
		const snapshot = structuredClone(message);
		const root = new Container();
		const mounted = card(renderer, message);
		root.addChild(mounted);

		withMode("off", () => {
			refreshSubagentNotifications(root);
			assert.deepEqual(rows(mounted), ["upstream view"]);
			assert.equal(upstream.seen.at(-1), message, "upstream gets the original message object");
		});
		withMode("on", () => {
			refreshSubagentNotifications(root);
			assert.match(rows(mounted)[0]!, FINISHED_ROW);
		});
		withMode("off", () => {
			refreshSubagentNotifications(root);
			assert.deepEqual(rows(mounted), ["upstream view"]);
		});
		assert.deepEqual(message, snapshot, "content and details are not mutated");
	});
});

test("reinstalling hands existing cards to the new patch and a stale disposer keeps it", () => {
	withMode("on", () => {
		const upstream = upstreamRenderer();
		const runner = [new Map<string, unknown>([[TYPE, upstream]]), ours];
		const disposeFirst = installSubagentNotificationRenderer();
		const fromFirst = lookup(runner);
		const disposeSecond = installSubagentNotificationRenderer();
		try {
			assert.equal(
				runnerPrototype.getMessageRenderer[PROTOTYPE_ORIGINAL_KEY],
				nativeLookup,
				"the new patch wraps the native lookup, not the replaced one",
			);
			disposeFirst();
			assert.notEqual(runnerPrototype.getMessageRenderer, nativeLookup);
			assert.equal((globalThis as any)[PATCH_KEY]?.active, true);
			assert.match(rows(card(fromFirst))[0]!, FINISHED_ROW, "old callbacks use the new patch");
			assert.match(rows(card(lookup(runner)))[0]!, FINISHED_ROW);
		} finally {
			disposeSecond();
		}
		assert.equal(runnerPrototype.getMessageRenderer, nativeLookup);
		assert.equal((globalThis as any)[PATCH_KEY], undefined);
		assert.deepEqual(rows(card(fromFirst)), ["upstream view"], "after dispose cards go native");
		assert.equal(lookup(runner), upstream);
	});
});

test("a third-party wrapper over our lookup is preserved, and our inactive lookup is not rewrapped", (t) => {
	t.after(() => {
		runnerPrototype.getMessageRenderer = nativeLookup;
	});
	withMode("on", () => {
		const disposeFirst = installSubagentNotificationRenderer();
		const inner = runnerPrototype.getMessageRenderer;
		let wrapperCalls = 0;
		const wrapper = function (this: unknown, customType: string) {
			wrapperCalls++;
			return inner.call(this, customType);
		};
		runnerPrototype.getMessageRenderer = wrapper;
		const disposeSecond = installSubagentNotificationRenderer();
		try {
			assert.equal(runnerPrototype.getMessageRenderer[PROTOTYPE_ORIGINAL_KEY], wrapper);
			const upstream = upstreamRenderer();
			const renderer = lookup([new Map<string, unknown>([[TYPE, upstream]])]);
			assert.equal(wrapperCalls, 1);
			assert.match(rows(card(renderer))[0]!, FINISHED_ROW);
			withMode("off", () => {
				assert.deepEqual(rows(card(renderer)), ["upstream view"]);
				assert.equal(upstream.seen.length, 1, "dispatched once, not through two patches");
			});
		} finally {
			disposeSecond();
		}
		assert.equal(runnerPrototype.getMessageRenderer, wrapper, "dispose restores the wrapper");
		disposeFirst();
		assert.equal(runnerPrototype.getMessageRenderer, wrapper, "a wrapped patch cannot unhook it");
		const upstream = upstreamRenderer();
		assert.equal(lookup([new Map<string, unknown>([[TYPE, upstream]])]), upstream);

		// 包装方撤掉自己，把我们失效的查找放回最外层：重装时拆开它，直接包原生查找。
		runnerPrototype.getMessageRenderer = inner;
		const disposeThird = installSubagentNotificationRenderer();
		try {
			assert.equal(runnerPrototype.getMessageRenderer[PROTOTYPE_ORIGINAL_KEY], nativeLookup);
		} finally {
			disposeThird();
		}
		assert.equal(runnerPrototype.getMessageRenderer, nativeLookup);
	});
});

function runtime() {
	const events = new Map<string, Function>();
	return {
		events,
		pi: {
			registerCommand() {},
			registerShortcut() {},
			registerTool() {},
			on(name: string, handler: Function) {
				events.set(name, handler);
			},
		},
	};
}

test("a TUI session installs the lookup patch and shutdown removes it; other sessions do not", async () => {
	const headless = runtime();
	claudeCodeStyleExtension(headless.pi as any, { mode: "on" });
	await headless.events.get("session_start")?.({}, { mode: "print", hasUI: false });
	assert.equal(runnerPrototype.getMessageRenderer, nativeLookup);

	const session = runtime();
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus() {},
			requestRender() {},
		},
	} as any;
	claudeCodeStyleExtension(session.pi as any, { mode: "on" });
	try {
		await session.events.get("session_start")?.({}, ctx);
		assert.notEqual(runnerPrototype.getMessageRenderer, nativeLookup);
		assert.equal((globalThis as any)[PATCH_KEY]?.active, true);
		assert.match(rows(card(lookup([ours])))[0]!, FINISHED_ROW);
	} finally {
		await session.events.get("session_shutdown")?.({}, ctx);
	}
	assert.equal(runnerPrototype.getMessageRenderer, nativeLookup);
	assert.equal((globalThis as any)[PATCH_KEY], undefined);
});
