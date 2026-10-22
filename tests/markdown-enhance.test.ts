import assert from "node:assert";
import { test } from "node:test";
import { default as enhance } from "../extensions/renderer/markdown-enhance.ts";

const transformers: Array<(md: string, ctx?: object) => string> = [];
enhance({
	registerMarkdownTransformer: (fn: (md: string, ctx?: object) => string) => transformers.push(fn),
} as never);
const run = (
	md: string,
	ctx = { messageType: "assistant", isStreaming: false, availableWidth: 100 },
) => transformers.reduce((acc, fn) => fn(acc, ctx), md);

test("mermaid 方言渲染", () => {
	assert.ok(run("```sequenceDiagram\nA->>B: hi\n```").includes("┌"));
	assert.ok(run("```stateDiagram-v2\n[*] --> S\n```").includes("╭"));
	assert.ok(run("```classDiagram\nclass A\n```").includes("┌"));
	assert.ok(run("```mermaid\ngraph LR\nA --> B\n```").includes("┌"));
});

test("四反引号围栏", () => {
	assert.ok(run("````mermaid\ngraph LR\nA --> B\n````").includes("┌"));
});

test("未闭合 fence 保留原文", () => {
	const out = run("```mermaid\ngraph LR\nA --> B");
	assert.ok(out.includes("```mermaid") && out.includes("A --> B"));
});

test("图行硬换行", () => {
	const out = run("```mermaid\ngraph LR\nA --> B\n```");
	const lines = out.split("\n").filter((l) => l.startsWith("`┌") || l.includes("┌────"));
	assert.ok(lines.length >= 1, JSON.stringify(out.slice(0, 80)));
});

test("宽度不足框装", () => {
	const out = run("```erdiagram\nCUSTOMER ||--o{ ORDER : places\n```", {
		messageType: "assistant",
		isStreaming: false,
		availableWidth: 10,
	});
	assert.ok(out.includes("╭"));
});

test("流式跳过", () => {
	const md = "```mermaid\ngraph LR\nA --> B\n```";
	assert.strictEqual(
		run(md, { messageType: "assistant", isStreaming: true, availableWidth: 100 }),
		md,
	);
});

test("thinking 块不转换（与官方推荐一致）", () => {
	const md = "```mermaid\ngraph LR\nA --> B\n```\n\n圈数字 ①\n\n看 https://example.com";
	assert.strictEqual(
		run(md, { messageType: "assistant-thinking", isStreaming: false, availableWidth: 100 }),
		md,
	);
});

test("裸 URL 与提示框不接管，交给 pi 原生渲染", () => {
	assert.strictEqual(
		run("访问 https://example.com/docs. 结束"),
		"访问 https://example.com/docs. 结束",
	);
	assert.strictEqual(run("> [!NOTE] 提示\n> 续行"), "> [!NOTE] 提示\n> 续行");
});

test("流式跨行链接不产生空白 OSC 8 点击区", () => {
	const md = "前缀 [\n](https://example.com)\n```md\n[代码\n链接](https://code.example)\n```";
	const out = run(md, {
		messageType: "assistant",
		isStreaming: true,
		availableWidth: 100,
	});
	assert.ok(out.includes("前缀 [](https://example.com)"), JSON.stringify(out));
	assert.ok(out.includes("[代码\n链接](https://code.example)"), JSON.stringify(out));
});

test("圈数字转半角括号（Nerd Font 字形缺陷规避）", () => {
	assert.strictEqual(run("方案②引入，共⑩项"), "方案(2)引入，共(10)项");
	assert.ok(run("① ② ⑳").includes("(1) (2) (20)"));
});

test("键帽/dingbat 数字转半角括号（缺 emoji 字体时方框规避）", () => {
	assert.strictEqual(
		run("### 1️⃣ `pi-cc-extensions` → `pi-claude-code` (v0.9.1)").split("\n")[0],
		"### (1) `pi-cc-extensions` → `pi-claude-code` (v0.9.1)",
	);
	assert.ok(run("步骤2️⃣和❶完成").includes("步骤(2)和(1)完成"));
	assert.ok(run("备选➊➓").includes("备选(1)(10)"));
	assert.ok(run("无 VS16 的 3⃣ 也转").includes("无 VS16 的 (3) 也转"));
});

const userCtx = { messageType: "user", isStreaming: false, availableWidth: 100 };

test("用户定界符公式透传原生（不再压平）", () => {
	const inline = run("inline $\\alpha + \\beta$ end", userCtx);
	assert.ok(inline.includes("$\\alpha + \\beta$"), JSON.stringify(inline));
	assert.ok(run("so \\(\\alpha\\) works", userCtx).includes("\\(\\alpha\\)"));
	const block = run("$$\n\\frac{a}{b} + x^{2}\n$$", userCtx);
	assert.ok(block.includes("$$") && block.includes("\\frac"), JSON.stringify(block));
});

test("用户紧凑单段保留旧 Unicode 转换（回归保护）", () => {
	assert.ok(run("\\frac{1}{2}", userCtx).includes("(1)/(2)"));
	assert.ok(run("\\[ x^{2} + \\sqrt{2} \\]", userCtx).includes("\\["));
});

test("价格与路径放过", () => {
	assert.strictEqual(run("价格 $5 和 $10 不动", userCtx), "价格 $5 和 $10 不动");
	assert.ok(run("看 C:\\opencode 路径", userCtx).includes("\\opencode"));
});

test("围栏与行内代码中的公式不动（含环境）", () => {
	const out = run(
		"```tex\n$\\alpha$\n\\begin{equation}\nx\n\\end{equation}\n```\n外边 $\\beta$ 好",
		userCtx,
	);
	assert.ok(out.includes("$\\alpha$"), JSON.stringify(out));
	assert.ok(out.includes("\\begin{equation}"), JSON.stringify(out));
	assert.ok(out.includes("$\\beta$"), JSON.stringify(out));
	assert.ok(run("行内 `$\\alpha$` 不动", userCtx).includes("$\\alpha$"));
});

test("助手消息不走用户数学链（留给原生）", () => {
	assert.ok(run("inline $\\alpha + \\beta$ end").includes("$\\alpha"));
});

test("未闭合定界符保留原文", () => {
	assert.ok(run("等式 $$\\alpha + 1", userCtx).includes("$$"));
	// 未闭合环境走旧单段兜底压平（与 c7074c5 一致，非泄漏）
	const env = run("\\begin{equation}\nx = 1", userCtx);
	assert.ok(!env.includes("\\begin{equation}") && env.includes("x = 1"), JSON.stringify(env));
});

test("equation/align 环境改写为 $$ 块（user 与 assistant）", () => {
	for (const ctx of [userCtx, { ...userCtx, messageType: "assistant" }]) {
		const eq = run("\\begin{equation}\nx = 1\n\\end{equation}", ctx);
		assert.ok(!eq.includes("\\begin"), JSON.stringify(eq));
		assert.ok(eq.includes("$$"), JSON.stringify(eq));
		const align = run("\\begin{align*}\na &= 1 \\\\\nb &= 2\n\\end{align*}", ctx);
		assert.ok(align.includes("$$") && align.includes("&="), JSON.stringify(align));
	}
});

test("$$ 区域内的嵌套环境不动", () => {
	const out = run("$$\n\\begin{matrix}\na & b\n\\end{matrix}\n$$", userCtx);
	assert.ok(out.includes("\\begin{matrix}"), JSON.stringify(out));
});

test("thinking 与流式跳过环境改写", () => {
	const src = "\\begin{equation}\nx = 1\n\\end{equation}";
	assert.ok(
		run(src, {
			messageType: "assistant-thinking",
			isStreaming: false,
			availableWidth: 100,
		}).includes("\\begin"),
	);
	assert.ok(
		run(src, { messageType: "assistant", isStreaming: true, availableWidth: 100 }).includes(
			"\\begin",
		),
	);
});

test("端到端：改写后原生竖排、无定界符泄漏", async () => {
	const { Markdown } = await import("@earendil-works/pi-tui");
	const id = (s: string) => s;
	const theme = {
		heading: id,
		link: id,
		linkUrl: id,
		code: id,
		codeBlock: id,
		codeBlockBorder: id,
		quote: id,
		quoteBorder: id,
		hr: id,
		listBullet: id,
		bold: id,
		italic: id,
		strikethrough: id,
		underline: id,
	};
	const render = (
		md: string,
		ctx: { messageType: string; isStreaming: boolean; availableWidth: number },
	): string[] => new Markdown(run(md, ctx), 0, 0, theme).render(50).map((l) => l.trim());
	// 用户 $$ 分数 → 原生堆叠三行
	const frac = render("$$\n\\frac{a}{b}\n$$", userCtx);
	assert.ok(frac.some((l) => l === "a") && frac.some((l) => l === "b"), JSON.stringify(frac));
	// 用户行内 → 原生上标
	assert.ok(render("值 $x^2$ 好", userCtx).some((l) => l.includes("x²")));
	// 环境改写后无泄漏
	const env = render("\\begin{equation}\nx = 1\n\\end{equation}", userCtx);
	assert.ok(!env.some((l) => l.includes("begin")), JSON.stringify(env));
	assert.ok(
		env.some((l) => l.includes("x = 1")),
		JSON.stringify(env),
	);
});

test("引用块和长围栏里的代码不被改写", () => {
	const quoted = run("> ```ts\n> const n = ①\n> ```\nplain ①");
	assert.match(quoted, /> const n = ①/);
	assert.match(quoted, /plain \(1\)/);

	const longer = run("````\n```\nstill code ①\n````\nafter ①");
	assert.match(longer, /still code ①/);
	assert.match(longer, /after \(1\)/);

	const tilde = run("~~~\ncode ①\n~~~\nafter ①");
	assert.match(tilde, /code ①/);
	assert.match(tilde, /after \(1\)/);

	const indented = run("   ```\n  code ①\n   ```\nafter ①");
	assert.match(indented, /code ①/);
	assert.match(indented, /after \(1\)/);
});
