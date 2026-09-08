import assert from "node:assert/strict";
import test from "node:test";
import { UserMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import {
	indentEditorContinuationLine,
	normalizeUserContextBranches,
	prefixEditorPromptLine,
	renderUserMessageLine,
	stripAttachedImagePathsBlock,
	trimUserMessagePadding,
} from "../extensions/renderer/user-message.ts";
import { stripAnsi } from "../extensions/utils/ansi-text.ts";

const paint = {
	bg: (t: string) => `[${t}]`,
	dim: (t: string) => `<${t}>`,
};
// 布局断言用恒等 paint（无标记占位）；着色另测。
const flat = {
	bg: (t: string) => t,
	dim: (t: string) => t,
};
initTheme("dark");

test("首行❯续行顶齐", () => {
	assert.equal(renderUserMessageLine("你好", 20, true, flat), "❯ 你好              ");
	// dim 包住 ❯ 前缀（marker 占 2 可见列， pad 相应少 2）。
	assert.equal(renderUserMessageLine("你好", 20, true, paint), "[<❯ >你好            ]");
	assert.equal(renderUserMessageLine("续行", 20, false, flat), "  续行              ");
});

test("整宽垫满，超宽截断", () => {
	const line = renderUserMessageLine("hi", 10, true, flat);
	assert.equal(line.length, 10);
	const long = renderUserMessageLine(`x${"y".repeat(50)}`, 20, true, flat);
	assert.equal(stripAnsi(long).length, 20);
});

test("去上下留白与孤立提示符行", () => {
	assert.deepEqual(trimUserMessagePadding(["", "  ", "❯", "", "正文", ""]), ["正文"]);
	assert.deepEqual(trimUserMessagePadding(["正文", "  "]), ["正文"]);
});

test("附件树收成单个⎿，后续变续行", () => {
	const out = normalizeUserContextBranches(["正文", "├ file a", "└ file b"]);
	assert.equal(out[0], "正文");
	assert.ok(out[1]!.startsWith("⎿"));
	assert.equal(out[2]!.charCodeAt(0), 0xe000);
});

test("图片块仅尾部完整才剥", () => {
	const tail = ["正文", "Attached image paths:", "- [#image 1]: /a.png"];
	assert.deepEqual(stripAttachedImagePathsBlock(tail), ["正文"]);
	const nonTail = ["Attached image paths:", "- [#image 1]: /a.png", "后面还有正文"];
	assert.deepEqual(stripAttachedImagePathsBlock(nonTail), nonTail);
	const broken = ["正文", "Attached image paths:", "- 不是图片行"];
	assert.deepEqual(stripAttachedImagePathsBlock(broken), broken);
});

test("输入框：提示行加❯，续行对齐，bash ! 与已装饰放过", () => {
	assert.equal(prefixEditorPromptLine("    hello", 4, 40), "❯ hello");
	assert.equal(indentEditorContinuationLine("    second", 4, 40), "  second");
	assert.equal(prefixEditorPromptLine("!ls", 0, 40), "!ls");
	assert.equal(prefixEditorPromptLine("❯ hi", 0, 40), "❯ hi");
});

test("原型补丁安装/卸载与off回退", async () => {
	const { installUserMessageRender } = await import("../extensions/renderer/user-message.ts");
	const { config } = await import("../extensions/config/config.ts");
	const prototype = (UserMessageComponent as any).prototype;
	const original = prototype.render;
	const prevMode = config.mode;
	try {
		const dispose = installUserMessageRender();
		assert.notEqual(prototype.render, original);
		// off 时直通原生：真实组件渲染不抛且无 ❯ 前缀。
		config.mode = "off";
		const native = new UserMessageComponent("hello") as any;
		const lines = prototype.render.call(native, 40) as string[];
		assert.ok(Array.isArray(lines) && lines.length > 0);
		assert.ok(!lines.some((line: string) => stripAnsi(line).startsWith("❯")));
		config.mode = prevMode === "off" ? "on" : prevMode;
		dispose();
		assert.equal(prototype.render, original);
	} finally {
		config.mode = prevMode;
		if (prototype.render !== original) prototype.render = original;
	}
});
