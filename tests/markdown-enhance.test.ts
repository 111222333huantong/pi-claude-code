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
	const md = "```mermaid\ngraph LR\nA --> B\n```\n\n> [!NOTE] 提示\n\n看 https://example.com";
	assert.strictEqual(
		run(md, { messageType: "assistant-thinking", isStreaming: false, availableWidth: 100 }),
		md,
	);
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

test("admonition 转换", () => {
	assert.ok(run("> [!WARNING] 磁盘不足\n> 续行\n\n正文").includes("> **⚠️ WARNING** 磁盘不足 续行"));
	assert.ok(run("> [!NOTE] 提示").includes("> **💡 NOTE** 提示"));
	assert.ok(run("> [!warning] 小心").includes("WARNING"));
	assert.strictEqual(run("> 普通引用").trim(), "> 普通引用");
});

test("admonition 引用块后空行", () => {
	const out = run("> [!WARNING] 磁盘不足\n\n正文");
	// 提示框后至少有一个空行，防止紧接段落被合并
	assert.ok(out.includes("> **⚠️ WARNING** 磁盘不足\n\n"), JSON.stringify(out));
});

test("代码块内 admonition 不转换", () => {
	const out = run("```md\n> [!NOTE] 示例\n```\n\n> [!NOTE] 块外");
	assert.ok(out.includes("> [!NOTE] 示例"));
	assert.ok(out.includes("> **💡 NOTE** 块外"));
});

test("admonition 内容 | 保留", () => {
	const out = run("> [!NOTE] 参数 a|b 说明");
	assert.ok(out.includes("a|b"), JSON.stringify(out));
});

test("嵌套提示框不互相吞并", () => {
	const out = run("> [!NOTE] 甲\n> [!WARNING] 乙");
	assert.ok(out.includes("> **💡 NOTE** 甲") && out.includes("> **⚠️ WARNING** 乙"));
});

test("裸 URL 转换", () => {
	const out = run("访问 https://example.com/path 看看。");
	assert.ok(out.includes("[https://example.com/path](https://example.com/path)"));
});

test("中文标点截断", () => {
	const out = run("看 https://example.com/a，和 https://b.com/x. 结束");
	assert.ok(out.includes("[https://example.com/a](https://example.com/a)，"));
	assert.ok(out.includes("[https://b.com/x](https://b.com/x)"));
});

test("行内代码与 <url> 不动", () => {
	const out = run("用 `https://code.com/x` 和 <https://auto.com> 和 https://plain.com");
	assert.ok(out.includes("`https://code.com/x`"));
	assert.ok(!out.includes("[https://code.com/x]"));
	assert.ok(out.includes("<https://auto.com>"));
	assert.ok(out.includes("[https://plain.com](https://plain.com)"));
});

test("已有链接/图片保护", () => {
	const out = run("链接 [点我](https://example.com) 图片 ![图](https://img.com/a.png)");
	assert.ok(out.includes("[点我](https://example.com)"));
	assert.ok(out.includes("![图](https://img.com/a.png)"));
});

test("含括号 URL 保留（括号平衡）", () => {
	const out = run("见 https://en.wikipedia.org/wiki/A_(B) 结束");
	assert.ok(
		out.includes("[https://en.wikipedia.org/wiki/A_(B)](https://en.wikipedia.org/wiki/A_(B))"),
		JSON.stringify(out),
	);
});

test("尾部 ] 与不成对 ) 截掉（避免无效链接）", () => {
	// 列表项 [url] 的闭合方括号不能吞进链接
	const out = run("列表 [https://example.com/a] 项");
	assert.ok(
		out.includes("[[https://example.com/a](https://example.com/a) 项"),
		JSON.stringify(out),
	);
	// 尾部不成对 ) 截掉
	const out2 = run("尾括号 https://example.com/x)");
	assert.ok(out2.includes("[https://example.com/x](https://example.com/x)"), JSON.stringify(out2));
});

test("全角括号不吞进 URL", () => {
	const out = run("全角（https://example.com/a）");
	assert.ok(
		out.includes("（[https://example.com/a](https://example.com/a)）"),
		JSON.stringify(out),
	);
});

test("IPv6 URL 保留方括号", () => {
	const out = run("IPv6 https://[::1]:8080/x 保留");
	assert.ok(out.includes("[https://[::1]:8080/x](https://[::1]:8080/x)"), JSON.stringify(out));
});

test("代码块内 URL 不动", () => {
	const out = run('```js\nconst u = "https://code.com/x";\n```\n外链 https://outside.com');
	assert.ok(!out.includes("[https://code.com/x]"));
	assert.ok(out.includes("[https://outside.com](https://outside.com)"));
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

	const quotedUrl = run("> ```\n> see https://example.com/a\n> ```\n正文 https://example.com/b");
	assert.ok(!quotedUrl.includes("[https://example.com/a]"));
	assert.ok(quotedUrl.includes("[https://example.com/b](https://example.com/b)"));
});
