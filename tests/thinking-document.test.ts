import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	hasThinkingLinkReferenceDefinition,
	hasThinkingMarkdownStructure,
	latestThinkingLines,
	parseThinkingDocument,
	ThinkingDocumentBuilder,
	thinkingDocumentCurrentTitle,
	thinkingDocumentSectionCount,
	thinkingDocumentTitle,
	thinkingSectionBody,
	wrapPlainThinkingText,
} from "../extensions/feature/thinking-document.ts";

test("thinking document splits provider sections and keeps bodies", () => {
	const raw = [
		"**排查缓存键**",
		"",
		"失败的测试指向 memo 过的布局。",
		"缓存键里没有宽度。",
		"",
		"**验证修复**",
		"",
		"把宽度放进缓存键。",
		"",
		"然后重跑 golden。",
	].join("\n");
	const doc = parseThinkingDocument(raw);
	assert.equal(doc.sections.length, 2);
	assert.equal(doc.sections[0]!.title, "排查缓存键");
	assert.equal(
		thinkingSectionBody(doc, doc.sections[0]!),
		"失败的测试指向 memo 过的布局。\n缓存键里没有宽度。",
	);
	assert.equal(doc.sections[1]!.title, "验证修复");
	assert.equal(
		thinkingSectionBody(doc, doc.sections[1]!),
		"把宽度放进缓存键。\n\n然后重跑 golden。",
	);
	assert.equal(thinkingDocumentCurrentTitle(doc), "验证修复");
	assert.equal(thinkingDocumentTitle(doc), "验证修复");
	assert.equal(thinkingDocumentSectionCount(doc), 2);
});

test("thinking document treats plain paragraphs as sections when no titles exist", () => {
	const doc = parseThinkingDocument("第一段。\n\n第二段。\n\n第三段。");
	assert.equal(doc.sections.length, 3);
	assert.equal(thinkingDocumentTitle(doc), undefined);
	assert.equal(thinkingDocumentCurrentTitle(doc), undefined);
	assert.deepEqual(latestThinkingLines(doc, 1), ["第三段。"]);
});

test("thinking document ignores headings and blank lines inside fences", () => {
	const raw = [
		"**Plan**",
		"",
		"```ts",
		"**not a title**",
		"",
		"const a = 1;",
		"```",
		"",
		"Done.",
	].join("\n");
	const doc = parseThinkingDocument(raw);
	assert.equal(doc.sections.length, 1);
	const body = thinkingSectionBody(doc, doc.sections[0]!);
	assert.match(body, /\*\*not a title\*\*/);
	assert.match(body, /const a = 1;/);
	assert.match(body, /Done\./);
});

test("bold lines only become titles at real block boundaries", () => {
	const midParagraph = parseThinkingDocument("intro line\n**emphasis**\nmore text");
	assert.equal(midParagraph.sections.length, 1);
	assert.equal(midParagraph.sections[0]!.title, undefined, "mid-paragraph bold is not a title");

	const noBlankAfter = parseThinkingDocument("**Lead**\nbody text");
	assert.equal(noBlankAfter.sections[0]!.title, undefined, "bold lead needs a blank line after it");

	const afterFence = parseThinkingDocument("```ts\nconst a = 1;\n```\n**After fence**\n\nbody");
	assert.equal(
		afterFence.sections[1]!.title,
		"After fence",
		"fence close counts as a block boundary",
	);

	const paragraphThenHeading = parseThinkingDocument("intro\n## Still a heading\n\nbody");
	assert.equal(paragraphThenHeading.sections[1]!.title, "Still a heading");

	const leading = parseThinkingDocument("**First**\n\nbody");
	assert.equal(leading.sections[0]!.title, "First", "document start counts as a block boundary");
});

test("link reference definitions are detected outside fences only", () => {
	assert.equal(
		hasThinkingLinkReferenceDefinition("see [docs]\n\n[docs]: https://example.com"),
		true,
	);
	assert.equal(
		hasThinkingLinkReferenceDefinition("```md\n[docs]: https://example.com\n```"),
		false,
		"definitions inside fences are plain code",
	);
	assert.equal(hasThinkingLinkReferenceDefinition("see [docs](https://example.com)"), false);
});

test("plain thinking wrap keeps grapheme clusters intact", () => {
	const family = "👨‍👩‍👧‍👦";
	const lines = wrapPlainThinkingText(`family ${family} ok`, 8);
	assert.ok(
		lines.some((line) => line.includes(family)),
		`emoji ZWJ sequence must not be split: ${JSON.stringify(lines)}`,
	);
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 8, `line over budget: ${JSON.stringify(line)}`);
	}
});

test("thinking document accepts markdown headings but not inline bold", () => {
	const withHeading = parseThinkingDocument("## Design\n\nbody text");
	assert.equal(withHeading.sections[0]!.title, "Design");
	assert.equal(thinkingSectionBody(withHeading, withHeading.sections[0]!), "body text");

	const inlineBold = parseThinkingDocument("Use **bold** inline, not a title.");
	assert.equal(inlineBold.sections[0]!.title, undefined);
	assert.match(thinkingSectionBody(inlineBold, inlineBold.sections[0]!), /\*\*bold\*\*/);
});

test("latest thinking lines stay extractive and skip markdown noise", () => {
	const doc = parseThinkingDocument(
		[
			"**Repair**",
			"",
			"- 第一条",
			"- 第二条",
			"",
			"最后一句 **很重要**，保留 `cache key`。",
			"",
			"```",
			"ignored code",
			"```",
		].join("\n"),
	);
	assert.deepEqual(latestThinkingLines(doc, 1), ["最后一句 很重要，保留 cache key。"]);
	assert.deepEqual(latestThinkingLines(doc, 3).at(-1), "最后一句 很重要，保留 cache key。");
});

test("latest lines match across long bodies, blank tails, and multiple limits", () => {
	const longBody = Array.from({ length: 400 }, (_, index) => `line ${index} 内容`).join("\n");
	const doc = parseThinkingDocument(`**Long**\n\n${longBody}\n\n   \n`);
	assert.deepEqual(latestThinkingLines(doc, 1), ["line 399 内容"]);
	assert.deepEqual(latestThinkingLines(doc, 2), ["line 398 内容", "line 399 内容"]);
	assert.deepEqual(latestThinkingLines(doc, 3).at(-1), "line 399 内容");

	const fenced = parseThinkingDocument(
		["**Fence**", "", "first line", "", "```ts", "hidden code", "```", "", "visible tail"].join(
			"\n",
		),
	);
	assert.deepEqual(latestThinkingLines(fenced, 1), ["visible tail"]);
	assert.deepEqual(latestThinkingLines(fenced, 2), ["first line", "visible tail"]);
});

test("thinking document handles CRLF and empty input", () => {
	const crlf = parseThinkingDocument("**Plan**\r\n\r\nFirst\r\n");
	assert.equal(crlf.sections[0]!.title, "Plan");
	assert.equal(thinkingSectionBody(crlf, crlf.sections[0]!), "First");

	const empty = parseThinkingDocument("   ");
	assert.equal(empty.sections.length, 1);
	assert.equal(thinkingDocumentSectionCount(empty), 0);
	assert.deepEqual(latestThinkingLines(empty), []);
});

test("incremental document builder matches a full parse while appending", () => {
	const full = [
		"**排查缓存键**",
		"",
		"失败的测试指向 memo 过的布局。",
		"",
		"**验证修复**",
		"",
		"把宽度放进缓存键。",
	].join("\n");
	const builder = new ThinkingDocumentBuilder();
	let doc = builder.update("");
	for (let end = 1; end <= full.length; end += 7) {
		doc = builder.update(full.slice(0, end));
	}
	doc = builder.update(full);

	const expected = parseThinkingDocument(full);
	assert.deepEqual(
		doc.sections.map((section) => ({
			title: section.title,
			body: thinkingSectionBody(doc, section),
		})),
		expected.sections.map((section) => ({
			title: section.title,
			body: thinkingSectionBody(expected, section),
		})),
	);
	assert.equal(thinkingDocumentSectionCount(doc), 2);
	assert.deepEqual(latestThinkingLines(doc, 1), ["把宽度放进缓存键。"]);
});

test("incremental document builder keeps earlier documents immutable", () => {
	const builder = new ThinkingDocumentBuilder();
	const first = builder.update("**One**\n\nfirst\n\n**Two**\n\nsecond");
	const snapshot = first.sections.map((section) => ({ ...section }));
	const firstSection = first.sections[0];

	builder.update("**One**\n\nfirst\n\n**Two**\n\nsecond and more");

	assert.deepEqual(first.sections, snapshot, "old document sections are not mutated");
	assert.equal(thinkingSectionBody(first, first.sections[1]!), "second");
	assert.strictEqual(first.sections[0], firstSection);
});

test("section hasBody is computed once and drives the step count", () => {
	const doc = parseThinkingDocument(
		["intro", "", "**Empty**", "", "**Body**", "", "text"].join("\n"),
	);
	assert.deepEqual(
		doc.sections.map((section) => ({ title: section.title, hasBody: section.hasBody })),
		[
			{ title: undefined, hasBody: true },
			{ title: "Empty", hasBody: false },
			{ title: "Body", hasBody: true },
		],
	);
	assert.equal(thinkingDocumentSectionCount(doc), 3);
});

test("incremental document builder falls back when the stream rewinds", () => {
	const builder = new ThinkingDocumentBuilder();
	builder.update("**Plan**\n\nFirst body");
	const rewritten = builder.update("**Plan**\n\nSecond body");
	assert.equal(thinkingSectionBody(rewritten, rewritten.sections[0]!), "Second body");
	assert.deepEqual(latestThinkingLines(rewritten, 1), ["Second body"]);
});

test("incremental builder does not duplicate the growing last section", () => {
	const builder = new ThinkingDocumentBuilder();
	builder.update("**One**\n\nfirst");
	builder.update("**One**\n\nfirst\n\n**Two**\n\nsecond");
	builder.update("**One**\n\nfirst\n\n**Two**\n\nsecond and more");
	const doc = builder.update("**One**\n\nfirst\n\n**Two**\n\nsecond and more!");
	assert.deepEqual(
		doc.sections.map((section) => section.title),
		["One", "Two"],
	);
	assert.equal(thinkingSectionBody(doc, doc.sections[1]!), "second and more!");
});

test("incremental builder reuses finalized section objects", () => {
	const builder = new ThinkingDocumentBuilder();
	const first = builder.update("**One**\n\nfirst\n\n**Two**\n\nsecond");
	const firstSection = first.sections[0];
	const next = builder.update("**One**\n\nfirst\n\n**Two**\n\nsecond and more");
	assert.strictEqual(next.sections[0], firstSection, "earlier sections are not copied");
	assert.equal(thinkingSectionBody(next, next.sections[1]!), "second and more");
});

test("plain thinking wrap keeps CJK punctuation off the start of a line", () => {
	const text = "失败的测试指向 memo 过的布局。缓存键里没有宽度，窗口一缩放就会复用旧行。";
	const lines = wrapPlainThinkingText(text, 20);
	assert.ok(lines.length > 1);
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 20, `line over budget: ${JSON.stringify(line)}`);
		assert.doesNotMatch(line, /^[。，、；：！？）》】」』”’]/u, `orphan punctuation: ${line}`);
		assert.doesNotMatch(line, /[（【「『“‘]$/u, `trailing opening bracket: ${line}`);
	}
	assert.equal(lines.join("").replace(/\s+/gu, ""), text.replace(/\s+/gu, ""));
});

test("plain thinking wrap prefers spaces for English words", () => {
	const text = "The quick brown fox jumps over the lazy dog.";
	const lines = wrapPlainThinkingText(text, 18);
	assert.ok(lines.length > 1);
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 18);
		assert.doesNotMatch(line, /^\s/u);
	}
	assert.equal(lines.join(" "), text);
});

test("markdown structure detection leaves code and lists to the Markdown renderer", () => {
	assert.equal(hasThinkingMarkdownStructure("普通中文段落。"), false);
	assert.equal(hasThinkingMarkdownStructure("带 `inline code` 的段落"), true);
	assert.equal(hasThinkingMarkdownStructure("- list item"), true);
	assert.equal(hasThinkingMarkdownStructure("```ts\nconst a = 1;\n```"), true);
});
