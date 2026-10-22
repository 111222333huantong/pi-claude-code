import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { render as renderMermaid, sourceBox } from "grok-mermaid";
import { installCodeBlockBox } from "./tool/code-block.ts";

// ============================================================================
// Mermaid 方言渲染
// ============================================================================

// 内置 mermaid transformer 只认 ```mermaid，这里补上 grok-mermaid 支持的其他方言
const DIAGRAM_FENCE =
	/^(`{3,})\s*(mermaid|statediagram|statediagram-v2|classdiagram|classdiagram-v2|erdiagram|sequencediagram)\s*$/i;
const FENCE_OPEN = /^(`{3,})/;
const FENCE_CLOSE = /^`{3,}\s*$/;

/** 把一行图内容包成行内代码（保持空格与框线字符对齐）。 */
function codeSpan(line: string): string {
	const content = line || "\u00a0";
	const longestRun = Math.max(0, ...Array.from(content.matchAll(/`+/g), (m) => m[0].length));
	const fence = "`".repeat(longestRun + 1);
	const padding = content.startsWith("`") || content.endsWith("`") ? " " : "";
	return `${fence}${padding}${content}${padding}${fence}`;
}

/** 渲染失败或图宽超出终端宽度时，把源码包进带标题的框里显示。 */
function framedSource(src: string, width: number): string {
	const box = sourceBox(src, Math.max(8, width - 2));
	return `\`\`\`\n${box.plain.join("\n")}\n\`\`\``;
}

/** 解析 ```diagram 代码块，返回 { 源码, 块内行数 }；未闭合返回 null。 */
function collectFence(lines: string[], i: number): { diagram: string; next: number } | null {
	const open = lines[i].match(FENCE_OPEN)?.[0] ?? "```";
	const src: string[] = [];
	let j = i + 1;
	while (j < lines.length) {
		if (lines[j].match(FENCE_CLOSE) && lines[j].startsWith(open)) {
			return { diagram: src.join("\n"), next: j + 1 };
		}
		src.push(lines[j]);
		j++;
	}
	return null; // 未闭合：放弃转换，保持原文
}

// ============================================================================
// 圈数字 → 半角括号
// ============================================================================

// Nerd Font 补丁字形（U+2460-U+2473）ink 超界，DirectWrite 下渲染会压住相邻字符；
// 转成 ASCII "(n)" 后任何字体下宽度一致。U+2460-U+2473 连续，差值即序号。
const CIRCLED_RE = /[①-⑳]/g;

const BLOCKQUOTE_PREFIX = /^ {0,3}>[ \t]?/;
const CODE_FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const CODE_FENCE_CLOSE = /^ {0,3}(`+|~+)[ \t]*$/;

type MarkdownFence = { marker: string; blockquoteDepth: number };

function parseFenceLine(line: string): { blockquoteDepth: number; content: string } {
	let content = line;
	let blockquoteDepth = 0;
	while (BLOCKQUOTE_PREFIX.test(content)) {
		content = content.replace(BLOCKQUOTE_PREFIX, "");
		blockquoteDepth++;
	}
	return { blockquoteDepth, content };
}

function scanMarkdownFence(
	line: string,
	fence: MarkdownFence | undefined,
): { protected: boolean; fence: MarkdownFence | undefined } {
	const parsed = parseFenceLine(line);
	if (fence && parsed.blockquoteDepth >= fence.blockquoteDepth) {
		const close = parsed.content.match(CODE_FENCE_CLOSE)?.[1];
		const closed =
			parsed.blockquoteDepth === fence.blockquoteDepth &&
			close?.[0] === fence.marker[0] &&
			close.length >= fence.marker.length;
		return { protected: true, fence: closed ? undefined : fence };
	}
	const marker = parsed.content.match(CODE_FENCE_OPEN)?.[1];
	return {
		protected: Boolean(marker),
		fence: marker ? { marker, blockquoteDepth: parsed.blockquoteDepth } : undefined,
	};
}

function deCircled(markdown: string): string {
	let fence: MarkdownFence | undefined;
	return markdown
		.split("\n")
		.map((line) => {
			const scanned = scanMarkdownFence(line, fence);
			fence = scanned.fence;
			if (scanned.protected) return line;
			return line.replace(CIRCLED_RE, (ch) => `(${ch.codePointAt(0)! - 0x2460 + 1})`);
		})
		.join("\n");
}

// 键帽数字（1 + U+FE0F + U+20E3）与 dingbat 数字（U+2776 起）在无 emoji
// 字体的终端下显示为方框；转成 ASCII "(n)"，与 deCircled 同约定。
// 模型爱用键帽做序号，终端缺 U+20E3 字形即变方框。
// 注意：此处不用 /…/ 字面量写不可见字符（传输层易吞），一律 fromCharCode 组装。
const VS16 = String.fromCharCode(0xfe0f);
const KEYCAP_MARK = String.fromCharCode(0x20e3);
const KEYCAP_RE = new RegExp(`([0-9#*])${VS16}?${KEYCAP_MARK}`, "g");
const DINGBAT_RANGES: Array<[number, number]> = [
	[0x2776, 10], // ❶-❿
	[0x2780, 10], // ➀-➉
	[0x278a, 10], // ➊-➓
];

function deKeycap(markdown: string): string {
	let out = markdown.replace(KEYCAP_RE, "($1)");
	out = out.replace(new RegExp(String.fromCodePoint(0x1f51f), "gu"), "(10)");
	for (const [base, count] of DINGBAT_RANGES) {
		const pattern = new RegExp(
			`[\\u{${base.toString(16)}}-\\u{${(base + count - 1).toString(16)}}]`,
			"gu",
		);
		out = out.replace(pattern, (ch) => `(${ch.codePointAt(0)! - base + 1})`);
	}
	return out;
}

// ============================================================================
// 用户消息数学公式（native-first：定界符形式全部透传 Pi 原生 LaTeX）
// ----------------------------------------------------------------------------
// Pi 原生（Markdown renderLatex，默认开启）对 `$…$` / `\(…\)` / `$$…$$` /
// `\[…\]` 渲染更好（竖排分数、Σ 上下标排版），且 `$5` / 蛇形命名等 guard 齐全，
// 因此定界符形式不再预转换（c7074c5 的压平逻辑已删除）。
// 仅保留两样无原生兜底的东西：
//  1. \begin{equation|align|aligned} 环境 → $$ 块改写（原生 block tokenizer
//     只认 $$ 与 \[，独立环境块会原文泄漏）；
//  2. 无定界符紧凑单段（如整行只有一个 \frac）的旧 Unicode 转换（回归保护）。
// 生效范围：围栏代码块与行内代码一律跳过；`$$` / `\[…\]` 区域内的嵌套环境不动；
// 未闭合环境不动；$5 价格、C:\opencode 路径等非数学形状一律放过。
// ============================================================================

const MATH_COMMANDS: Record<string, string> = {
	alpha: "α",
	beta: "β",
	gamma: "γ",
	Gamma: "Γ",
	delta: "δ",
	Delta: "Δ",
	epsilon: "ε",
	varepsilon: "ε",
	zeta: "ζ",
	eta: "η",
	theta: "θ",
	Theta: "Θ",
	vartheta: "ϑ",
	iota: "ι",
	kappa: "κ",
	lambda: "λ",
	Lambda: "Λ",
	mu: "μ",
	nu: "ν",
	xi: "ξ",
	Xi: "Ξ",
	pi: "π",
	Pi: "Π",
	rho: "ρ",
	varrho: "ϱ",
	sigma: "σ",
	Sigma: "Σ",
	tau: "τ",
	upsilon: "υ",
	Upsilon: "Υ",
	phi: "φ",
	varphi: "φ",
	Phi: "Φ",
	chi: "χ",
	psi: "ψ",
	Psi: "Ψ",
	omega: "ω",
	Omega: "Ω",
	pm: "±",
	mp: "∓",
	times: "×",
	cdot: "·",
	div: "÷",
	ast: "*",
	le: "≤",
	leq: "≤",
	ge: "≥",
	geq: "≥",
	neq: "≠",
	ne: "≠",
	approx: "≈",
	sim: "∼",
	propto: "∝",
	infty: "∞",
	partial: "∂",
	nabla: "∇",
	sum: "Σ",
	prod: "Π",
	int: "∫",
	sqrt: "√",
	to: "→",
	rightarrow: "→",
	leftarrow: "←",
	leftrightarrow: "↔",
	in: "∈",
	notin: "∉",
	cup: "∪",
	cap: "∩",
	subset: "⊂",
	subseteq: "⊆",
	superset: "⊃",
	superseteq: "⊇",
	wedge: "∧",
	vee: "∨",
	forall: "∀",
	exists: "∃",
	emptyset: "∅",
	degree: "°",
};

function replaceMathGroups(text: string): string {
	return text
		.replace(
			/\\(?:text|mathrm|operatorname|mathbf|boldsymbol|bm|mathit|mathsf|mathtt)\{([^{}]*)\}/g,
			"$1",
		)
		.replace(/\\mathbb\{R\}/g, "ℝ")
		.replace(/\\mathbb\{N\}/g, "ℕ")
		.replace(/\\mathbb\{Z\}/g, "ℤ")
		.replace(/\\mathbb\{Q\}/g, "ℚ")
		.replace(/\\mathbb\{C\}/g, "ℂ");
}

function readMathGroup(text: string, start: number): { content: string; end: number } | undefined {
	let open = start;
	while (open < text.length && /\s/.test(text[open])) open++;
	if (text[open] !== "{") return undefined;
	let depth = 1;
	for (let index = open + 1; index < text.length; index++) {
		const char = text[index];
		if (char === "{") depth++;
		else if (char === "}") {
			depth--;
			if (depth === 0) return { content: text.slice(open + 1, index), end: index + 1 };
		}
	}
	return undefined;
}

function replaceMathFractions(text: string): string {
	let output = "";
	let index = 0;
	while (index < text.length) {
		const command = ["\\frac", "\\dfrac", "\\tfrac"].find((candidate) =>
			text.startsWith(candidate, index),
		);
		if (!command) {
			output += text[index];
			index++;
			continue;
		}
		const numerator = readMathGroup(text, index + command.length);
		const denominator = numerator ? readMathGroup(text, numerator.end) : undefined;
		if (!numerator || !denominator) {
			output += text[index];
			index++;
			continue;
		}
		output += `(${replaceMathFractions(numerator.content)})/(${replaceMathFractions(denominator.content)})`;
		index = denominator.end;
	}
	return output;
}

/** LaTeX 片段 → 单行 Unicode 文本（multiline=false）或多行（true）。 */
function formatMathForDisplay(raw: string, multiline = true): string {
	let text = raw.replace(/\\\\/g, "\n");
	text = text.replace(/\\(?:begin|end)\{[^{}]+\}/g, "").replace(/&/g, "");
	text = replaceMathGroups(text);
	text = replaceMathFractions(text);
	text = text.replace(/\\sqrt\s*\{([^{}]+)\}/g, "√($1)");
	text = text.replace(/\\([A-Za-z]+)/g, (match, name: string) => MATH_COMMANDS[name] ?? match);
	text = text.replace(/\\(?:left|right|big|Big|bigg|Bigg)/g, "");
	text = text.replace(/_\{([^{}]+)\}/g, "_$1").replace(/\^\{([^{}]+)\}/g, "^$1");
	text = text
		.replace(/[{}]/g, "")
		.replace(/\\[,;!]/g, " ")
		.replace(/\\ /g, " ");
	text = text.replace(/[ \t]+/g, " ").replace(/\s*([=+\-×·÷<>≤≥≈≠|])\s*/g, " $1 ");
	const lines = text
		.split(/\r?\n/)
		.map((line) => line.replace(/[ \t]{2,}/g, " ").trim())
		.filter(Boolean);
	return multiline ? lines.join("\n") : lines.join(" ");
}

/** 原生已能处理的定界符区域：改写环境前先掩码，避免破坏嵌套。 */
const NATIVE_MATH_SPAN_RE = /\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]/g;
/** 行内代码段：掩码保护。 */
const INLINE_CODE_SPAN_RE = /`[^`\n]*`/g;
/** 可改写为 $$ 块的环境（旧 USER_DISPLAY_DELIMITERS 的环境子集）。 */
const DISPLAY_ENV_RE = /\\begin\{(equation\*?|align\*?|aligned)\}([\s\S]*?)\\end\{\1\}/g;
const MASK_TAG = "\uE000";

function maskSpans(text: string, re: RegExp): { text: string; slots: string[] } {
	const slots: string[] = [];
	const masked = text.replace(re, (span) => {
		slots.push(span);
		return `${MASK_TAG}${slots.length - 1}${MASK_TAG}`;
	});
	return { text: masked, slots };
}

function unmaskSpans(text: string, slots: string[]): string {
	return text.replace(new RegExp(`${MASK_TAG}(\\d+)${MASK_TAG}`, "g"), (m, i: string) => {
		const slot = slots[Number(i)];
		return slot === undefined ? m : slot;
	});
}

/**
 * `\begin{equation|align|aligned}…\end{…}`（闭合对）→ `$$…$$`，交给原生竖排。
 * 围栏代码块、掩码区（原生定界符区域、行内代码）与未闭合环境保持原文。
 */
export function rewriteDisplayEnvironments(markdown: string): string {
	if (!markdown.includes("\\begin")) return markdown;
	const lines = markdown.split("\n");
	const out: string[] = [];
	let inFence = false;
	let prose: string[] = [];
	const flushProse = () => {
		if (prose.length === 0) return;
		out.push(rewriteEnvInProse(prose.join("\n")));
		prose = [];
	};
	for (const line of lines) {
		if (/^```/.test(line)) {
			flushProse();
			inFence = !inFence;
			out.push(line);
		} else if (inFence) {
			out.push(line);
		} else {
			prose.push(line);
		}
	}
	flushProse();
	return out.join("\n");
}

/** 单个散文块内的环境改写（调用方已保证不在围栏内）。 */
function rewriteEnvInProse(block: string): string {
	const native = maskSpans(block, NATIVE_MATH_SPAN_RE);
	const masked = maskSpans(native.text, INLINE_CODE_SPAN_RE);
	const rewritten = masked.text.replace(DISPLAY_ENV_RE, (match, _env: string, body: string) =>
		body.trim() ? `$$\n${body.trim()}\n$$` : match,
	);
	return unmaskSpans(unmaskSpans(rewritten, masked.slots), native.slots);
}

function userTextLooksLikeMarkdown(text: string): boolean {
	if (/\r?\n\s*\r?\n/.test(text)) return true;
	if (/^#{1,6}\s/m.test(text) || /```/.test(text)) return true;
	if (/^\s*[-*+]\s/m.test(text) || /^\s*\d+\.\s/m.test(text)) return true;
	if (/https?:\/\//.test(text)) return true;
	return false;
}

/** 紧凑单段表达式（如整行只有一个 \frac）整体转换；文章/路径/标点句一律放过。 */
function shouldFormatUserStandaloneMath(text: string): boolean {
	const plain = text.trim();
	if (!plain?.includes("\\")) return false;
	// $ 包裹的走行内路径，避免定界符残留。
	if (/\$[^$\n]+\$/.test(plain)) return false;
	// \(…\) / \[…\] 定界的交给原生（旧行内/块级路径删除后，此处必须显式豁免）。
	if (/\\\s*[([]/.test(plain)) return false;
	if (userTextLooksLikeMarkdown(text)) return false;
	if (plain.length > 600 || plain.split(/\r?\n/).length > 3) return false;
	if (
		/\\(?:frac|dfrac|tfrac|sqrt|left|right|begin|end|partial|boldsymbol|bm|mathrm|mathbf|mathit|mathsf|mathtt|mathbb|sigma|epsilon|delta|gamma|Gamma|Delta|theta|Theta|pi|Pi|rho|varrho|tau|phi|varphi|Psi|psi|omega|Omega|alpha|beta|mu|nu|xi|chi|sum|prod|int|to|rightarrow|leftarrow|leftrightarrow|infty)/.test(
			plain,
		)
	) {
		return true;
	}
	// \opencode 这类路径与带句号的散文：要求既有上下标又有命令才认。
	if (!/[_^]/.test(plain) || !/\\[A-Za-z]+/.test(plain)) return false;
	return !/[.!?]\s/.test(plain) && plain.length <= 240;
}

/**
 * 用户消息数学：定界符形式（$…$ / $$…$$ / \[…\] / \(…\)）全部透传 Pi 原生；
 * 仅保留无定界符紧凑单段的旧 Unicode 转换（c7074c5 回归保护），且已定界
 * （$$ / \[ 开头）的块直接跳过，避免二次改写。
 */
function renderUserMath(markdown: string): string {
	if (!markdown.includes("\\")) return markdown;
	const lines = markdown.split("\n");
	const out: string[] = [];
	let inFence = false;
	let prose: string[] = [];
	const flushProse = () => {
		if (prose.length === 0) return;
		const block = prose.join("\n");
		let converted = block;
		if (!/^\s*(\$\$|\\\[)/.test(block) && shouldFormatUserStandaloneMath(block)) {
			converted = formatMathForDisplay(block, true);
		}
		out.push(converted);
		prose = [];
	};
	for (const line of lines) {
		if (/^```/.test(line)) {
			flushProse();
			inFence = !inFence;
			out.push(line);
		} else if (inFence) {
			out.push(line);
		} else {
			prose.push(line);
		}
	}
	flushProse();
	return out.join("\n");
}

// ============================================================================
// 跨行链接规整
// ============================================================================

const MULTILINE_LINK_RE = /\[([^\]\n]*(?:\n[^\]\n]*)+)\](?=\()/g;

/** 防止 Markdown 跨行链接把行尾填充空格纳入 OSC 8 点击区。 */
function normalizeMultilineLinks(markdown: string): string {
	const out: string[] = [];
	let prose: string[] = [];
	let fence: MarkdownFence | undefined;
	const flush = () => {
		if (prose.length === 0) return;
		out.push(
			prose.join("\n").replace(MULTILINE_LINK_RE, (_match, label: string) => {
				const normalized = label.replace(/[ \t]*\n[ \t]*/g, " ").trim();
				return `[${normalized}]`;
			}),
		);
		prose = [];
	};
	for (const line of markdown.split("\n")) {
		const scanned = scanMarkdownFence(line, fence);
		const opening = !fence && scanned.fence;
		const closing = fence && !scanned.fence;
		fence = scanned.fence;
		if (opening || closing) flush();
		if (scanned.protected) out.push(line);
		else prose.push(line);
	}
	flush();
	return out.join("\n");
}

// ============================================================================
// 注册
// ============================================================================

export default function (pi: ExtensionAPI): void {
	// 代码块套框（Markdown.render 后处理，与 transformer 槽位无关）。
	installCodeBlockBox();
	// 注意：pi 每个扩展只有一个 markdownTransformer 槽位，多次注册会互相覆盖，
	// 所以剩下的转换合并为一次注册，内部按序链式执行。
	// 提示框和裸 URL 不接管：pi 的 marked 已自带裸 URL 链接化（带尾标点回退，
	// 且在链接文本内不再嵌套），提示框交给默认引用块风格。
	pi.registerMarkdownTransformer((markdown, context) => {
		const { messageType, isStreaming = false } = context ?? {};
		// thinking 保持原文；普通回复即使流式中也先关闭跨行链接的空白点击区。
		if (messageType === "assistant-thinking") return markdown;
		markdown = normalizeMultilineLinks(markdown);
		if (isStreaming) return markdown;
		// 0. 圈数字转半角括号（Nerd Font 补丁字形缺陷规避）
		markdown = deCircled(markdown);
		// 0.1 键帽/dingbat 数字转半角括号（缺 emoji 字体时方框规避）
		markdown = deKeycap(markdown);
		// 0.5 数学环境补齐：\begin{equation|align|aligned} → $$ 块，user 与
		// assistant 通用（原生 block tokenizer 的唯一缺口）；定界符形式其余
		// 全部透传原生。仅 user 消息再走紧凑单段兜底（c7074c5 回归保护）。
		markdown = rewriteDisplayEnvironments(markdown);
		if (messageType === "user") markdown = renderUserMath(markdown);
		// 1. Mermaid 方言渲染
		return renderDiagrams(markdown, context);
	});
}

// grok-mermaid 渲染结果缓存：resize/restored 重绘会重复转换，按源码缓存 art。
// ponytail: 固定上限 50 条，防长期会话膨胀；超出后清空重来。
const ART_CACHE = new Map<string, ReturnType<typeof renderMermaid>>();
const ART_CACHE_MAX = 50;

/** 获取/计算 mermaid art（带缓存）。 */
function getArt(src: string): ReturnType<typeof renderMermaid> | null {
	const cached = ART_CACHE.get(src);
	if (cached) {
		// LRU：命中提到最末，避免常用图被抖动淘汰。
		ART_CACHE.delete(src);
		ART_CACHE.set(src, cached);
		return cached;
	}
	let art = null;
	try {
		art = renderMermaid(src);
	} catch {
		art = null;
	}
	// 满则淘汰最旧一条（原全清会导致抖动时反复重算）。
	if (ART_CACHE.size >= ART_CACHE_MAX) {
		const oldest = ART_CACHE.keys().next().value;
		if (oldest !== undefined) ART_CACHE.delete(oldest);
	}
	if (art) ART_CACHE.set(src, art);
	return art;
}

/** Mermaid 方言代码块 → ASCII 图（流式跳过）。 */
function renderDiagrams(
	markdown: string,
	context?: { isStreaming?: boolean; availableWidth?: number },
): string {
	const { isStreaming = false, availableWidth } = context ?? {};
	if (isStreaming) return markdown;
	const lines = markdown.split("\n");
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const fence = line.match(DIAGRAM_FENCE);
		if (fence) {
			const collected = collectFence(lines, i);
			if (collected) {
				const { diagram, next } = collected;
				// grok-mermaid 需要源码自带类型头，方言头在 fence 标签里时补回去
				const label = fence[2];
				const src = label.toLowerCase() === "mermaid" ? diagram : `${label}\n${diagram}`;
				const art = getArt(src);
				const width = availableWidth ?? 80;
				if (art && art.width <= width) {
					// 图行用硬换行（行尾两空格）连接，防止 Markdown 软换行合并行
					out.push(art.plain.map(codeSpan).join("  \n"));
				} else {
					out.push(framedSource(src, width));
				}
				i = next;
				continue;
			}
			// 未闭合：保持原文
		}
		out.push(line);
		i++;
	}
	return out.join("\n");
}
