import assert from "node:assert/strict";
import test from "node:test";
import { UserMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import {
	addArrowToFirstLine,
	prefixEditorPromptLine,
} from "../extensions/renderer/user-message.ts";
import {
	stripAnsi,
	stripTerminalSequencesPreservingLayout,
} from "../extensions/utils/ansi-text.ts";

initTheme("dark");

const dim = (t: string) => `<${t}>`;

test("首个有字行加❯，其余行逐字节不动", () => {
	const lines = ["   ", "hello", "second"];
	const out = addArrowToFirstLine(lines, 40, dim);
	assert.equal(out[0], "   ");
	assert.equal(out[1], "<❯ >hello");
	assert.equal(out[2], "second");
	assert.equal(lines[1], "hello");
});

test("行首已有❯/›则替换，保持只一个箭头", () => {
	assert.deepEqual(addArrowToFirstLine(["› hi"], 40, dim), ["<❯> hi"]);
	assert.deepEqual(addArrowToFirstLine(["❯ hi"], 40, dim), ["<❯> hi"]);
});

test("空数组原样返回；超宽截断保宽", () => {
	assert.deepEqual(addArrowToFirstLine([], 40, dim), []);
	assert.deepEqual(addArrowToFirstLine(["   "], 40, dim), ["   "]);
	const out = addArrowToFirstLine([`x${"y".repeat(50)}`], 20, (t) => t);
	assert.equal(stripAnsi(out[0]!).length, 20);
	assert.ok(out[0]!.startsWith("❯ "));
});

test("输入框：提示行加❯，bash ! 与已装饰放过", () => {
	assert.equal(prefixEditorPromptLine("    hello", 4, 40), "❯ hello");
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

test("端到端：真实组件只多一个❯，其余行不动", async () => {
	const { installUserMessageRender } = await import("../extensions/renderer/user-message.ts");
	const { setMessageDisplayTheme } = await import("../extensions/renderer/tool/message-display.ts");
	const { config } = await import("../extensions/config/config.ts");
	setMessageDisplayTheme({
		fg: (color: string, text: string) => `<${color}:${text}>`,
		bg: (_color: string, text: string) => text,
	});
	const prototype = (UserMessageComponent as any).prototype;
	const original = prototype.render;
	const prevMode = config.mode;
	try {
		config.mode = "on";
		const dispose = installUserMessageRender();
		const component = new UserMessageComponent("你好\n第二行") as any;
		const nativeLines = original.call(component, 60) as string[];
		const out = prototype.render.call(component, 60) as string[];
		assert.equal(out.length, nativeLines.length);
		const first = out.findIndex(
			(line) => stripTerminalSequencesPreservingLayout(line).trim() !== "",
		);
		assert.ok(first !== -1);
		assert.ok(stripTerminalSequencesPreservingLayout(out[first]!).includes("❯"));
		out.forEach((line, i) => {
			if (i !== first) assert.equal(line, nativeLines[i]);
		});
		dispose();
	} finally {
		config.mode = prevMode;
		setMessageDisplayTheme(undefined);
		if (prototype.render !== original) prototype.render = original;
	}
});
