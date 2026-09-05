import { test } from "node:test";
import assert from "node:assert";
import { Markdown, visibleWidth } from "@earendil-works/pi-tui";
import {
	PLAIN_FENCE_LANGS,
	boxRenderedCodeBlock,
	installCodeBlockBox,
	parseRenderedFenceLine,
	resolveBorderColor,
	roundedCodeBlockBottom,
	roundedCodeBlockTop,
	sanitizeRenderedTextBlockLines,
	setCodeBlockTheme,
} from "../extensions/renderer/tool/code-block.ts";
import { stripAnsi } from "../extensions/utils/ansi-text.ts";

test("fence 行解析（含主题 ANSI）", () => {
	assert.deepEqual(parseRenderedFenceLine("```python"), { kind: "open", language: "python" });
	assert.deepEqual(parseRenderedFenceLine("```"), { kind: "close", language: "" });
	assert.deepEqual(parseRenderedFenceLine("\x1b[2m```js\x1b[0m"), {
		kind: "open",
		language: "js",
	});
	assert.strictEqual(parseRenderedFenceLine("普通文本"), undefined);
	assert.strictEqual(parseRenderedFenceLine("```a`b"), undefined);
});

test("单 python 块套框：fence 消失、圆角+语言标签", () => {
	const out = sanitizeRenderedTextBlockLines(["```python", "print(1)", "```"], 40);
	assert.strictEqual(out.length, 3);
	assert.ok(!out.some((l) => stripAnsi(l).includes("```")), JSON.stringify(out));
	assert.ok(stripAnsi(out[0]).startsWith("╭") && stripAnsi(out[0]).endsWith("╮"));
	assert.ok(stripAnsi(out[0]).includes("python"));
	assert.ok(stripAnsi(out[2]).startsWith("╰") && stripAnsi(out[2]).endsWith("╯"));
	assert.ok(stripAnsi(out[1]).startsWith("│") && stripAnsi(out[1]).endsWith("│"));
	assert.ok(stripAnsi(out[1]).includes("print(1)"));
});

test("plain 语言不套框、只去标记", () => {
	for (const lang of ["", "text", "txt", "plain", "plaintext"]) {
		const out = sanitizeRenderedTextBlockLines([`\`\`\`${lang}`, "raw", "```"], 40);
		assert.deepEqual(out, ["raw"], lang || "(empty)");
	}
	assert.ok(PLAIN_FENCE_LANGS.has(""));
});

test("未闭合 fence 保持原文", () => {
	const out = sanitizeRenderedTextBlockLines(["```python", "print(1)"], 40);
	assert.deepEqual(out, ["```python", "print(1)"]);
});

test("孤立 closing fence 不丢行", () => {
	const out = sanitizeRenderedTextBlockLines(["正文", "```", "更多"], 40);
	assert.deepEqual(out, ["正文", "```", "更多"]);
});

test("多块各自套框、普通行透传", () => {
	const out = sanitizeRenderedTextBlockLines(
		["```js", "a", "```", "text", "```py", "b", "```"],
		40,
	);
	assert.strictEqual(out.length, 7);
	assert.ok(stripAnsi(out[0]).includes("js"));
	assert.strictEqual(out[3], "text");
	assert.ok(stripAnsi(out[4]).includes("py"));
});

test("窄宽度降级不断言", () => {
	assert.strictEqual(stripAnsi(roundedCodeBlockTop(1, "ts")), "│");
	assert.strictEqual(stripAnsi(roundedCodeBlockBottom(0)), "│");
	assert.ok(stripAnsi(roundedCodeBlockTop(10, "")).startsWith("╭"));
});

test("超宽行截断到框内", () => {
	const [top, body, bottom] = boxRenderedCodeBlock(["x".repeat(100)], "ts", 20);
	assert.ok(visibleWidth(top) <= 20, `top width ${visibleWidth(top)}`);
	assert.ok(visibleWidth(body) <= 20, `body width ${visibleWidth(body)}`);
	assert.ok(visibleWidth(bottom) <= 20, `bottom width ${visibleWidth(bottom)}`);
});

test("顶行标签有呼吸感且占满宽度", () => {
	const top = roundedCodeBlockTop(40, "python");
	assert.ok(stripAnsi(top).startsWith("╭── python "), JSON.stringify(stripAnsi(top)));
	assert.strictEqual(visibleWidth(top), 40);
	assert.strictEqual(visibleWidth(roundedCodeBlockBottom(40)), 40);
});

test("框线色跟主题走，取不到回退固定灰", () => {
	const themed = resolveBorderColor({
		codeBlockBorder: (s: string) => `\x1b[38;2;54;49;63m${s}\x1b[0m`,
	});
	assert.strictEqual(themed, "\x1b[38;2;54;49;63m");
	assert.strictEqual(resolveBorderColor(undefined), "\x1b[38;5;238m");
	assert.strictEqual(resolveBorderColor({}), "\x1b[38;5;238m");
	const out = sanitizeRenderedTextBlockLines(["```js", "a", "```"], 30, themed);
	assert.ok(out[0]!.startsWith(themed), JSON.stringify(stripAnsi(out[0]!)));
});

test("框线色优先用 UI 主题 accent（与 spinner 同源）", () => {
	setCodeBlockTheme({
		getFgAnsi: (key: string) => (key === "borderAccent" ? "\x1b[38;2;177;185;249m" : ""),
	});
	try {
		assert.strictEqual(resolveBorderColor(undefined), "\x1b[38;2;177;185;249m");
		const out = sanitizeRenderedTextBlockLines(["```js", "a", "```"], 30);
		assert.ok(out[0]!.startsWith("\x1b[38;2;177;185;249m"));
	} finally {
		setCodeBlockTheme(undefined);
	}
});

test("borderAccent 缺失时退到 accent，再退到实例样本", () => {
	setCodeBlockTheme({ getFgAnsi: (key: string) => (key === "accent" ? "ACC" : "") });
	try {
		assert.strictEqual(resolveBorderColor(undefined), "ACC");
	} finally {
		setCodeBlockTheme(undefined);
	}
	setCodeBlockTheme({ getFgAnsi: () => "" });
	try {
		assert.strictEqual(
			resolveBorderColor({ codeBlockBorder: (s: string) => `\x1b[31m${s}\x1b[0m` }),
			"\x1b[31m",
		);
	} finally {
		setCodeBlockTheme(undefined);
	}
});

test("Markdown.render 补丁幂等：重复安装只套一层框", () => {
	installCodeBlockBox();
	installCodeBlockBox();
	const theme = {
		heading: (s: string) => s,
		link: (s: string) => s,
		linkUrl: (s: string) => s,
		code: (s: string) => s,
		codeBlock: (s: string) => s,
		codeBlockBorder: (s: string) => s,
		quote: (s: string) => s,
		quoteBorder: (s: string) => s,
		hr: (s: string) => s,
		listBullet: (s: string) => s,
		bold: (s: string) => s,
		italic: (s: string) => s,
		strikethrough: (s: string) => s,
		underline: (s: string) => s,
	};
	const md = new Markdown("```python\nprint(1)\n```", 0, 0, theme);
	const lines = md.render(40);
	const tops = lines.filter((l) => stripAnsi(l).startsWith("╭"));
	assert.strictEqual(tops.length, 1, JSON.stringify(lines.map((l) => stripAnsi(l))));
	assert.ok(lines.every((l) => visibleWidth(l) <= 40));
});
