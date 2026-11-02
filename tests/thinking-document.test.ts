import assert from "node:assert/strict";
import test from "node:test";

import {
	latestThinkingLines,
	parseThinkingDocument,
	thinkingDocumentCurrentTitle,
	thinkingDocumentSectionCount,
	thinkingDocumentTitle,
	thinkingSectionBody,
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

test("thinking document handles CRLF and empty input", () => {
	const crlf = parseThinkingDocument("**Plan**\r\n\r\nFirst\r\n");
	assert.equal(crlf.sections[0]!.title, "Plan");
	assert.equal(thinkingSectionBody(crlf, crlf.sections[0]!), "First");

	const empty = parseThinkingDocument("   ");
	assert.equal(empty.sections.length, 1);
	assert.equal(thinkingDocumentSectionCount(empty), 0);
	assert.deepEqual(latestThinkingLines(empty), []);
});
