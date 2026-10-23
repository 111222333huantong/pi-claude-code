import { visibleWidth } from "@earendil-works/pi-tui";

/** 脱敏占位：摘要抽取前统一剥离。 */
export const THINKING_REDACTED_RE = /\[REDACTED\]/g;
/** pi-tui 的 truncateToWidth 会补 reset；摘要字符串里不需要 ANSI。 */
const THINKING_ANSI_RE = /\u001b\[[0-9;]*m/g;

const THINKING_SUMMARY_MIN_WIDTH = 8;
const THINKING_SUMMARY_MAX_WIDTH = 96;
/** 没有空行/句末换行时，长段落按这个显示宽度兜底切块（CJK 按 2 列算）。 */
const THINKING_CHUNK_MAX_WIDTH = 500;
/** 连续这么久没有新 thinking token，就收掉当前块。 */
export const THINKING_CHUNK_IDLE_MS = 2_000;

function stripThinkingAnsi(text: string): string {
	return text.replace(THINKING_ANSI_RE, "");
}

function cleanThinkingSummaryLine(line: string): string {
	return stripThinkingAnsi(line)
		.replace(THINKING_REDACTED_RE, "")
		.replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/u, "")
		.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
}

function splitThinkingSummarySentences(cleaned: string): string[] {
	const placeholders = new Map<string, string>();
	let protectedText = cleaned.replace(
		/\b(?:e\.g|i\.e|etc|vs|dr|mr|mrs|ms|st|no|fig|approx|inc|ltd)\./gi,
		(match) => {
			const key = `__THINKING_ABBR_${placeholders.size}__`;
			placeholders.set(key, match);
			return key;
		},
	);
	protectedText = protectedText.replace(/\b\d+(?:\.\d+)+\b/g, (match) => {
		const key = `__THINKING_NUM_${placeholders.size}__`;
		placeholders.set(key, match);
		return key;
	});
	const sentences = protectedText.match(/[^.!?。！？]+[.!?。！？]?/gu) ?? [protectedText];
	return sentences.map((sentence) => {
		let restored = sentence.trim();
		for (const [key, value] of placeholders) restored = restored.replaceAll(key, value);
		return restored;
	});
}

/** 从思考原文里抽取可读短句，供已完成块生成一行摘要。 */
export function extractThinkingSummaryCandidates(text: string): string[] {
	if (!text) return [];
	const candidates: string[] = [];
	const seen = new Set<string>();
	let inFence = false;
	for (const rawLine of text.replace(/\r\n?/g, "\n").split("\n")) {
		const trimmed = rawLine.trim();
		if (/^```/.test(trimmed)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		const cleaned = cleanThinkingSummaryLine(trimmed);
		if (!cleaned) continue;
		for (const sentence of splitThinkingSummarySentences(cleaned)) {
			const candidate = sentence.trim();
			if (!candidate) continue;
			if (/^[,;:，；：、)\]】}"“'‘]/u.test(candidate)) continue;
			if (visibleWidth(candidate) < THINKING_SUMMARY_MIN_WIDTH) continue;
			if (!/[\p{L}\p{N}]/u.test(candidate)) continue;
			if (/^(?:\.{3,}|…+)$/u.test(candidate)) continue;
			const key = candidate.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			candidates.push(candidate);
		}
	}
	return candidates;
}

/** 单行 provider 标题解析；流式增量扫描也复用它。 */
export function parseProviderThinkingTitleLine(line: string): string | undefined {
	const match = /^\*\*([^*\n]{1,120})\*\*[ \t]*$/.exec(line.trim());
	if (!match) return undefined;
	const cleaned = cleanThinkingSummaryLine(match[1] ?? "");
	return cleaned ? truncateThinkingSummary(cleaned) : undefined;
}

/**
 * Codex/OpenCode 的 reasoning summary 通常是 "**Section title**\n\nbody"。
 * 有 provider 标题时优先用标题作为摘要，比本地抽句更稳。
 */
export function extractProviderThinkingTitles(text: string): string[] {
	if (!text) return [];
	const titles: string[] = [];
	const seen = new Set<string>();
	let inFence = false;
	for (const rawLine of text.replace(/\r\n?/g, "\n").split("\n")) {
		const line = rawLine.trim();
		if (/^```/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		const title = parseProviderThinkingTitleLine(line);
		if (!title) continue;
		const key = title.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		titles.push(title);
	}
	return titles;
}

/** 把「显示宽度上限」换成字符串 index，避免 CJK 被按 code unit 多切。 */
function indexForVisibleWidth(text: string, maxWidth: number): number {
	let width = 0;
	let index = 0;
	for (const char of text) {
		const charWidth = visibleWidth(char);
		if (width + charWidth > maxWidth) break;
		width += charWidth;
		index += char.length;
	}
	return index;
}

/**
 * 摘要截断：优先在空格/标点处收口，避免出现 `... (e…` 这种半截单词；
 * pi-tui 的 truncateToWidth 会补 ANSI reset，摘要里不需要。
 */
function truncateThinkingSummary(text: string, maxWidth = THINKING_SUMMARY_MAX_WIDTH): string {
	const plain = stripThinkingAnsi(text).trim();
	if (visibleWidth(plain) <= maxWidth) return plain;
	const limit = indexForVisibleWidth(plain, Math.max(1, maxWidth - 1));
	const window = plain.slice(0, limit);
	let cut = -1;
	for (const match of window.matchAll(/[\s,，;；:：、.!?。！？)）\]】]/gu)) {
		const index = (match.index ?? -1) + 1;
		if (index > 0) cut = index;
	}
	if (cut < Math.floor(limit * 0.55)) cut = limit;
	const clipped = window
		.slice(0, cut)
		.trimEnd()
		.replace(/[.,，;；:：、\-—]+$/u, "")
		.replace(/(?:…|\.{3,})$/u, "")
		.replace(
			/\b(?:of|and|to|the|a|an|in|for|with|on|by|as|at|from|into|or|but|that|which)\s*$/iu,
			"",
		)
		.trimEnd();
	return `${clipped || window.trimEnd()}…`;
}

function lastSentenceBoundary(text: string, maxWidth: number): number {
	const limit = indexForVisibleWidth(text, maxWidth);
	const window = text.slice(0, limit);
	let last = -1;
	for (const match of window.matchAll(/[.!?。！？](?=\s|$)/gu)) {
		last = (match.index ?? -1) + 1;
	}
	return last > 0 ? last : limit;
}

/**
 * 从流式 buffer 里切出已完成的思考块。
 * 按成熟项目（Codex / pi-thinking-steps）的 section 粒度：
 * 空行或“句末 + 换行”立即收口；没有边界时按 500 显示列兜底；
 * forceClose 用于收尾和空闲。句中的句号不切，避免一句话一条摘要。
 */
export function splitThinkingChunkBuffer(
	input: string,
	forceClose = false,
): { closed: string[]; rest: string } {
	let rest = input.replace(/\r\n?/g, "\n").replace(/^\s+/, "");
	const closed: string[] = [];
	while (rest.trim()) {
		const boundary = /\n[ \t]*\n|[.!?。！？][ \t]*\n/.exec(rest);
		if (boundary) {
			const blankLine = boundary[0].startsWith("\n");
			const end = boundary.index + (blankLine ? 0 : 1);
			const chunk = rest.slice(0, end).trim();
			if (chunk) closed.push(chunk);
			rest = rest.slice(boundary.index + boundary[0].length).replace(/^\s+/, "");
			continue;
		}
		if (visibleWidth(rest) >= THINKING_CHUNK_MAX_WIDTH) {
			const cut = lastSentenceBoundary(rest, THINKING_CHUNK_MAX_WIDTH);
			const chunk = rest.slice(0, cut).trim();
			if (chunk) closed.push(chunk);
			rest = rest.slice(cut).replace(/^\s+/, "");
			continue;
		}
		break;
	}
	if (forceClose && rest.trim()) {
		closed.push(rest.trim());
		rest = "";
	}
	return { closed, rest };
}

const THINKING_SUMMARY_FILLER_PATTERNS: RegExp[] = [
	/^(?:okay|ok|so|now|well|first|next|then|finally|lastly|alright)[,:\s-]+/i,
	/^(?:the next step is to|next step is to|after that|afterwards|at this point|in addition|additionally)\s+/i,
	/^(?:the user (?:wants|is asking|asked)(?: me)? to|user wants me to)\s+/i,
	/^(?:i|we)\s+(?:need|have|want|should|will|can|must|am going|are going)\s+(?:to\s+)?/i,
	/^(?:i'm|we're)\s+going to\s+/i,
	/^(?:i'll|we'll)\s+(?:to\s+)?/i,
	/^(?:let me|let's)\s+/i,
	/^(?:好的?|那么|现在|接下来|然后|之后|首先|其次|另外|同时|下一步|嗯)[，,：:\s]*/u,
	/^(?:我们|我)(?:需要|应该|要|得|会|可以|准备|先|正在|想)\s*/u,
	/^(?:让我们|让我)\s*/u,
];

function stripThinkingSummaryFiller(text: string): string {
	let out = text.trim();
	for (const pattern of THINKING_SUMMARY_FILLER_PATTERNS) {
		out = out.replace(pattern, "").trim();
	}
	return out.replace(/^[,，;；:：\s]+/u, "").trim();
}

/** pi-thinking-steps 的动作压缩思路：把 "Checking X" 收敛成 "Check X"。 */
const THINKING_GERUND_ACTIONS: Record<string, string> = {
	inspecting: "Inspect",
	checking: "Check",
	verifying: "Verify",
	adding: "Add",
	running: "Run",
	testing: "Test",
	fixing: "Fix",
	updating: "Update",
	reading: "Read",
	writing: "Write",
	implementing: "Implement",
	comparing: "Compare",
	ensuring: "Ensure",
	confirming: "Confirm",
	debugging: "Debug",
	building: "Build",
	creating: "Create",
	modifying: "Modify",
	opening: "Open",
	using: "Use",
	trying: "Try",
	searching: "Search",
	finding: "Find",
	reviewing: "Review",
	refactoring: "Refactor",
	removing: "Remove",
	tracing: "Trace",
	investigating: "Investigate",
	validating: "Validate",
	looking: "Look",
};

const THINKING_ACTION_START_RE =
	/^(?:inspect|check|verify|add|run|test|fix|update|read|write|implement|compare|ensure|confirm|debug|build|create|modify|open|use|try|search|find|review|refactor|remove|trace|investigate|validate|look)\b|^(?:检查|验证|添加|运行|测试|修复|更新|阅读|写入|实现|对比|确认|调试|构建|创建|修改|打开|使用|尝试|搜索|查找|审查|重构|删除|追踪|调查|查看)/iu;
/** 只把“结果/决策”当强信号；will/should/need to 是计划，不再加分。 */
const THINKING_RESULT_RE =
	/\b(?:failed|failure|error|passed|succeed(?:ed)?|successful|works?|fixed|bug|issue|decided|decision|found|resolved|blocked|cannot|unable)\b|(?:失败|错误|通过|成功|修复|问题|决定|发现|解决|阻塞|无法)/iu;
const THINKING_DECISION_RE =
	/\b(?:decided|decision|chose|choose|switched|replaced|confirmed|recommended|recommend)\b|(?:决定|选择|保留|保持|确认|推荐)/iu;
const THINKING_PLAN_KEEP_RE =
	/\b(?:keep|preserve)\s+(?:the\s+)?(?:current|existing|baseline|summary|summarizer|plan|behavior)\b/i;
const THINKING_PATH_RE =
	/(?:[\w./-]+\.(?!g\b|i\b|e\b)[a-z0-9]{2,8}\b|\b[a-zA-Z_][a-zA-Z0-9_]*(?:_[A-Za-z0-9]+|[A-Z][A-Za-z0-9]*)\([^)\n]*\))/u;
const THINKING_CONCRETE_RE =
	/(?:`[^`]+`|O\([^)]+\)|\b(?:npm|node|git|pnpm|yarn|bun|tsc|biome|api|tui|ui|render(?:er|ers|ing)?|cache|queues?|latency|memory|chunk|buffer|parser|component|stream|virtual(?:ized|ization)?|slo|p50|p95|gpu|sse|json|schema|token|deadline|batch|hash|diff|ids?)\b|\b\d+(?:\.\d+)?\s*(?:ms|s|kb|mb|gb|%|fps|hz)\b|(?:渲染|缓存|队列|延迟|内存|组件|代码|文件|路径|函数|接口|数据|模型|摘要|分段|流式|列表|终端|测试|构建|错误|失败|成功|性能|虚拟化|背压|令牌|哈希|协议|框架))/iu;
const THINKING_DIRECT_ACTION_RE =
	/^(?:inspect|check|verify|add|run|test|fix|update|read|write|implement|compare|ensure|confirm|debug|build|create|modify|open|use|try|search|find|review|refactor|remove|trace|investigate|validate|gather|retrieve|list|archive|explore)\b|^(?:检查|验证|添加|运行|测试|修复|更新|阅读|写入|实现|对比|确认|调试|构建|创建|修改|打开|使用|尝试|搜索|查找|审查|重构|删除|追踪|调查|查看)/iu;
const THINKING_VAGUE_START_RE =
	/^(?:look(?:ing)? at|think(?:ing)? about|consider(?:ing)?|wonder(?:ing)?|it seems|it looks|maybe|perhaps|看起来|似乎|也许|考虑)/iu;
/** 弱转折/衔接开头：没有具体对象时基本是半句话。 */
const THINKING_WEAK_START_RE =
	/^(?:and|but|or|so|then|though|while|which|because|however|therefore|perhaps|maybe|possibly|probably|also|still|just|since|could|would|should)\b|^(?:但是|但|不过|所以|然后|而且|因此|可能|也许|另外|同时|还有|只是|如果|因为)/iu;
/**
 * 元话语：在描述“用户/问题/回答/格式/下一步/确保”而不是任务内容。
 * 带路径、结果、决策等强信号时仍允许保留（如 “Plan to inspect src/a.ts”）。
 */
const THINKING_META_PLANNING_RE =
	/^(?:the user|user (?:asks|wants|is asking|asked)|they (?:wants?|asks?|asked|need|needs|have)|the prompt|prompt says|the question|question says|the task says|the request|the requirement|the instruction|the docs?\b|docs?\s+(?:mention|say)|the repo\b|the code\b|it (?:mentions|says|seems|looks|notes|may|might|could)|this (?:seems|is about|may|might|could|relates)|one nuance|that would|that's|i(?:'m| am)? (?:thinking|going|need|should|will|can|must|have)|i could|we can|let me|let's|maybe|perhaps|possibly|probably|need(?:s)?\b|answer|respond|reply|request|write|formulate|draft|craft|ensure|make sure|remember|note that|consider|think(?:ing)?\b|plan(?:ning)?\b|outline|structure|final answer|recommendation\b(?!\s*:)|summary\b|deliverable|requirements?|constraints?|prompt\b|analysis\b|(?:one|two|three|four|five|six|seven|eight|nine|ten)\s+points?\b|points?\s*\d+|step\s*\d+|sentence\s*\d*|output\b|format\b|language\b|chinese\b|english\b|use tools?|no tools?|just answer|pick \d+|keep (?:it|to|this|the (?:answer|response|format|summary|intro|conclusion|opening|closing))|emit|invoke|call|trigger|execute)\b/i;
const THINKING_META_PLANNING_CN_RE =
	/^(?:用户|问题|题干|要求|目标|任务|我需要|我们需要|需要|应该|要(?:先|用|回答|输出|确保|保持)?|先|首先|其次|然后|接下来|另外|同时|最后|回答|答复|输出|总结|概括|推荐|建议|确保|注意|记住|考虑|分析|计划|思路|三点|两点|每点|字数|格式|语言|中文|英文|用工具|不要用工具|它提到|文档|代码里|说明|提到)/u;
const THINKING_META_JUDGMENT_RE =
	/\b(?:is fine|is it necessary|not necessary|do we need|should we|maybe not|probably not|here they ask)\b|(?:有必要吗|没必要|是否必要|要不要)/iu;
const THINKING_OUTPUT_META_RE =
	/\b(?:opening|closing|intro(?:duction)?|preface|plain text|numbered|bullet|tone|wording|phrasing|sentences?|paragraph|brief|fine|over-length|overlength|too long|length limit|count (?:the )?(?:periods?|sentences?|words?)|periods? in each|exactly (?:one|two|three|four|five|\d+)|each (?:point|sentence)|keep (?:concise|detailed|brief|short|simple|focused))\b|(?:开头|结尾|前言|纯文本|编号|语气|措辞|句子|段落|过长|每点|计数)/iu;
const THINKING_META_ANYWHERE_RE =
	/\b(?:sentences?|paragraph|requirements?|points?|question|framing|nuance|accordingly|plain text|chinese|english|brief|opening|closing|that's)\b|(?:句子|段落|要求|提示|问题|中文|英文|要点)/iu;
const THINKING_HEADING_LABEL_RE =
	/^(?:key|main|important|core|design|implementation|summary|overview|introduction|conclusion)\s+(?:design\s+)?(?:considerations|points|aspects|steps|topics|details|notes)$/iu;

function hasStrongThinkingCue(text: string): boolean {
	return (
		THINKING_PATH_RE.test(text) ||
		THINKING_RESULT_RE.test(text) ||
		THINKING_DECISION_RE.test(text) ||
		THINKING_PLAN_KEEP_RE.test(text)
	);
}

function hasConcreteThinkingCue(text: string): boolean {
	return hasStrongThinkingCue(text) || THINKING_CONCRETE_RE.test(text);
}

function isIncompleteThinkingSummary(text: string): boolean {
	const straightQuotes = (text.match(/"/g) ?? []).length;
	if (straightQuotes % 2 !== 0) return true;
	const openCurly = (text.match(/[“「]/g) ?? []).length;
	const closeCurly = (text.match(/[”」]/g) ?? []).length;
	if (openCurly !== closeCurly) return true;
	const openBrackets = (text.match(/[([{（【]/g) ?? []).length;
	const closeBrackets = (text.match(/[)\]）】}]/g) ?? []).length;
	if (closeBrackets > openBrackets) return true;
	return /[<([（【{]\s*[\p{L}\p{N}]{0,3}$/u.test(text);
}

function shouldSkipThinkingSummary(text: string): boolean {
	if (isIncompleteThinkingSummary(text)) return true;
	if (THINKING_HEADING_LABEL_RE.test(text)) return true;
	const width = visibleWidth(text);
	const shortDirectAction = width >= 12 && THINKING_DIRECT_ACTION_RE.test(text);
	if (width < 24 && !hasConcreteThinkingCue(text) && !shortDirectAction) return true;
	if (THINKING_META_PLANNING_RE.test(text) || THINKING_META_PLANNING_CN_RE.test(text)) {
		return !hasStrongThinkingCue(text);
	}
	if (THINKING_META_JUDGMENT_RE.test(text)) return !hasStrongThinkingCue(text);
	if (THINKING_OUTPUT_META_RE.test(text)) return !hasStrongThinkingCue(text);
	if (THINKING_META_ANYWHERE_RE.test(text)) return !hasStrongThinkingCue(text);
	if (THINKING_WEAK_START_RE.test(text)) return !hasConcreteThinkingCue(text);
	return false;
}

function normalizeThinkingAction(text: string): string {
	const match = /^([A-Za-z]+)/.exec(text);
	const replacement = match ? THINKING_GERUND_ACTIONS[match[1]!.toLowerCase()] : undefined;
	let out = replacement ? replacement + text.slice(match![1]!.length) : text;
	if (/^[a-z]/.test(out)) out = out[0]!.toUpperCase() + out.slice(1);
	return out;
}

function scoreThinkingSummaryCandidate(text: string): number {
	let score = 0;
	const strong = hasStrongThinkingCue(text);
	const concrete = hasConcreteThinkingCue(text);
	if (THINKING_DIRECT_ACTION_RE.test(text)) score += 12;
	else if (THINKING_ACTION_START_RE.test(text)) score += 5;
	if (THINKING_RESULT_RE.test(text)) score += 8;
	if (THINKING_DECISION_RE.test(text)) score += 5;
	if (THINKING_PATH_RE.test(text)) score += 4;
	if (concrete) score += 2;
	if (strong) score += 4;
	if (THINKING_VAGUE_START_RE.test(text)) score -= 16;
	if (
		!strong &&
		(THINKING_META_PLANNING_RE.test(text) || THINKING_META_PLANNING_CN_RE.test(text))
	) {
		score -= 20;
	}
	if (THINKING_WEAK_START_RE.test(text)) score -= 8;
	if (isIncompleteThinkingSummary(text)) score -= 30;
	const width = visibleWidth(text);
	if (width >= 12) score += 1;
	if (/^(?:this|that|it)\b/i.test(text)) score -= 1;
	return score;
}

/** 把一个已完成思考块压成一行摘要；候选句按动作/结果/路径做轻量打分。 */
export function summarizeThinkingChunk(chunk: string): string | undefined {
	const candidates = extractThinkingSummaryCandidates(chunk);
	if (candidates.length === 0) return undefined;
	let best: { text: string; score: number } | undefined;
	for (const original of candidates) {
		const stripped = stripThinkingSummaryFiller(original);
		const normalized = normalizeThinkingAction(
			(stripped || original).replace(/[.。;；,，:：]+$/u, "").trim(),
		);
		if (!normalized) continue;
		if (shouldSkipThinkingSummary(normalized)) continue;
		const score = scoreThinkingSummaryCandidate(normalized);
		if (!best || score > best.score) best = { text: normalized, score };
	}
	if (!best || best.score <= 0) return undefined;
	return truncateThinkingSummary(best.text);
}
