import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import {
	DottedParagraph,
	installDottedParagraphs,
} from "../extensions/renderer/assistant-paragraphs.ts";
import { installCodeBlockBox } from "../extensions/renderer/tool/code-block.ts";
import {
	stripAnsi,
	stripTerminalSequencesPreservingLayout,
} from "../extensions/utils/ansi-text.ts";

// 恒等主题：所见即所得，断言纯文本布局。
const identityTheme = {
	heading: (t: string) => t,
	link: (t: string) => t,
	linkUrl: (t: string) => t,
	code: (t: string) => t,
	codeBlock: (t: string) => t,
	codeBlockBorder: (t: string) => t,
	quote: (t: string) => t,
	quoteBorder: (t: string) => t,
	hr: (t: string) => t,
	listBullet: (t: string) => t,
	bold: (t: string) => t,
	italic: (t: string) => t,
	strikethrough: (t: string) => t,
	underline: (t: string) => t,
};

installCodeBlockBox();

const plain = (lines: string[]) =>
	lines.map((line) => stripTerminalSequencesPreservingLayout(line).trimEnd());

test("首行打点，续行补 3 空格对齐", () => {
	const para = new DottedParagraph(
		"第一行正文从这里开始\n第二行和下面都顶齐",
		identityTheme as any,
	);
	const lines = plain(para.render(60));
	assert.equal(lines[0], " ● 第一行正文从这里开始");
	assert.equal(lines[1], "   第二行和下面都顶齐");
});

test("空行只缩进不打点", () => {
	const para = new DottedParagraph("第一段\n\n第二段", identityTheme as any);
	const lines = plain(para.render(60));
	const raw = para.render(60).map((line) => stripAnsi(line));
	assert.equal(lines[0], " ● 第一段");
	assert.equal(raw[1]!.trim(), "");
	assert.equal(raw[1]!.includes("●"), false);
	assert.equal(lines[2], "   第二段");
});

test("混合代码块：文本打点，框线只缩进不断框", () => {
	const para = new DottedParagraph(
		"先说两句\n```python\nprint(1)\n```\n再说两句",
		identityTheme as any,
	);
	const lines = plain(para.render(60));
	assert.equal(lines[0], " ● 先说两句");
	const top = lines.findIndex((line) => line.trimStart().startsWith("╭"));
	assert.notEqual(top, -1);
	assert.equal(lines[top]!.startsWith(" ● "), false);
	assert.equal(lines[top]!.startsWith("   "), true);
	const bottom = lines.findIndex((line) => line.trimStart().startsWith("╰"));
	assert.notEqual(bottom, -1);
	assert.equal(lines[lines.length - 1], "   再说两句");
});

test("纯代码块：点打在 ╭ 框顶", () => {
	const para = new DottedParagraph("```js\nconst a = 1;\n```", identityTheme as any);
	const lines = plain(para.render(60));
	assert.equal(lines[0].startsWith(" ● ╭"), true);
	assert.equal(
		lines.slice(1).every((line) => line.startsWith("   ")),
		true,
	);
});

test("超窄宽度不崩；超宽行截断到 width", () => {
	const para = new DottedParagraph("第一行\n第二行", identityTheme as any);
	assert.deepEqual(
		plain(para.render(2)),
		["●"].map((s) => s),
	);
	const wide = new DottedParagraph(`x${"y".repeat(100)}`, identityTheme as any);
	for (const line of wide.render(20)) {
		assert.ok(stripAnsi(line).length <= 20);
	}
});

test("matches 复用 + toMarkdown 还原", () => {
	const theme = identityTheme as any;
	const para = new DottedParagraph("还原测试", theme);
	assert.equal(para.matches("还原测试", theme), true);
	assert.equal(
		para.matches("还原测试", theme, () => "x"),
		false,
	);
	assert.equal(para.matches("其他", theme), false);
	const first = para.render(60);
	assert.equal(para.render(60) === first, true);
	para.invalidate();
	assert.notEqual(para.render(60) === first, true);
	const restored = para.toMarkdown();
	assert.ok(restored instanceof Markdown);
	assert.deepEqual(
		plain(restored.render(60)),
		plain(new Markdown("还原测试", 0, 0, theme).render(60)),
	);
});

test("端到端：真实组件经补丁打出圆点（pi-coding-agent 内嵌 pi-tui 双实例回归）", () => {
	const dispose = installDottedParagraphs();
	try {
		const msg = {
			role: "assistant",
			timestamp: Date.now(),
			content: [{ type: "text", text: "你好！我是 Agnes。\n第二行正文。" }],
		} as any;
		const component = new AssistantMessageComponent(msg, true) as any;
		component.updateContent(msg);
		const lines = component
			.render(80)
			.map((line: string) => stripTerminalSequencesPreservingLayout(line).trimEnd())
			.filter((line: string) => line.length > 0);
		assert.ok(
			lines.some((line: string) => line.startsWith(" ● 你好")),
			`首行打点，实际: ${JSON.stringify(lines)}`,
		);
		assert.ok(
			lines.some((line: string) => line === "   第二行正文。"),
			`续行对齐，实际: ${JSON.stringify(lines)}`,
		);
	} finally {
		dispose();
	}
});
