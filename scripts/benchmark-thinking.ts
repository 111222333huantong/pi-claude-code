import { performance } from "node:perf_hooks";
import {
	clearThinkingPreviewCache,
	ThinkingPreviewBlock,
} from "../extensions/feature/compact-thinking.ts";
import {
	parseThinkingDocument,
	ThinkingDocumentBuilder,
} from "../extensions/feature/thinking-document.ts";
import {
	extractProviderThinkingTitles,
	splitThinkingChunkBuffer,
	summarizeThinkingChunk,
} from "../extensions/feature/thinking-summary.ts";
import { ThinkingSummaryStream } from "../extensions/feature/thinking-summary-stream.ts";

function makeThinking(sections: number) {
	return Array.from(
		{ length: sections },
		(_, index) =>
			`**Inspecting renderer ${index}**\n\n` +
			`I need to inspect src/module-${index}.ts and verify the renderer path before editing. ` +
			`The spinner should keep moving without stalls.`,
	).join("\n\n");
}

/** 带列表和围栏代码的“重结构”thinking：每段约 10 行渲染输出。 */
function makeRichThinking(sections: number) {
	return Array.from(
		{ length: sections },
		(_, index) =>
			`**Inspecting renderer ${index}**\n\n` +
			`I need to inspect src/module-${index}.ts and verify the renderer path before editing. ` +
			`The spinner should keep moving without stalls.\n\n` +
			"- check the cache key\n- re-run the golden suite\n\n" +
			"```ts\n" +
			`const key = \`\${width}:\${limit}:${index}\`;\n` +
			"```",
	).join("\n\n");
}

function time(label: string, fn: () => void) {
	const start = performance.now();
	fn();
	const ms = performance.now() - start;
	console.log(`${label.padEnd(34)} ${ms.toFixed(2)} ms`);
	return ms;
}

function streamPass(text: string, step: number) {
	const stream = new ThinkingSummaryStream({ liveSummary: true, useProviderTitles: true });
	let lastDeltaAt = 0;
	for (let end = step; end < text.length; end += step) {
		lastDeltaAt = end;
		stream.update(text.slice(0, end), {
			active: true,
			now: end,
			lastDeltaAt,
			providerTitleInHeading: true,
		});
	}
	return stream.close(text.length);
}

function documentPass(text: string, step: number) {
	const builder = new ThinkingDocumentBuilder();
	for (let end = step; end < text.length; end += step) {
		builder.update(text.slice(0, end));
	}
	return builder.update(text);
}

// 只做样式标记的空主题：让渲染路径跑真实 Markdown/折行，但不产生 ANSI 噪声。
const plainTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
};
const markdownTheme = {
	...plainTheme,
	code: (text: string) => text,
	codeBlock: (text: string) => text,
	codeBlockBorder: (text: string) => text,
	codeBlockIndent: "  ",
	heading: (text: string) => text,
	hr: (text: string) => text,
	link: (text: string) => text,
	linkUrl: (text: string) => text,
	listBullet: (text: string) => text,
	quote: (text: string) => text,
	quoteBorder: (text: string) => text,
	strikethrough: (text: string) => text,
};

function firstExpandPass(text: string) {
	const document = new ThinkingDocumentBuilder().update(text);
	clearThinkingPreviewCache();
	const block = new ThinkingPreviewBlock(
		"✻ Thought for 12s",
		document.raw,
		0,
		1,
		(text) => text,
		plainTheme as never,
		0,
		false,
		markdownTheme as never,
		undefined,
		undefined,
		false,
		undefined,
		document,
	);
	block.setExpanded(true);
	block.render(100);
	block.setExpanded(false);
}

function renderPass(text: string, frames: number, expanded: boolean) {
	const builder = new ThinkingDocumentBuilder();
	const step = Math.max(1, Math.floor(text.length / frames));
	const documents = [builder.update("")];
	for (let end = step; end < text.length; end += step) {
		documents.push(builder.update(text.slice(0, end)));
	}
	documents.push(builder.update(text));

	clearThinkingPreviewCache();
	for (const document of documents) {
		const block = new ThinkingPreviewBlock(
			"✻ Thought for 12s",
			document.raw,
			0,
			1,
			(text) => text,
			plainTheme as never,
			0,
			false,
			markdownTheme as never,
			undefined,
			undefined,
			false,
			undefined,
			document,
		);
		if (expanded) block.setExpanded(true);
		else block.setExpanded(false);
		block.render(100);
	}
}

for (const sections of [200, 800, 2000]) {
	const text = makeThinking(sections);
	console.log(`\nthinking: ${sections} sections, ${(text.length / 1024).toFixed(0)} KiB`);
	time("provider titles (full scan)", () => extractProviderThinkingTitles(text));
	time("chunk split + summarize (all)", () => {
		const { closed } = splitThinkingChunkBuffer(text, true);
		for (const chunk of closed) summarizeThinkingChunk(chunk);
	});
	time("streaming pass (64 char steps)", () => streamPass(text, 64));
	time("document full parse", () => parseThinkingDocument(text));
	time("document builder (64 char steps)", () => documentPass(text, 64));
	time("document first expand", () => firstExpandPass(text));
	time("document collapsed render (120f)", () => renderPass(text, 120, false));
	time("document expanded render (120f)", () => renderPass(text, 120, true));
	time("document full parse per step", () => {
		for (let end = 64; end < text.length; end += 64) parseThinkingDocument(text.slice(0, end));
	});
}

// 重结构段落（列表 + 围栏代码）主要衡量“首次展开”成本：没有缓存可用时，
// 整篇文档的标题、正文、代码块都要走一次 Markdown 渲染。
for (const sections of [500, 2000, 5000]) {
	const text = makeRichThinking(sections);
	console.log(
		`\nthinking (rich): ${sections} sections, ${(text.length / 1024).toFixed(0)} KiB, ${text.split("\n").length} lines`,
	);
	time("document first expand", () => firstExpandPass(text));
}
