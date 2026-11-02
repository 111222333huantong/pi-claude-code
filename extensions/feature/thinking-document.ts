/**
 * Thinking 文档模型。
 *
 * thinking 原文是唯一真源；这里只建立轻量的 section 索引，供折叠摘要与
 * 展开文档复用。section 的 body 用原文偏移表示，不复制 reasoning 正文。
 *
 * 解析规则保持保守：
 * - `**Title**` / `# Title` 必须独占一行，且在代码围栏外；
 * - 没有标题时按空行分段，每段一个 section；
 * - 围栏内的空行/标题不切段，代码原样保留。
 */

export type ThinkingSection = {
	title?: string;
	/** section 在 raw 中的起始偏移（标题行或正文段落起点）。 */
	start: number;
	/** 正文起点；标题 section 指向标题下一行，纯段落指向段落起点。 */
	bodyStart: number;
	bodyEnd: number;
};

export type ThinkingDocument = {
	raw: string;
	sections: ThinkingSection[];
};

const MAX_TITLE_WIDTH = 80;

function isFenceLine(line: string): boolean {
	return /^\s*(?:```|~~~)/.test(line);
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
		if (current.title === undefined && !hasBody(current.bodyStart, bodyEnd)) {
			current = undefined;
			return;
		}
		sections.push({
			title: current.title,
			start: current.start,
			bodyStart: current.bodyStart,
			bodyEnd,
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
			if (title) {
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
		sections.push({ start: 0, bodyStart: 0, bodyEnd: raw.length });
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
		if (thinkingSectionBody(doc, section)) return section;
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
 */
export function latestThinkingLines(doc: ThinkingDocument, limit = 1): string[] {
	const section = thinkingDocumentLastBodySection(doc);
	if (!section || limit <= 0) return [];
	const lines: string[] = [];
	let inFence = false;
	for (const rawLine of thinkingSectionBody(doc, section).split("\n")) {
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
	return doc.sections.filter(
		(section) => section.title !== undefined || thinkingSectionBody(doc, section).length > 0,
	).length;
}
