/**
 * Thinking 文档模型。
 *
 * thinking 原文是唯一真源；这里只建立轻量的 section 索引，供折叠摘要与
 * 展开文档复用。section 的 body 用原文偏移表示，不复制 reasoning 正文。
 *
 * 解析规则保持保守：
 * - `**Title**` / `# Title` 必须独占一行，且在代码围栏外；
 * - `**Title**` 还必须处于块边界：前面是空行/围栏结束，后面是空行或文档结束
 *   （`**Lead**\nbody` 在 CommonMark 里只是一个段落，不切 section）；
 * - 没有标题时按空行分段，每段一个 section；
 * - 围栏内的空行/标题不切段，代码原样保留。
 */
import { visibleWidth } from "@earendil-works/pi-tui";

export type ThinkingSection = {
	title?: string;
	/** section 在 raw 中的起始偏移（标题行或正文段落起点）。 */
	start: number;
	/** 正文起点；标题 section 指向标题下一行，纯段落指向段落起点。 */
	bodyStart: number;
	bodyEnd: number;
	/** 解析时算好的「是否有非空正文」，避免每次渲染重新 slice + trim 全文。 */
	hasBody: boolean;
};

export type ThinkingDocument = {
	raw: string;
	sections: ThinkingSection[];
};

const MAX_TITLE_WIDTH = 80;

function isFenceLine(line: string): boolean {
	return /^\s*(?:```|~~~)/.test(line);
}

const graphemeSegmenter =
	typeof Intl.Segmenter === "function"
		? new Intl.Segmenter(undefined, { granularity: "grapheme" })
		: undefined;

/** 按字素簇切分：emoji ZWJ、组合音标不会被拆成半个字符。 */
function splitGraphemes(text: string): string[] {
	if (!graphemeSegmenter) return Array.from(text);
	return Array.from(graphemeSegmenter.segment(text), (part) => part.segment);
}

function parseTitleLine(line: string): string | undefined {
	const trimmed = line.trim();
	if (!trimmed) return undefined;

	const bold = /^\*\*([^\n*][^\n]*?)\*\*\s*$/.exec(trimmed);
	if (bold) {
		const title = bold[1]!.trim();
		return title && visibleTitleWidth(title) <= MAX_TITLE_WIDTH ? title : undefined;
	}

	const heading = /^#{1,6}\s+(.+?)\s*$/.exec(trimmed);
	if (heading) {
		const title = heading[1]!.replace(/\s+#+\s*$/, "").trim();
		return title && visibleTitleWidth(title) <= MAX_TITLE_WIDTH ? title : undefined;
	}

	return undefined;
}

function visibleTitleWidth(text: string): number {
	// 避免为了一个标题把 pi-tui 的 visibleWidth 拉进纯解析模块；CJK 粗略按 2 列。
	let width = 0;
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		width += code > 0xff ? 2 : 1;
	}
	return width;
}

type LineSpan = { text: string; start: number; end: number };

function splitLineSpans(raw: string): LineSpan[] {
	const spans: LineSpan[] = [];
	let start = 0;
	for (let index = 0; index <= raw.length; index++) {
		if (index !== raw.length && raw[index] !== "\n") continue;
		spans.push({ text: raw.slice(start, index), start, end: index });
		start = index + 1;
	}
	return spans;
}

/**
 * 粗体行是否真的是 section 标题（保守规则）。
 *
 * CommonMark 里 `**Lead**\nbody` 是一个段落，上一行不是块边界的粗体行也一样
 * 只是强调。只有「前面空行/围栏结束 + 后面空行/文档结束」的独占粗体行才当标题，
 * 避免把段落中间的强调行误判成新 section。
 *
 * ATX 标题（`# ...`）本身是块级语法，不要求空行，保持宽松。
 */
function isTitleBoundary(lines: LineSpan[], index: number): boolean {
	const text = lines[index]!.text.trim();
	if (/^#{1,6}\s/.test(text)) return true;

	const previous = index > 0 ? lines[index - 1] : undefined;
	const previousIsBlockStart =
		previous === undefined || previous.text.trim() === "" || isFenceLine(previous.text);
	if (!previousIsBlockStart) return false;

	const next = lines[index + 1];
	return next === undefined || next.text.trim() === "";
}

export function parseThinkingDocument(input: string): ThinkingDocument {
	const raw = input.replace(/\r\n?/g, "\n");
	const lines = splitLineSpans(raw);
	const sections: ThinkingSection[] = [];

	let current:
		| {
				title?: string;
				start: number;
				bodyStart: number;
		  }
		| undefined;
	let inFence = false;

	const hasBody = (start: number, end: number): boolean => raw.slice(start, end).trim().length > 0;

	const push = (bodyEnd: number) => {
		if (!current) return;
		const body = hasBody(current.bodyStart, bodyEnd);
		if (current.title === undefined && !body) {
			current = undefined;
			return;
		}
		sections.push({
			title: current.title,
			start: current.start,
			bodyStart: current.bodyStart,
			bodyEnd,
			hasBody: body,
		});
		current = undefined;
	};

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		const trimmed = line.text.trim();

		if (isFenceLine(line.text)) {
			if (!current) {
				current = { start: line.start, bodyStart: line.start };
			}
			inFence = !inFence;
			continue;
		}

		if (!inFence) {
			const title = parseTitleLine(line.text);
			if (title && isTitleBoundary(lines, index)) {
				push(line.start);
				const nextLine = lines[index + 1];
				current = {
					title,
					start: line.start,
					bodyStart: nextLine ? nextLine.start : raw.length,
				};
				continue;
			}

			// 纯文本：空行就是段落边界。标题 section 内的空行只作为正文空白保留。
			if (!trimmed && current && current.title === undefined) {
				push(line.start);
				const nextLine = lines[index + 1];
				if (nextLine) current = { start: nextLine.start, bodyStart: nextLine.start };
				continue;
			}
		}

		if (!current) {
			current = { start: line.start, bodyStart: line.start };
		}
	}

	push(raw.length);

	if (sections.length === 0) {
		sections.push({ start: 0, bodyStart: 0, bodyEnd: raw.length, hasBody: false });
	}

	return { raw, sections };
}

export function thinkingSectionBody(doc: ThinkingDocument, section: ThinkingSection): string {
	return doc.raw.slice(section.bodyStart, section.bodyEnd).trim();
}

/** 最后一个带标题的 section；没有 provider 标题时返回 undefined。 */
export function thinkingDocumentTitle(doc: ThinkingDocument): string | undefined {
	for (let index = doc.sections.length - 1; index >= 0; index--) {
		const title = doc.sections[index]!.title;
		if (title) return title;
	}
	return undefined;
}

/** 当前 section 标题：只在最后一段自身有标题时使用，避免拿旧标题冒充当前活动。 */
export function thinkingDocumentCurrentTitle(doc: ThinkingDocument): string | undefined {
	return doc.sections.at(-1)?.title;
}

/** 最后一个有正文的 section。 */
export function thinkingDocumentLastBodySection(
	doc: ThinkingDocument,
): ThinkingSection | undefined {
	for (let index = doc.sections.length - 1; index >= 0; index--) {
		const section = doc.sections[index]!;
		if (section.hasBody) return section;
	}
	return undefined;
}

const COLLAPSE_MARKDOWN_PREFIX_RE =
	/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+|```[^\n]*$|~~~[^\n]*$)/u;

function cleanCollapsedLine(line: string): string | undefined {
	const trimmed = line.trim();
	if (!trimmed || isFenceLine(trimmed)) return undefined;
	const stripped = trimmed
		.replace(COLLAPSE_MARKDOWN_PREFIX_RE, "")
		.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
	return stripped || undefined;
}

/**
 * 折叠态最新正文行：从最后一个有正文的 section 里取尾部非空行。
 * 只做去标记/压空白，不做生成式摘要，保证内容仍来自原文。
 *
 * 默认只取 1 行，因此无代码围栏时从尾部反向扫描，避免把整段长 reasoning
 * split 成行再丢弃；含围栏时才回退到顺序扫描以正确处理围栏状态。
 */
export function latestThinkingLines(doc: ThinkingDocument, limit = 1): string[] {
	const section = thinkingDocumentLastBodySection(doc);
	if (!section || limit <= 0) return [];
	const body = thinkingSectionBody(doc, section);

	if (!body.includes("```") && !body.includes("~~~")) {
		const lines: string[] = [];
		let end = body.length;
		while (end > 0 && lines.length < limit) {
			const newline = body.lastIndexOf("\n", end - 1);
			const start = newline + 1;
			const line = cleanCollapsedLine(body.slice(start, end));
			if (line) lines.push(line);
			if (newline < 0) break;
			end = newline;
		}
		lines.reverse();
		return lines;
	}

	const lines: string[] = [];
	let inFence = false;
	for (const rawLine of body.split("\n")) {
		if (isFenceLine(rawLine)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		const line = cleanCollapsedLine(rawLine);
		if (line) lines.push(line);
	}
	if (lines.length === 0) return [];
	return lines.slice(-Math.max(1, limit));
}

export function thinkingDocumentSectionCount(doc: ThinkingDocument): number {
	let count = 0;
	for (const section of doc.sections) {
		if (section.title !== undefined || section.hasBody) count++;
	}
	return count;
}

function isAppendOnly(previous: string, next: string): boolean {
	if (previous.length === 0) return true;
	if (next.length < previous.length) return false;
	if (next.length === previous.length) return next === previous;
	const sampleLength = Math.min(64, previous.length);
	return (
		next.slice(0, sampleLength) === previous.slice(0, sampleLength) &&
		next.slice(previous.length - sampleLength, previous.length) ===
			previous.slice(previous.length - sampleLength)
	);
}

/**
 * 流式 thinking 的增量文档构建器。
 *
 * 只有最后一个 section 会继续增长，因此追加时只重解析最后一段，前面的
 * section 直接复用。文本被替换/回退时回退到全量解析，保证正确性。
 */
export class ThinkingDocumentBuilder {
	private text = "";
	private document: ThinkingDocument = { raw: "", sections: [] };

	update(input: string): ThinkingDocument {
		const raw = input.replace(/\r\n?/g, "\n");
		if (raw === this.text) return this.document;

		if (!isAppendOnly(this.text, raw) || this.document.sections.length === 0) {
			this.text = raw;
			this.document = parseThinkingDocument(raw);
			return this.document;
		}

		this.text = raw;
		const previous = this.document;
		const last = previous.sections[previous.sections.length - 1]!;
		const tailStart = last.start;
		const tail = parseThinkingDocument(raw.slice(tailStart));
		const adjusted = tail.sections.map((section) => ({
			...section,
			start: section.start + tailStart,
			bodyStart: section.bodyStart + tailStart,
			bodyEnd: section.bodyEnd + tailStart,
		}));
		if (adjusted.length === 1) {
			// 常见路径：最后一段继续增长。只替换最后一项，前面 section 对象保持不变。
			this.document = {
				raw,
				sections: [...previous.sections.slice(0, -1), adjusted[0]!],
			};
			return this.document;
		}
		this.document = {
			raw,
			sections: [...previous.sections.slice(0, -1), ...adjusted],
		};
		return this.document;
	}

	reset(): void {
		this.text = "";
		this.document = { raw: "", sections: [] };
	}
}

/** CJK 标点避头尾：行首不出现收尾标点，行尾不留下开启标点。 */
const CJK_CLOSING_PUNCTUATION = new Set(Array.from("。，、；：！？）》】」』”’"));
const CJK_OPENING_PUNCTUATION = new Set(Array.from("（【「『“‘"));
const CJK_RE = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/u;

function isAsciiWordChar(char: string): boolean {
	return /[A-Za-z0-9_]$/.test(char);
}

function wrapPlainThinkingLine(line: string, width: number): string[] {
	if (!line) return [""];
	const chars = splitGraphemes(line);
	const out: string[] = [];
	let current: string[] = [];
	let currentWidth = 0;

	const flush = () => {
		const text = current.join("").replace(/\s+$/u, "");
		out.push(text);
		current = [];
		currentWidth = 0;
	};

	for (let index = 0; index < chars.length; index++) {
		const char = chars[index]!;
		if (current.length === 0 && /\s/u.test(char)) continue;
		const charWidth = Math.max(1, visibleWidth(char));
		if (currentWidth + charWidth <= width) {
			current.push(char);
			currentWidth += charWidth;
			continue;
		}

		// 收尾标点不能落在下一行行首：把上一行最后一个字符一起带到下一行。
		if (CJK_CLOSING_PUNCTUATION.has(char) && current.length > 1) {
			let carried = current.pop()!;
			// 中文双字词：标点溢出时多带一个字，避免「容 / 器。」这种断词。
			const previous = current[current.length - 1];
			if (CJK_RE.test(carried) && previous && CJK_RE.test(previous) && current.length > 1) {
				carried = current.pop()! + carried;
			}
			currentWidth -= Math.max(1, visibleWidth(carried));
			flush();
			current = [carried, char];
			currentWidth = Math.max(1, visibleWidth(carried)) + charWidth;
			continue;
		}

		// 下一字符就是收尾标点时，避免把「容器」拆成「容 / 器。」。
		const nextChar = chars[index + 1];
		if (
			CJK_RE.test(char) &&
			nextChar !== undefined &&
			CJK_CLOSING_PUNCTUATION.has(nextChar) &&
			current.length > 1
		) {
			const carried = current.pop()!;
			currentWidth -= Math.max(1, visibleWidth(carried));
			flush();
			current = [carried, char];
			currentWidth = Math.max(1, visibleWidth(carried)) + charWidth;
			continue;
		}

		// 开启标点不能留在上一行行尾：带到下一行和正文一起。
		let carriedOpening = "";
		const last = current[current.length - 1];
		if (last && CJK_OPENING_PUNCTUATION.has(last)) {
			carriedOpening = current.pop()!;
			currentWidth -= Math.max(1, visibleWidth(carriedOpening));
		}

		// 英文单词优先在空格处断开，避免从词中间折行。
		if (!carriedOpening && isAsciiWordChar(char)) {
			const joined = current.join("");
			const space = joined.lastIndexOf(" ");
			if (space > 0) {
				const head = joined.slice(0, space).replace(/\s+$/u, "");
				const tail = joined.slice(space + 1);
				if (head && tail) {
					out.push(head);
					current = [...Array.from(tail), char];
					currentWidth = visibleWidth(tail) + charWidth;
					continue;
				}
			}
		}

		if (!carriedOpening && /\s/u.test(char)) {
			flush();
			continue;
		}

		flush();
		current = carriedOpening ? [carriedOpening, char] : [char];
		currentWidth = (carriedOpening ? visibleWidth(carriedOpening) : 0) + charWidth;
	}

	if (current.length > 0) flush();
	return out.length > 0 ? out : [""];
}

/**
 * 纯文本 thinking 折行（无 Markdown 结构时使用）。
 * 按显示宽度切分，并做 CJK 标点避头尾；ANSI 文本请走 pi-tui 的 wrapTextWithAnsi。
 */
export function wrapPlainThinkingText(text: string, width: number): string[] {
	const contentWidth = Math.max(1, width);
	const lines: string[] = [];
	for (const line of text.split("\n")) {
		lines.push(...wrapPlainThinkingLine(line.replace(/\t/g, "   "), contentWidth));
	}
	return lines;
}

/** 是否包含 Markdown 结构；纯 prose 才走 CJK 感知折行。 */
export function hasThinkingMarkdownStructure(text: string): boolean {
	return (
		/(^|\n)\s*(?:```|~~~|#{1,6}\s|[-*+]\s|\d+[.)]\s|>)/u.test(text) ||
		/`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\[[^\]]+\]\([^)]+\)/u.test(text)
	);
}

/**
 * 是否含引用式链接定义（`[label]: url`，围栏外）。
 *
 * 每个 section 独立渲染，定义写在别的 section 里时引用会失效；检测到这种
 * 全局状态时，展开文档回退为整篇一次渲染，正确性优先。
 */
export function hasThinkingLinkReferenceDefinition(text: string): boolean {
	// 绝大多数 thinking 没有引用式链接；先用一次子串检查挡掉整篇逐行扫描。
	if (!text.includes("]:")) return false;
	let inFence = false;
	for (const line of text.split("\n")) {
		if (isFenceLine(line)) {
			inFence = !inFence;
			continue;
		}
		if (!inFence && /^ {0,3}\[[^\]\n]+\]:/u.test(line)) return true;
	}
	return false;
}

export function hasCjkText(text: string): boolean {
	return CJK_RE.test(text);
}
