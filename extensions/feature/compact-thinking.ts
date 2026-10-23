// compact-thinking 本地内联实现。fork 自 pi-compact-thinking（MIT，
// https://github.com/tifandotme/pi-extensions/tree/master/packages/pi-compact-thinking）。
// 差异：
// 1. 不再依赖上游包 —— 配置解耦，由 claude-code-style 经 installCompactThinking
//    /updateConfig 管控（模块级 config 对象，不再读写 compact-thinking.json）。
// 2. 合并了上游 fork patch：subagent 工具（Agent/Agents）执行期间保持思考动画，
//    直到 tool_execution_end 或下一个 text/thinking 边界才收尾。
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	type ExtensionAPI,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Box,
	type Component,
	getKeybindings,
	Markdown,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	animateCompactThinkingText,
	formatThoughtDuration,
	styleCompactThinkingText,
} from "../renderer/compact-mode.ts";
import { isToolTuiFullscreen } from "../renderer/tool/names.ts";
import { TOOL_CARD_BG_SLOT } from "../renderer/tool/tool-state.ts";
import { refreshMountedTranscript } from "../renderer/transcript-refresh.ts";
import {
	COMPACT_THINKING_OWNER,
	COMPACT_THINKING_PATCH_KEY,
	PROTOTYPE_ORIGINAL_KEY,
	patchRegistry,
} from "../utils/patch-keys.ts";
import { THINKING_REDACTED_RE } from "./thinking-summary.ts";
import { ThinkingSummaryStream } from "./thinking-summary-stream.ts";

// 兼容旧的内部导入路径；纯摘要函数现在在 thinking-summary.ts。
export {
	extractProviderThinkingTitles,
	extractThinkingSummaryCandidates,
	splitThinkingChunkBuffer,
	summarizeThinkingChunk,
} from "./thinking-summary.ts";

// pi-tui 类型声明中 TUI 的 re-export 解析失败，本地用最小结构化类型（只用到 requestRender）。
type RenderTui = { requestRender(force?: boolean): void };

// pi-coding-agent 的类型声明中 AssistantMessageComponent 仅能以 value 形式使用。
type AssistantMessageComponentLike = InstanceType<typeof AssistantMessageComponent>;

export type CompactThinkingConfig = {
	useSummaryTitlesAsThinkingTitle: boolean;
	previewLines: number;
	animationIntervalMs: number;
	/** 展开中间态 tail 窗口行数（Crush 式）；超长先给尾部，再推进全文。 */
	thinkingExpandedMaxLines: number;
	/** 活动思考标题扫光 + 按段落累积摘要；关闭回到静态标题。 */
	thinkingLiveSummary?: boolean;
	/** 折叠态保留的最近摘要条数。 */
	thinkingSummaryLimit?: number;
	/** 展开态显示原始 thinking；默认只显示摘要列表。 */
	showRawThinking?: boolean;
};

export type CompactThinkingController = {
	updateConfig(next: CompactThinkingConfig): void;
	/**
	 * 只读查询：某条 assistant message 的可见思考总时长（ms）。
	 * 供 compact 渲染层生成 `Thought for 8s` 摘要，不建立第二套计时器。
	 * 无记录且无进行中思考时返回 undefined。
	 */
	getMessageThinkingDurationMs?(messageTimestamp: number): number | undefined;
	/** 当前消息是否仍处于 compact-thinking 的活动思考态。 */
	isMessageThinkingActive?(messageTimestamp: number): boolean;
	/** 复用 compact-thinking 配置的动画帧，不建立独立动画计时器。 */
	getThinkingAnimationFrame?(): number;
	/** compact 摘要保持 loading 时复用 compact-thinking 的动画循环。 */
	setCompactSummaryActive?(active: boolean): void;
};

type DurationEntryData = {
	messageTimestamp: number;
	contentIndex: number;
	durationMs: number;
};

type SummaryPart = {
	title: string;
	body: string;
};

type ActiveThinking = {
	messageTimestamp: number;
	contentIndex: number;
	startedAt: number;
};

// pi-coding-agent 类型声明中 MarkdownTransformer 的 re-export 解析失败，本地用最小结构化类型。
type MarkdownTransformer = (
	markdown: string,
	context: {
		messageType: "user" | "assistant" | "assistant-thinking";
		isStreaming: boolean;
		availableWidth: number;
	},
) => string;

type AssistantInternals = {
	contentContainer: {
		clear(): void;
		addChild(component: Component): void;
	};
	hideThinkingBlock: boolean;
	markdownTheme: ConstructorParameters<typeof Markdown>[3];
	hiddenThinkingLabel: string;
	outputPad: number;
	isStreaming: boolean;
	markdownTransformers: readonly MarkdownTransformer[];
	lastMessage?: AssistantMessage;
	hasToolCalls: boolean;
	updateContent(message: AssistantMessage): void;
};

type PatchedPrototype = typeof AssistantMessageComponent.prototype & {
	updateContent: (message: AssistantMessage, isStreaming?: boolean) => void;
};

// 配置由 claude-code-style 管控（installCompactThinking 注入初始值，
// updateConfig 运行时更新），上游的配置文件读写已移除。
const COMPACT_THINKING_DEFAULTS: Required<CompactThinkingConfig> = {
	useSummaryTitlesAsThinkingTitle: true,
	previewLines: 3,
	animationIntervalMs: 90,
	thinkingExpandedMaxLines: 200,
	// Tests and direct library callers keep the old raw renderer unless they opt in.
	// The host config always passes the real default (true).
	thinkingLiveSummary: false,
	thinkingSummaryLimit: 5,
	showRawThinking: false,
};

const config: CompactThinkingConfig = { ...COMPACT_THINKING_DEFAULTS };

const DURATION_ENTRY_TYPE = "compact-thinking-duration";

/** 当前激活 session 的只读查询委托（compact 渲染层使用）。 */
type ThinkingDurationQuery = (messageTimestamp: number) => number | undefined;
type ThinkingActiveQuery = (messageTimestamp: number) => boolean;
let activeThinkingQuery: ThinkingDurationQuery | undefined;
let activeThinkingStateQuery: ThinkingActiveQuery | undefined;
let activeThinkingAnimationFrameQuery: (() => number) | undefined;
let activeCompactSummarySetter: ((active: boolean) => void) | undefined;

function restoreDurationEntries(
	entries: Array<{ type: string; customType?: string; data?: unknown }>,
	completedDurations: Map<number, Map<number, number>>,
) {
	completedDurations.clear();
	for (const entry of entries) {
		if (
			entry.type !== "custom" ||
			entry.customType !== DURATION_ENTRY_TYPE ||
			!entry.data ||
			typeof entry.data !== "object"
		) {
			continue;
		}

		const data = entry.data as Partial<DurationEntryData>;
		if (
			typeof data.messageTimestamp !== "number" ||
			!Number.isFinite(data.messageTimestamp) ||
			typeof data.contentIndex !== "number" ||
			!Number.isInteger(data.contentIndex) ||
			typeof data.durationMs !== "number" ||
			!Number.isFinite(data.durationMs) ||
			data.durationMs < 1
		) {
			continue;
		}

		let durations = completedDurations.get(data.messageTimestamp);
		if (!durations) {
			durations = new Map();
			completedDurations.set(data.messageTimestamp, durations);
		}
		durations.set(data.contentIndex, data.durationMs);
	}
}

function getThinkingToggleHint() {
	const keys = getKeybindings().getKeys("app.thinking.toggle");
	return keys.length > 0 ? `${keys.join("/")} to expand` : undefined;
}

function thinkingExpandAction(): string | undefined {
	return isToolTuiFullscreen() ? "click to show more" : getThinkingToggleHint();
}

// 只 wrap 头部窗口；缓存未着色折行，着色放到取出时做，避免主题切换命中旧 ANSI。
type PreviewCacheEntry = { lines: string[]; hiddenOutside: number };
const previewCache = new Map<string, PreviewCacheEntry>();
export const THINKING_PREVIEW_CACHE_MAX = 2_048;
const PREVIEW_BUDGET_MIN_CHARS = 2_000;
const PREVIEW_BUDGET_SLACK_LINES = 2;

function getCachedPreview(key: string): PreviewCacheEntry | undefined {
	const entry = previewCache.get(key);
	if (!entry) return undefined;
	previewCache.delete(key);
	previewCache.set(key, entry);
	return entry;
}

function cachePreview(key: string, entry: PreviewCacheEntry): void {
	previewCache.delete(key);
	while (previewCache.size >= THINKING_PREVIEW_CACHE_MAX) {
		const oldest = previewCache.keys().next().value;
		if (oldest === undefined) break;
		previewCache.delete(oldest);
	}
	previewCache.set(key, entry);
}

export function clearThinkingPreviewCache(): void {
	previewCache.clear();
	expandedWrapCache.clear();
	expandedMarkdownCache.clear();
}

type ExpandedWrapEntry = { text: string; lines: string[] };
const expandedWrapCache = new Map<string, ExpandedWrapEntry>();
export const THINKING_EXPANDED_WRAP_CACHE_MAX = 64;

function expandedWrapKey(messageTimestamp: number, runStartIndex: number, width: number): string {
	return `${messageTimestamp}:${runStartIndex}:${width}`;
}

function wrapExpandedThinking(
	messageTimestamp: number,
	runStartIndex: number,
	text: string,
	width: number,
): string[] {
	const key = expandedWrapKey(messageTimestamp, runStartIndex, width);
	const hit = expandedWrapCache.get(key);
	if (hit && hit.text === text) {
		expandedWrapCache.delete(key);
		expandedWrapCache.set(key, hit);
		return hit.lines;
	}
	const lines = wrapTextWithAnsi(text.replace(/\t/g, "   "), Math.max(1, width));
	expandedWrapCache.delete(key);
	while (expandedWrapCache.size >= THINKING_EXPANDED_WRAP_CACHE_MAX) {
		const oldest = expandedWrapCache.keys().next().value;
		if (oldest === undefined) break;
		expandedWrapCache.delete(oldest);
	}
	expandedWrapCache.set(key, { text, lines });
	return lines;
}

function evictExpandedWraps(messageTimestamp: number, runStartIndex: number): void {
	for (const key of expandedWrapCache.keys()) {
		const [ts, run] = key.split(":");
		if (Number(ts) === messageTimestamp && Number(run) === runStartIndex) {
			expandedWrapCache.delete(key);
		}
	}
	for (const key of expandedMarkdownCache.keys()) {
		const [ts, run] = key.split(":");
		if (Number(ts) === messageTimestamp && Number(run) === runStartIndex) {
			expandedMarkdownCache.delete(key);
		}
	}
}

export function thinkingPreviewCacheSize(): number {
	return previewCache.size;
}

export function thinkingExpandedWrapCacheSize(): number {
	return expandedWrapCache.size;
}

/**
 * 展开态 Markdown 渲染缓存（完成态定稿才进，流式保持裸文本）。
 * 与 expandedWrapCache 同键、独立表。Markdown 输出自带主题 ANSI，
 * 因此条目绑定渲染用主题对象，主题切换即失效重渲。
 */
type ExpandedMarkdownEntry = { text: string; theme: unknown; lines: string[] };
const expandedMarkdownCache = new Map<string, ExpandedMarkdownEntry>();
export const THINKING_EXPANDED_MARKDOWN_CACHE_MAX = 32;

function renderExpandedMarkdown(
	messageTimestamp: number,
	runStartIndex: number,
	text: string,
	width: number,
	render: () => string[],
	theme: unknown,
): string[] {
	const key = expandedWrapKey(messageTimestamp, runStartIndex, width);
	const hit = expandedMarkdownCache.get(key);
	if (hit && hit.text === text && hit.theme === theme) {
		expandedMarkdownCache.delete(key);
		expandedMarkdownCache.set(key, hit);
		return hit.lines;
	}
	const lines = render();
	expandedMarkdownCache.delete(key);
	while (expandedMarkdownCache.size >= THINKING_EXPANDED_MARKDOWN_CACHE_MAX) {
		const oldest = expandedMarkdownCache.keys().next().value;
		if (oldest === undefined) break;
		expandedMarkdownCache.delete(oldest);
	}
	expandedMarkdownCache.set(key, { text, theme, lines });
	return lines;
}

export function thinkingExpandedMarkdownCacheSize(): number {
	return expandedMarkdownCache.size;
}

/** 按可见宽度估算折行数，不走 Text 全量 wrap。无换行长段也能计到隐藏行。 */
function countWrappedLines(text: string, contentWidth: number): number {
	if (!text) return 0;
	const width = Math.max(1, contentWidth);
	let lines = 0;
	for (const raw of text.replace(/\t/g, "   ").split(/\r\n|\r|\n/)) {
		const w = visibleWidth(raw);
		lines += w === 0 ? 1 : Math.ceil(w / width);
	}
	return lines;
}

function padPreviewLine(line: string, width: number, padding: number): string {
	const left = padding > 0 ? " ".repeat(padding) : "";
	const right = padding > 0 ? " ".repeat(padding) : "";
	const withMargins = left + line + right;
	return withMargins + " ".repeat(Math.max(0, width - visibleWidth(withMargins)));
}

function layoutThinkingPreview(
	text: string,
	width: number,
	padding: number,
	/** true=取尾部窗口（流式追随最新，视觉上随内容滚动），false=取头部窗口（完成后停在起点）。 */
	followTail = false,
): { visible: string[]; hiddenLines: number } {
	if (!text || config.previewLines <= 0) return { visible: [], hiddenLines: 0 };
	// 折叠预览丢弃空行：段落间隔不占窗口，窗口全给内容行（展开全文保留原样）。
	const dense = text
		.split(/\r\n|\r|\n/)
		.filter((line) => line.trim() !== "")
		.join("\n");
	if (!dense) return { visible: [], hiddenLines: 0 };
	const contentWidth = Math.max(1, width - padding * 2);
	const budget = Math.max(
		width * (config.previewLines + PREVIEW_BUDGET_SLACK_LINES),
		PREVIEW_BUDGET_MIN_CHARS,
	);
	let source = dense;
	let cut = followTail ? 0 : dense.length;
	if (source.length > budget) {
		if (followTail) {
			const start = source.length - budget;
			const newline = source.indexOf("\n", start);
			cut = newline === -1 ? start : newline + 1;
			if (cut < source.length) source = source.slice(cut);
			else cut = 0;
		} else {
			const newline = source.lastIndexOf("\n", budget);
			cut = newline === -1 ? budget : newline;
			source = source.slice(0, cut);
		}
	}
	const cacheKey = `${followTail ? "tail" : "head"}:${width}:${padding}:${cut}:${source}`;
	let entry = getCachedPreview(cacheKey);
	if (!entry) {
		entry = {
			lines: wrapTextWithAnsi(source.replace(/\t/g, "   "), contentWidth),
			hiddenOutside: followTail
				? cut > 0
					? countWrappedLines(dense.slice(0, cut), contentWidth)
					: 0
				: cut < dense.length
					? countWrappedLines(dense.slice(cut), contentWidth)
					: 0,
		};
		cachePreview(cacheKey, entry);
	}
	const hiddenLines = entry.hiddenOutside + Math.max(0, entry.lines.length - config.previewLines);
	const visible =
		hiddenLines > 0
			? followTail
				? entry.lines.slice(-config.previewLines)
				: entry.lines.slice(0, config.previewLines)
			: entry.lines;
	return { visible, hiddenLines };
}

function hiddenPreviewHint(
	hiddenLines: number,
	forceExpandHint = false,
	kind: "line" | "summary" = "line",
): { prefix: string; action: string; suffix: string } | undefined {
	const action = thinkingExpandAction() ?? "";
	if (hiddenLines > 0) {
		const noun =
			kind === "summary"
				? hiddenLines === 1
					? "summary"
					: "summaries"
				: hiddenLines === 1
					? "line"
					: "lines";
		// 与其它提示同一套写法：小圆点连接，不用逗号和括号
		return {
			prefix: ` · ${hiddenLines} more ${noun}${action ? " · " : ""}`,
			action,
			suffix: "",
		};
	}
	if (forceExpandHint && isToolTuiFullscreen()) {
		return { prefix: " · ", action: "click to show more", suffix: "" };
	}
	return undefined;
}

const expandedThinking = new Set<string>();
/** 展开全文态（tail 之后的第二段推进；短块 tail 即全文，不经过此集合也能全显）。 */
const fullExpandedThinking = new Set<string>();
const thinkingKey = (messageTimestamp: number, runStartIndex: number): string =>
	`${messageTimestamp}:${runStartIndex}`;

/** 折叠预览 + 展开全文。fullscreen 点击 hint 展开、展开卡单击整块收起（拖动选择文本时不收起）。 */
export class ThinkingPreviewBlock implements Component {
	private heading: string;
	private text: string;
	private padding: number;
	readonly messageTimestamp: number;
	readonly runStartIndex: number;
	private style: (text: string) => string;
	private theme: Theme | undefined;
	private hintHovered = false;
	private markdownTheme: ConstructorParameters<typeof Markdown>[3] | undefined;
	private markdownTransform: ((markdown: string, availableWidth: number) => string) | undefined;
	/** 流式活动态是否追随尾部（视觉滚动）；完成后固定头部。每次 updateContent 重建，状态不跨帧残留。 */
	private followTail: boolean;
	/** undefined = 旧原生 preview 模式；数组 = 摘要流模式。 */
	private summaryLines: string[] | undefined;
	/** 展开态是否放行原始 thinking（默认只显示摘要）。 */
	private showRawThinking: boolean;
	/** 活动态标题在每次 render 时重算，动画 timer 只需 requestRender。 */
	private headingProvider: (() => string) | undefined;
	private collapsedMemo:
		| {
				width: number;
				previewLines: number;
				hintHovered: boolean;
				expandAction: string | undefined;
				followTail: boolean;
				heading: string;
				summaryKey: string;
				summaryMode: boolean;
				lines: string[];
		  }
		| undefined;

	constructor(
		heading: string,
		text: string,
		padding: number,
		messageTimestamp: number,
		style: (text: string) => string,
		theme?: Theme,
		runStartIndex = 0,
		followTail = false,
		markdownTheme?: ConstructorParameters<typeof Markdown>[3],
		markdownTransform?: (markdown: string, availableWidth: number) => string,
		summaryLines?: string[],
		showRawThinking = false,
		headingProvider?: () => string,
	) {
		this.heading = heading;
		this.text = text;
		this.padding = padding;
		this.messageTimestamp = messageTimestamp;
		this.runStartIndex = runStartIndex;
		this.followTail = followTail;
		this.style = style;
		this.theme = theme;
		this.markdownTheme = markdownTheme;
		this.markdownTransform = markdownTransform;
		this.summaryLines = summaryLines;
		this.showRawThinking = showRawThinking;
		this.headingProvider = headingProvider;
	}

	private paint(color: string, text: string): string {
		return this.theme && typeof this.theme.fg === "function"
			? this.theme.fg(color as never, text)
			: text;
	}

	/** 展开态按消息时间戳 + run 序号共享：面板重排/内容重建换掉实例后，
	 *  布局里的旧实例与 render 的新实例同键，点谁都能展开。 */
	get expanded(): boolean {
		return expandedThinking.has(`${this.messageTimestamp}:${this.runStartIndex}`);
	}

	setExpanded(expanded: boolean): void {
		const key = thinkingKey(this.messageTimestamp, this.runStartIndex);
		if (expanded) {
			if (!expandedThinking.has(key)) {
				expandedThinking.add(key);
			} else {
				// 间隔推进 tail → full（Crush 三态）；短块 tail 即全文，此步无视觉变化。
				fullExpandedThinking.add(key);
			}
		} else {
			expandedThinking.delete(key);
			fullExpandedThinking.delete(key);
			evictExpandedWraps(this.messageTimestamp, this.runStartIndex);
		}
		this.collapsedMemo = undefined;
	}

	setHintHovered(hovered: boolean): void {
		if (this.hintHovered !== hovered) this.collapsedMemo = undefined;
		this.hintHovered = hovered;
	}

	private headingLines(
		width: number,
		hiddenLines: number,
		padding: number,
		kind: "line" | "summary" = "line",
		headingText = this.headingProvider?.() ?? this.heading,
	): string[] {
		const hint = this.expanded
			? undefined
			: hiddenPreviewHint(hiddenLines, Boolean(this.text) && config.previewLines <= 0, kind);
		if (!hint) return new Text(headingText, padding, 0).render(width);
		const rawHint = hint.prefix + hint.action + hint.suffix;
		const contentWidth = Math.max(1, width - padding * 2);
		const headingBudget = Math.max(0, contentWidth - visibleWidth(rawHint));
		const clipped =
			visibleWidth(headingText) > headingBudget
				? truncateToWidth(headingText, headingBudget, "")
				: headingText;
		const action = this.paint(this.hintHovered ? "text" : "dim", hint.action);
		return new Text(
			clipped + this.paint("dim", hint.prefix) + action + this.paint("dim", hint.suffix),
			padding,
			0,
		).render(width);
	}

	/** 摘要流：折叠显示最近 N 条，展开显示全部（受 expanded max lines 保护）。 */
	private summaryBodyLines(
		width: number,
		padding: number,
		expanded: boolean,
	): { lines: string[]; hidden: number; tailHint?: string } {
		if (this.summaryLines === undefined) return { lines: [], hidden: 0 };
		const limit = expanded
			? Math.max(1, config.thinkingExpandedMaxLines ?? 200)
			: Math.max(1, config.thinkingSummaryLimit ?? 5);
		const hidden = Math.max(0, this.summaryLines.length - limit);
		const visible = hidden > 0 ? this.summaryLines.slice(-limit) : this.summaryLines;
		const contentWidth = Math.max(1, width - padding * 2);
		return {
			lines: visible.map(
				(summary) => `· ${truncateToWidth(summary, Math.max(1, contentWidth - 2), "…")}`,
			),
			hidden,
			tailHint: expanded && hidden > 0 ? `… ${hidden} earlier summaries hidden` : undefined,
		};
	}

	private bodyLines(
		width: number,
		padding: number,
	): { lines: string[]; hiddenLines: number; tailHint?: string; markdown?: boolean } {
		if (!this.text || (config.previewLines <= 0 && !this.expanded)) {
			return { lines: [], hiddenLines: 0 };
		}
		if (this.expanded) {
			// 完成态定稿走 Markdown 结构化渲染（标题/列表/代码块成型，含代码块套框补丁）；
			// 流式增量永不进 Markdown，折叠预览保持裸文本。
			// 主题未就绪等异常直接回退裸文本：render 内绝不抛错。
			let full: string[];
			if (this.markdownTheme !== undefined) {
				try {
					full = renderExpandedMarkdown(
						this.messageTimestamp,
						this.runStartIndex,
						this.text,
						width,
						() =>
							new Markdown(
								this.text,
								0,
								0,
								this.markdownTheme!,
								{ color: (text) => this.style(text), italic: true },
								this.markdownTransform !== undefined
									? { transform: this.markdownTransform }
									: undefined,
							).render(Math.max(1, width)),
						this.theme,
					);
				} catch {
					full = wrapExpandedThinking(this.messageTimestamp, this.runStartIndex, this.text, width);
				}
			} else {
				full = wrapExpandedThinking(this.messageTimestamp, this.runStartIndex, this.text, width);
			}
			const cap = Math.max(1, config.thinkingExpandedMaxLines);
			// 超长先给尾部窗口 + 顶部 hint（Crush tail-window），再推进全文；短块直达全文。
			if (
				full.length > cap &&
				!fullExpandedThinking.has(thinkingKey(this.messageTimestamp, this.runStartIndex))
			) {
				return {
					lines: full.slice(-cap),
					hiddenLines: 0,
					tailHint: `… ${full.length - cap} earlier lines hidden`,
					markdown: this.markdownTheme !== undefined,
				};
			}
			return { lines: full, hiddenLines: 0, markdown: this.markdownTheme !== undefined };
		}
		const preview = layoutThinkingPreview(this.text, width, padding, this.followTail);
		return { lines: preview.visible, hiddenLines: preview.hiddenLines };
	}

	render(width: number) {
		if (this.expanded) {
			const innerWidth = Math.max(1, width - 2);
			const summaryMode = this.summaryLines !== undefined && !this.showRawThinking;
			let heading: string[];
			let bodyLines: string[];
			let tailHint: string | undefined;
			if (summaryMode) {
				const body = this.summaryBodyLines(innerWidth, 0, true);
				heading = this.headingLines(innerWidth, 0, 0, "summary");
				bodyLines = body.lines.map((line) => this.style(line));
				tailHint = body.tailHint;
			} else {
				const body = this.bodyLines(innerWidth, 0);
				heading = this.headingLines(innerWidth, 0, 0);
				// Markdown 行自带主题样式（defaultTextStyle 已套 thinking 色），不再外套；
				// 裸文本路径保持外套 thinking 样式。
				bodyLines = body.markdown ? body.lines : body.lines.map((line) => this.style(line));
				tailHint = body.tailHint;
			}
			const inner = tailHint
				? [...heading, this.paint("dim", tailHint), ...bodyLines]
				: bodyLines.length
					? [...heading, ...bodyLines]
					: heading;
			const bgFn =
				this.theme && typeof this.theme.bg === "function"
					? (text: string) => this.theme!.bg(TOOL_CARD_BG_SLOT.success, text)
					: undefined;
			const box = new Box(1, 1, bgFn);
			box.addChild({
				render: () => inner,
				invalidate() {},
			});
			return box.render(width);
		}

		const expandAction = thinkingExpandAction();
		const summaryMode = this.summaryLines !== undefined;
		const headingText = this.headingProvider?.() ?? this.heading;
		const summaryBody = summaryMode ? this.summaryBodyLines(width, this.padding, false) : undefined;
		const rawBody = summaryMode ? undefined : this.bodyLines(width, this.padding);
		const bodyLines = summaryBody?.lines ?? rawBody?.lines ?? [];
		const hiddenCount = summaryBody?.hidden ?? rawBody?.hiddenLines ?? 0;
		const summaryKey = summaryMode ? bodyLines.join("\n") : "";
		if (
			this.collapsedMemo?.width === width &&
			this.collapsedMemo.previewLines === config.previewLines &&
			this.collapsedMemo.hintHovered === this.hintHovered &&
			this.collapsedMemo.expandAction === expandAction &&
			this.collapsedMemo.followTail === this.followTail &&
			this.collapsedMemo.heading === headingText &&
			this.collapsedMemo.summaryKey === summaryKey &&
			this.collapsedMemo.summaryMode === summaryMode
		) {
			return this.collapsedMemo.lines;
		}

		const heading = this.headingLines(
			width,
			hiddenCount,
			this.padding,
			summaryMode ? "summary" : "line",
			headingText,
		);
		const lines = bodyLines.length
			? [
					...heading,
					...bodyLines.map((line) => padPreviewLine(this.style(line), width, this.padding)),
				]
			: heading;
		this.collapsedMemo = {
			width,
			previewLines: config.previewLines,
			hintHovered: this.hintHovered,
			expandAction,
			followTail: this.followTail,
			heading: headingText,
			summaryKey,
			summaryMode,
			lines,
		};
		return lines;
	}

	invalidate() {
		this.collapsedMemo = undefined;
	}
}

function parseSummaryPart(text: string): SummaryPart | undefined {
	const match = /^\s*\*\*([^\n]+?)\*\*[ \t]*(?:\r?\n(?:\r?\n)?([\s\S]*))?\s*$/.exec(text);
	if (!match) return undefined;
	return { title: match[1].trim(), body: (match[2] ?? "").trim() };
}

/**
 * 完成态严格标题校验（opencode 式）：`**title**` 后须为双换行或结尾，
 * 否则视为正文加粗误命中。流式启发式保持宽松以便即时换标题。
 */
function parseStrictSummaryPart(text: string): SummaryPart | undefined {
	const match = /^\s*\*\*([^\n*]+?)\*\*[ \t]*(?:\r?\n\r?\n|\s*$)([\s\S]*?)\s*$/.exec(text);
	if (!match) return undefined;
	const title = match[1].trim();
	if (!title) return undefined;
	return { title, body: (match[2] ?? "").trim() };
}

/** 丢弃纯省略号噪音行（Gemini/Kimi 同款），避免占位预览窗口；保留空行分段。 */
function stripNoiseLines(text: string): string {
	return text
		.split(/\r\n|\r|\n/)
		.filter((line) => !/^\s*\.+\s*$/.test(line))
		.join("\n")
		.trim();
}

function parseLatestStreamingSummary(text: string): SummaryPart | undefined {
	// Providers do not consistently insert a blank line between streamed
	// summary parts, so accept a bold title at the start of any source line.
	const titlePattern = /(?:^|\r?\n)\s*\*\*([^\n*]+?)\*\*[ \t]*(?:\r?\n)?/g;
	let latest: RegExpExecArray | undefined;
	let match: RegExpExecArray | null = titlePattern.exec(text);
	while (match !== null) {
		latest = match;
		match = titlePattern.exec(text);
	}
	if (!latest) return parseSummaryPart(text);

	return {
		title: latest[1].trim(),
		body: text.slice(latest.index + latest[0].length).trim(),
	};
}

/** 脱敏占位：渲染前剥离；空壳回退中性标题且不给展开。 */
function isOpenAiResponsesMessage(message: AssistantMessage) {
	return (
		message.api === "openai-responses" ||
		message.api === "openai-codex-responses" ||
		message.api === "azure-openai-responses"
	);
}

function getLatestOpenAiSummary(thinkingSignature: string | undefined): SummaryPart | undefined {
	if (!thinkingSignature) return undefined;

	try {
		const item = JSON.parse(thinkingSignature) as {
			type?: unknown;
			summary?: Array<{ type?: unknown; text?: unknown }>;
		};
		if (item.type !== "reasoning" || !Array.isArray(item.summary)) {
			return undefined;
		}

		for (let i = item.summary.length - 1; i >= 0; i--) {
			const part = item.summary[i];
			if (part.type !== "summary_text" || typeof part.text !== "string") {
				continue;
			}
			const parsed = parseSummaryPart(part.text);
			if (parsed) return parsed;
		}
	} catch {
		// Invalid or provider-specific signatures use the generic fallback.
	}
	return undefined;
}

const WIDGET_ID = "compact-thinking-render-loop";

/** Thinking 标题徽标：与 spinner 字形帧 / `✻ Turn took` 行同字（U+273B），项目内保持一致。 */
const THINKING_BADGE = "✻ ";
/** 时长展示下限：亚秒思考不缀时长（Crush 0s 抑制同理），只留中性标题。 */
const THINKING_DURATION_MIN_MS = 1000;

// 上游 index.ts 内联（含 subagent fork patch）。
function createTransform(
	messageType: "assistant" | "assistant-thinking",
	self: AssistantInternals,
) {
	// 与 pi 内置 applyMarkdownTransformers 相同的链式语义：
	// 异常保留当前 markdown，继续下一个 transformer。
	return (markdown: string, availableWidth: number): string => {
		let out = markdown;
		for (const transformer of self.markdownTransformers ?? []) {
			try {
				const result = transformer(out, {
					messageType,
					isStreaming: self.isStreaming,
					availableWidth,
				});
				if (typeof result === "string") out = result;
			} catch {
				// 保持当前 markdown 继续
			}
		}
		return out;
	};
}

function compactThinking(pi: ExtensionAPI) {
	const prototype = AssistantMessageComponent.prototype as PatchedPrototype;
	const originalUpdateContent = prototype.updateContent;

	activeThinkingStateQuery = (messageTimestamp) =>
		activeThinking?.messageTimestamp === messageTimestamp;
	activeThinkingAnimationFrameQuery = () => animationFrame;
	activeThinkingQuery = (messageTimestamp) => {
		let total = 0;
		const durations = completedDurations.get(messageTimestamp);
		if (durations) {
			for (const duration of durations.values()) total += duration;
		}
		if (activeThinking?.messageTimestamp === messageTimestamp) {
			total += Math.max(1, Date.now() - activeThinking.startedAt);
		}
		return total > 0 ? total : undefined;
	};

	const completedDurations = new Map<number, Map<number, number>>();
	const streamingComponents = new Set<AssistantMessageComponentLike>();
	let activeThinking: ActiveThinking | undefined;
	let activeTheme: Theme | undefined;
	let activeTui: RenderTui | undefined;
	let latestComponent: AssistantMessageComponentLike | undefined;
	let latestComponentTimestamp: number | undefined;
	let animationTimer: ReturnType<typeof setInterval> | undefined;
	let animationFrame = 0;
	let compactSummaryActive = false;
	let patchInstalled = true;
	let lastThinkingDeltaAt = 0;
	const thinkingSummaryStreams = new Map<string, ThinkingSummaryStream>();

	function thinkingStyle(text: string) {
		return styleCompactThinkingText(text, activeTheme);
	}

	/** 活动标题走与 compact 摘要相同的扫光；设置关闭时保持旧的静态 dim。 */
	function activeThinkingStyle(text: string) {
		if (config.thinkingLiveSummary === false) return thinkingStyle(text);
		return animateCompactThinkingText(text, activeTheme, animationFrame);
	}

	/** 活动标题 + 时长在 render 时现算，timer 只 requestRender 也能继续走秒。 */
	function activeThinkingHeading(title: string): string {
		const elapsed = activeThinking ? Math.max(1, Date.now() - activeThinking.startedAt) : undefined;
		const durationText =
			elapsed !== undefined && elapsed >= THINKING_DURATION_MIN_MS
				? formatThoughtDuration(elapsed)
				: undefined;
		return (
			activeThinkingStyle(`${THINKING_BADGE}${title}`) +
			(durationText ? thinkingStyle(` · ${durationText}`) : "")
		);
	}

	function getCompletedDuration(messageTimestamp: number, startIndex: number, endIndex: number) {
		const durations = completedDurations.get(messageTimestamp);
		if (!durations) return undefined;
		for (let index = endIndex; index >= startIndex; index--) {
			const duration = durations.get(index);
			if (duration !== undefined) return duration;
		}
		return undefined;
	}

	function isActiveRun(message: AssistantMessage, startIndex: number, endIndex: number) {
		return (
			activeThinking?.messageTimestamp === message.timestamp &&
			activeThinking.contentIndex >= startIndex &&
			activeThinking.contentIndex <= endIndex
		);
	}

	/**
	 * 按 run 维护摘要流：只有已收口的块才生成摘要，避免每个 token 都改文案。
	 * 具体切块/provider 标题/空闲收块在 ThinkingSummaryStream 里，可注入时钟单测。
	 */
	function getThinkingSummaryState(
		messageTimestamp: number,
		runStartIndex: number,
		text: string,
		active: boolean,
		providerTitleInHeading = false,
	): string[] | undefined {
		if (config.thinkingLiveSummary === false) return undefined;
		const key = thinkingKey(messageTimestamp, runStartIndex);
		let stream = thinkingSummaryStreams.get(key);
		if (!stream) {
			stream = new ThinkingSummaryStream({
				liveSummary: true,
				useProviderTitles: config.useSummaryTitlesAsThinkingTitle !== false,
			});
			thinkingSummaryStreams.set(key, stream);
		}
		stream.setUseProviderTitles(config.useSummaryTitlesAsThinkingTitle !== false);
		const summaries = stream.update(text, {
			active,
			now: Date.now(),
			lastDeltaAt: lastThinkingDeltaAt,
			providerTitleInHeading,
		});

		// Bound the map for very long sessions; completed old runs are cheap to rebuild.
		if (thinkingSummaryStreams.size > 512 && thinkingSummaryStreams.keys().next().value !== key) {
			const oldest = thinkingSummaryStreams.keys().next().value;
			if (oldest !== undefined) thinkingSummaryStreams.delete(oldest);
		}
		return summaries;
	}

	prototype.updateContent = function patchedUpdateContent(
		message: AssistantMessage,
		isStreaming?: boolean,
	) {
		const component = this as AssistantMessageComponentLike;
		const self = this as unknown as AssistantInternals;
		// isStreaming 丢失 → mermaid 流式误渲染来回闪。
		self.isStreaming = isStreaming ?? self.isStreaming;
		self.lastMessage = message;
		latestComponent = component;
		latestComponentTimestamp = message.timestamp;

		// Visible mode is intentionally untouched: Shift+Tab restores Pi's exact
		// built-in Thinking Markdown renderer, including every OpenAI summary stage.
		if (!self.hideThinkingBlock) {
			originalUpdateContent.call(this, message, self.isStreaming);
			return;
		}

		if (activeThinking?.messageTimestamp === message.timestamp) {
			streamingComponents.add(component);
		}

		self.contentContainer.clear();
		const hasActiveThinking =
			activeThinking?.messageTimestamp === message.timestamp &&
			message.content.some((content) => content.type === "thinking");
		const hasVisibleContent =
			hasActiveThinking ||
			message.content.some(
				(content) =>
					(content.type === "text" && content.text.trim()) ||
					(content.type === "thinking" && content.thinking.trim()),
			);
		// Reserve Pi's normal leading spacer even before the first thinking token.
		// This prevents the placeholder heading from jumping down one row when
		// summary/body content begins streaming.
		if (hasVisibleContent) self.contentContainer.addChild(new Spacer(1));

		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];

			if (content.type === "text" && content.text.trim()) {
				self.contentContainer.addChild(
					new Markdown(content.text.trim(), self.outputPad, 0, self.markdownTheme, undefined, {
						transform: createTransform("assistant", self),
					}),
				);
				continue;
			}

			if (content.type !== "thinking") continue;

			const runStartIndex = i;
			const hasVisibleContentBefore = message.content
				.slice(0, runStartIndex)
				.some(
					(previous) =>
						(previous.type === "text" && previous.text.trim()) ||
						(previous.type === "thinking" && previous.thinking.trim()),
				);
			const thinkingBlocks: string[] = [];
			let latestSummary: SummaryPart | undefined;
			let latestSummaryFromSignature = false;
			for (; i < message.content.length; i++) {
				const thinkingContent = message.content[i];
				if (thinkingContent.type !== "thinking") break;
				const thinking = thinkingContent.thinking.trim();
				if (!thinking) continue;
				thinkingBlocks.push(thinking);

				if (config.useSummaryTitlesAsThinkingTitle && isOpenAiResponsesMessage(message)) {
					const contentIsActive =
						activeThinking?.messageTimestamp === message.timestamp &&
						activeThinking.contentIndex === i;
					// During streaming, thinkingSignature may contain only the previously
					// completed summary parts. Prefer the live text so a newly arriving
					// title immediately replaces the old one instead of appearing in its
					// preview body. Once complete, the structured signature is canonical.
					if (contentIsActive) {
						const streamed = parseLatestStreamingSummary(thinking);
						if (streamed !== undefined) {
							latestSummary = streamed;
						} else {
							const structured = getLatestOpenAiSummary(thinkingContent.thinkingSignature);
							if (structured !== undefined) {
								latestSummary = structured;
								latestSummaryFromSignature = true;
							}
						}
					} else {
						const structured = getLatestOpenAiSummary(thinkingContent.thinkingSignature);
						if (structured !== undefined) {
							latestSummary = structured;
							latestSummaryFromSignature = true;
						} else {
							const streamed = parseLatestStreamingSummary(thinking);
							if (streamed !== undefined) latestSummary = streamed;
						}
					}
				}
			}
			const runEndIndex = i - 1;
			i--;
			const active = isActiveRun(message, runStartIndex, runEndIndex);
			// OpenAI can spend several seconds reasoning before it emits the first
			// summary token. Keep an empty active block visible as animated
			// "Thinking..." during that otherwise silent interval.
			if (thinkingBlocks.length === 0 && !active) continue;
			if (hasVisibleContentBefore) {
				self.contentContainer.addChild(new Spacer(1));
			}

			const elapsedMs = activeThinking
				? Math.max(1, Date.now() - activeThinking.startedAt)
				: undefined;
			const completedMs = getCompletedDuration(message.timestamp, runStartIndex, runEndIndex);
			const durationMs = active ? elapsedMs : completedMs;
			// P0-1：亚秒思考不缀时长，只留中性标题。
			const durationText =
				durationMs !== undefined && durationMs >= THINKING_DURATION_MIN_MS
					? formatThoughtDuration(durationMs)
					: undefined;
			const fullText = thinkingBlocks.join("\n\n");
			// 非签名标题走严格校验（P0-4）；同时给非 OpenAI 消息补标题能力。
			// 开关关闭时不取标题（尊重 useSummaryTitlesAsThinkingTitle=false）。
			// P0-2/P0-3：组装前剥离脱敏标记与噪音行。
			const strictSummary =
				latestSummaryFromSignature || !config.useSummaryTitlesAsThinkingTitle
					? undefined
					: parseStrictSummaryPart(fullText);
			const rawBody = stripNoiseLines(
				(latestSummary?.body ?? strictSummary?.body ?? fullText).replace(THINKING_REDACTED_RE, ""),
			);

			let heading: string;
			let headingProvider: (() => string) | undefined;
			// 活动态用扫光标题 + 段落驱动的摘要列表；完成态保持静态 Thought for Xs。
			// 活动标题在 render 时现算，动画 timer 不必每帧重建整棵 content。
			if (active && latestSummary) {
				const title = latestSummary.title;
				headingProvider = () => activeThinkingHeading(title);
				heading = headingProvider();
			} else if (active) {
				const label = self.hiddenThinkingLabel || "Thinking...";
				// 默认文案用 CC 式单字符省略号；自定义 hiddenThinkingLabel 原样保留只加徽标。
				const displayLabel = label === "Thinking..." ? "Thinking…" : label;
				headingProvider = () => activeThinkingHeading(displayLabel);
				heading = headingProvider();
			} else {
				// Completed compact blocks use one provider-independent status line.
				// 无时长记录（中断流/旧会话/entry 缺失或索引错位）时不回退到加载文案
				// "Thinking..."：有确切时长用 Thought for Xs，否则用严格校验过的标题或中性 "Thought"。
				// 摘要列表开启时完成态固定用 Thought，避免 heading 与列表标题重复。
				const summaryMode = config.thinkingLiveSummary !== false;
				const completedTitle =
					durationText !== undefined
						? `Thought for ${durationText}`
						: summaryMode
							? "Thought"
							: ((latestSummaryFromSignature ? latestSummary?.title : undefined) ??
								strictSummary?.title ??
								"Thought");
				heading = thinkingStyle(`${THINKING_BADGE}${completedTitle}`);
			}
			const previewSource = rawBody;
			const summaryLines = getThinkingSummaryState(
				message.timestamp,
				runStartIndex,
				fullText,
				active,
				active && latestSummary !== undefined,
			);
			self.contentContainer.addChild(
				new ThinkingPreviewBlock(
					heading,
					previewSource,
					self.outputPad,
					message.timestamp,
					thinkingStyle,
					activeTheme,
					runStartIndex,
					// 活动态追随尾部（随新内容滚动），收尾后固定头部。
					active,
					self.markdownTheme,
					createTransform("assistant-thinking", self),
					summaryLines,
					config.showRawThinking === true,
					headingProvider,
				),
			);

			const hasVisibleContentAfter = message.content
				.slice(i + 1)
				.some(
					(next) =>
						(next.type === "text" && next.text.trim()) ||
						(next.type === "thinking" && next.thinking.trim()),
				);
			if (hasVisibleContentAfter) self.contentContainer.addChild(new Spacer(1));
		}

		const hasToolCalls = message.content.some((content) => content.type === "toolCall");
		self.hasToolCalls = hasToolCalls;

		if (message.stopReason === "length") {
			self.contentContainer.addChild(new Spacer(1));
			self.contentContainer.addChild(
				new Text(
					activeTheme
						? activeTheme.fg(
								"error",
								"Error: Model stopped because it reached the maximum output token limit. The response may be incomplete.",
							)
						: "Error: Model stopped because it reached the maximum output token limit. The response may be incomplete.",
					self.outputPad,
					0,
				),
			);
		} else if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				self.contentContainer.addChild(new Spacer(1));
				self.contentContainer.addChild(
					new Text(
						activeTheme ? activeTheme.fg("error", abortMessage) : abortMessage,
						self.outputPad,
						0,
					),
				);
			} else if (message.stopReason === "error") {
				const errorMessage = message.errorMessage || "Unknown error";
				self.contentContainer.addChild(new Spacer(1));
				self.contentContainer.addChild(
					new Text(
						activeTheme
							? activeTheme.fg("error", `Error: ${errorMessage}`)
							: `Error: ${errorMessage}`,
						self.outputPad,
						0,
					),
				);
			}
		}
	};
	const installedUpdateContent = prototype.updateContent;
	(installedUpdateContent as any)[COMPACT_THINKING_PATCH_KEY] = true;

	function ensureAnimationTimer() {
		if (animationTimer) return;
		animationTimer = setInterval(() => {
			animationFrame++;
			// 标题/时长在 ThinkingPreviewBlock.render 里现算，动画帧只 requestRender。
			// 每 4 帧才重建一次 content tree，主要用于摘要收块和空闲检测；
			// 新 token 仍会由 message_update 立即触发 updateContent。
			if (animationFrame % 4 === 1) {
				for (const component of streamingComponents) {
					const self = component as unknown as AssistantInternals;
					if (self.lastMessage) self.updateContent(self.lastMessage);
				}
			}
			activeTui?.requestRender();
		}, config.animationIntervalMs);
	}

	function stopAnimationTimerIfIdle() {
		if (activeThinking || compactSummaryActive || !animationTimer) return;
		clearInterval(animationTimer);
		animationTimer = undefined;
	}

	activeCompactSummarySetter = (active) => {
		compactSummaryActive = active;
		if (active) ensureAnimationTimer();
		else stopAnimationTimerIfIdle();
		activeTui?.requestRender();
	};

	function startThinking(message: AssistantMessage, contentIndex: number) {
		activeThinking = {
			messageTimestamp: message.timestamp,
			contentIndex,
			startedAt: Date.now(),
		};
		lastThinkingDeltaAt = Date.now();
		thinkingSummaryStreams.delete(thinkingKey(message.timestamp, contentIndex));
		streamingComponents.clear();
		animationFrame = 0;

		// Depending on event-listener order, Pi may have rendered the empty
		// thinking_start partial just before this extension receives the event.
		// Re-render that component immediately so users do not wait for the first
		// summary delta before seeing the animation.
		if (latestComponent && latestComponentTimestamp === message.timestamp) {
			streamingComponents.add(latestComponent);
			const self = latestComponent as unknown as AssistantInternals;
			self.updateContent(message);
			activeTui?.requestRender();
		}

		if (animationTimer) clearInterval(animationTimer);
		animationTimer = undefined;
		ensureAnimationTimer();
	}

	function finishThinking() {
		if (!activeThinking) return;
		const finished = activeThinking;
		const summaryStream = thinkingSummaryStreams.get(
			thinkingKey(finished.messageTimestamp, finished.contentIndex),
		);
		summaryStream?.close(Date.now());
		const durationMs = Math.max(1, Date.now() - finished.startedAt);
		let durations = completedDurations.get(finished.messageTimestamp);
		if (!durations) {
			durations = new Map();
			completedDurations.set(finished.messageTimestamp, durations);
		}
		durations.set(finished.contentIndex, durationMs);
		pi.appendEntry(DURATION_ENTRY_TYPE, {
			messageTimestamp: finished.messageTimestamp,
			contentIndex: finished.contentIndex,
			durationMs,
		} as DurationEntryData);

		activeThinking = undefined;
		stopAnimationTimerIfIdle();

		const components = [...streamingComponents];
		streamingComponents.clear();
		for (const component of components) {
			const self = component as unknown as AssistantInternals;
			if (self.lastMessage) self.updateContent(self.lastMessage);
		}
		activeTui?.requestRender();
	}

	// ---- fork patch：subagent 工具执行期间保持思考动画 ----

	// Subagent tools can run for minutes: keep the thinking loading animation
	// alive for the whole execution and only finalize once the tool ends or the
	// model emits the next text/thinking boundary.
	function resumeAgentThinking(message: AssistantMessage | undefined) {
		if (activeThinking) return;
		const content = message?.content;
		if (!Array.isArray(content)) return;
		const index = content.findIndex((item) => item?.type === "thinking");
		if (index < 0) return;
		startThinking(message as AssistantMessage, index);
	}

	function messageHasAgentTool(message: AssistantMessage | undefined) {
		return (
			Array.isArray(message?.content) &&
			message.content.some(
				(content) =>
					content?.type === "toolCall" &&
					(content.name === "Agent" ||
						content.name === "Agents" ||
						content.arguments?.subagent_type != null),
			)
		);
	}

	pi.on("message_update", (event) => {
		if (event.message.role !== "assistant") return;
		const update = event.assistantMessageEvent;

		if (update.type === "thinking_start") {
			lastThinkingDeltaAt = Date.now();
			if (activeThinking?.messageTimestamp === event.message.timestamp) {
				// Some Responses-compatible providers emit a fresh thinking_start for
				// each summary/reasoning item even though no text or tool boundary has
				// ended the visible Thinking run. Follow the new content block without
				// resetting the run's original start time.
				activeThinking.contentIndex = update.contentIndex;
			} else {
				if (activeThinking) finishThinking();
				startThinking(event.message, update.contentIndex);
			}
		} else if (update.type === "thinking_delta") {
			lastThinkingDeltaAt = Date.now();
			if (!activeThinking) {
				startThinking(event.message, update.contentIndex);
			} else if (activeThinking.messageTimestamp === event.message.timestamp) {
				activeThinking.contentIndex = update.contentIndex;
			}
		} else if (update.type === "text_start") {
			finishThinking();
		} else if (update.type === "toolcall_start" || update.type === "toolcall_delta") {
			if (messageHasAgentTool(event.message)) {
				resumeAgentThinking(event.message);
			} else {
				finishThinking();
			}
		}
		// Do not finalize on thinking_end alone. OpenAI Responses providers can
		// close one reasoning item and immediately open another for the next
		// summary while Pi still renders both as one contiguous Thinking run.
		// A text/tool transition or message_end is the actual visible boundary.
	});

	// OpenAI-compatible providers may not close reasoning until the response ends.
	pi.on("tool_execution_start", (event: any) => {
		if (event.toolName === "Agent" || event.toolName === "Agents") {
			const lastMessage = (latestComponent as unknown as { lastMessage?: AssistantMessage })
				?.lastMessage;
			resumeAgentThinking(lastMessage);
		} else {
			finishThinking();
		}
	});
	pi.on("tool_execution_end", (event: any) => {
		if (event.toolName === "Agent" || event.toolName === "Agents") finishThinking();
	});
	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		// Agent tool runs after message_end; keep the ticker until tool_execution_end
		// or the next text/thinking boundary.
		if (messageHasAgentTool(event.message)) return;
		finishThinking();
	});

	pi.on("session_start", (_event, ctx) => {
		restoreDurationEntries(ctx.sessionManager.getBranch(), completedDurations);
		thinkingSummaryStreams.clear();
		lastThinkingDeltaAt = 0;
		activeTheme = ctx.ui.theme;
		if (ctx.mode !== "tui") return;

		// An empty widget gives the animation loop access to requestRender without
		// enabling terminal mouse reporting or intercepting native scrollback input.
		// setWidget 的 factory 同步执行，此刻补丁已安装。
		ctx.ui.setWidget(WIDGET_ID, (tui) => {
			activeTui = tui;
			return { render: () => [], invalidate() {} };
		});

		// pi 在 reload/resume 时先于 session_start 用原始原型重建聊天组件
		// （rebuildChatFromMessages / renderCurrentSessionState）。由共享的
		// refreshMountedTranscript 扫描挂载树重绘这些组件，恢复 compact 渲染、
		// 持久化时长与工具调用显示。
		refreshMountedTranscript(activeTui);
		activeTui?.requestRender(true);
	});

	pi.on("session_tree", (_event, ctx) => {
		restoreDurationEntries(ctx.sessionManager.getBranch(), completedDurations);
		thinkingSummaryStreams.clear();
		lastThinkingDeltaAt = 0;
		refreshMountedTranscript(activeTui);
		activeTui?.requestRender(true);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		finishThinking();
		activeThinkingQuery = undefined;
		activeThinkingStateQuery = undefined;
		activeThinkingAnimationFrameQuery = undefined;
		activeCompactSummarySetter = undefined;
		compactSummaryActive = false;
		if (animationTimer) clearInterval(animationTimer);
		animationTimer = undefined;
		activeTui = undefined;
		activeTheme = undefined;
		latestComponent = undefined;
		latestComponentTimestamp = undefined;
		completedDurations.clear();
		thinkingSummaryStreams.clear();
		lastThinkingDeltaAt = 0;
		streamingComponents.clear();
		expandedThinking.clear();
		fullExpandedThinking.clear();
		clearThinkingPreviewCache();
		if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_ID, undefined);

		if (patchInstalled) {
			if (prototype.updateContent === installedUpdateContent) {
				const wrappedOriginal = (originalUpdateContent as any)[PROTOTYPE_ORIGINAL_KEY];
				prototype.updateContent =
					typeof wrappedOriginal === "function" ? wrappedOriginal : originalUpdateContent;
			}
			patchInstalled = false;
		}
	});
}

type CompactThinkingOwner = {
	owner: object;
	stop(event?: any, ctx?: any): void;
};

type UpstreamHandler = (event: any, ctx: any) => void;

export function installCompactThinking(
	pi: ExtensionAPI,
	initialConfig: CompactThinkingConfig,
): CompactThinkingController {
	const owner = {};
	let session: { event: any; ctx: any } | undefined;
	let active = false;
	// Stable pi.on wrappers delegate here so activate/reload never double-binds.
	const delegates = new Map<string, UpstreamHandler>();
	const boundEvents = new Set<string>();

	const restoreAllDurations = (ctx: any): any => {
		const sessionManager = ctx?.sessionManager;
		if (!sessionManager || typeof sessionManager.getEntries !== "function") return ctx;
		return {
			...ctx,
			sessionManager: {
				...sessionManager,
				getBranch: () => sessionManager.getEntries(),
			},
		};
	};

	const bind = (eventName: string) => {
		if (boundEvents.has(eventName)) return;
		boundEvents.add(eventName);
		pi.on(eventName as any, (e: any, ctx: any) => {
			if (!active) return;
			const handler = delegates.get(eventName);
			if (!handler) return;
			handler(e, eventName === "session_tree" ? restoreAllDurations(ctx) : ctx);
		});
	};

	const stop = (event?: any, ctx?: any) => {
		if (!active) return;
		active = false;
		const shutdown = delegates.get("session_shutdown");
		delegates.clear();
		shutdown?.(event ?? session?.event ?? {}, ctx ?? session?.ctx ?? { mode: "rpc", ui: {} });
		if (patchRegistry.get<CompactThinkingOwner>(COMPACT_THINKING_OWNER)?.owner === owner)
			patchRegistry.delete(COMPACT_THINKING_OWNER);
	};

	const activate = (event: any, ctx: any) => {
		// Headless subagent runtimes share this process. Never steal the parent
		// TUI prototype patch or kill its thinking ticker.
		if (ctx?.mode !== "tui") return;

		patchRegistry.get<CompactThinkingOwner>(COMPACT_THINKING_OWNER)?.stop(event, ctx);
		session = { event, ctx };

		// 配置统一由 claude-code-style 管控，加载时覆盖库默认值。
		// 先重置库默认值，避免测试/子运行时继承上一个 session 的开关。
		Object.assign(config, COMPACT_THINKING_DEFAULTS, initialConfig);
		delegates.clear();

		compactThinking({
			on(eventName: string, handler: UpstreamHandler) {
				if (eventName === "session_start") {
					// Already inside session_start — run immediately.
					handler(event, restoreAllDurations(ctx));
					return;
				}
				if (eventName === "session_shutdown") {
					delegates.set(eventName, handler);
					return;
				}
				delegates.set(eventName, handler);
				bind(eventName);
			},
			appendEntry: (...args: any[]) => (pi.appendEntry as any)(...args),
		} as unknown as ExtensionAPI);

		active = true;
		patchRegistry.install(COMPACT_THINKING_OWNER, { owner, stop });
	};

	pi.on("session_start", (event, ctx) => {
		session = { event, ctx };
		activate(event, ctx);
	});
	pi.on("session_shutdown", (event, ctx) => {
		if (patchRegistry.get<CompactThinkingOwner>(COMPACT_THINKING_OWNER)?.owner === owner)
			stop(event, ctx);
		session = undefined;
	});

	return {
		updateConfig(next) {
			Object.assign(initialConfig, next);
			Object.assign(config, next);
		},
		getMessageThinkingDurationMs(messageTimestamp) {
			return activeThinkingQuery?.(messageTimestamp);
		},
		isMessageThinkingActive(messageTimestamp) {
			return activeThinkingStateQuery?.(messageTimestamp) ?? false;
		},
		getThinkingAnimationFrame() {
			return activeThinkingAnimationFrameQuery?.() ?? 0;
		},
		setCompactSummaryActive(active) {
			activeCompactSummarySetter?.(active);
		},
	};
}
