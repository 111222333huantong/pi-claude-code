/**
 * 助手正文打点段落：每段首个非空文本行前缀 ` ● `，续行/空行补 3 空格对齐。
 *
 * 移植自 cc-my-pi `assistant-paragraphs.ts` 的 DottedParagraph（MIT），仅取
 * 打点呈现部分：数学切段、Thinking 段、拷贝安全链接均不搬（本包数学走 Pi
 * 原生透传，thinking 走 compact-thinking 体系）。
 *
 * 挂载在 compact-mode 之外层包裹 AssistantMessageComponent.updateContent：
 * 原生重建子节点后，把非斜体 Markdown 文本块换成 DottedParagraph。
 * mode=off 时反向还原；compact 摘要行非 Markdown 子节点，不受影响。
 */
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { config } from "../config/config.ts";
import {
	ASSISTANT_DOTTED_PATCH,
	PROTOTYPE_ORIGINAL_KEY,
	patchRegistry,
} from "../utils/patch-keys.ts";
import { hasVisibleText, stripAnsi } from "../utils/ansi-text.ts";
import { walkComponentTree } from "../utils/component-tree.ts";

type MarkdownThemeLike = ConstructorParameters<typeof Markdown>[3];
type MarkdownTransformOption = NonNullable<ConstructorParameters<typeof Markdown>[5]>["transform"];

/** 圆点前缀占 3 可见列，续行缩进与之对齐。 */
export const DOTTED_PREFIX = " ● ";
export const DOTTED_INDENT = "   ";

/** 列表符归一 `-`：保留主题原有着色，只换首个可见标记字形。 */
function dashListBullet(marker: string, fallback?: (marker: string) => string): string {
	try {
		const rendered = fallback ? fallback(marker) : marker;
		return rendered.replace(/^((?:\x1b\[[0-9;]*m|\s)*)[-*+]/u, "$1-");
	} catch {
		return marker.replace(/^[*+]/, "-");
	}
}

/** 剥 ANSI 后取首个可见字符，判断代码框框线（code-block.ts 圆角套框产物）。 */
function firstVisibleChar(line: string): string {
	const plain = stripAnsi(line).trimStart();
	return plain.charAt(0);
}

function isBoxTopLine(line: string): boolean {
	return firstVisibleChar(line) === "╭";
}

function isBoxChromeLine(line: string): boolean {
	const char = firstVisibleChar(line);
	return char === "╭" || char === "│" || char === "╰";
}

export class DottedParagraph {
	private readonly sourceText: string;
	private readonly sourceTheme: MarkdownThemeLike;
	private readonly sourceTransform?: MarkdownTransformOption;
	private readonly inner: InstanceType<typeof Markdown>;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(text: string, markdownTheme: MarkdownThemeLike, transform?: MarkdownTransformOption) {
		this.sourceText = text;
		this.sourceTheme = markdownTheme;
		this.sourceTransform = transform;
		const listBullet = markdownTheme?.listBullet;
		const theme = markdownTheme
			? { ...markdownTheme, listBullet: (marker: string) => dashListBullet(marker, listBullet) }
			: markdownTheme;
		this.inner = new Markdown(text, 0, 0, theme, undefined, transform ? { transform } : undefined);
	}

	/**
	 * 相同输入重建结果一致：调用方复用实例 + invalidate，
	 * 跳过 Markdown 重建（与 cc-my-pi 同语义）。
	 */
	matches(
		text: string,
		markdownTheme: MarkdownThemeLike,
		transform?: MarkdownTransformOption,
	): boolean {
		return (
			this.sourceText === text &&
			this.sourceTheme === markdownTheme &&
			this.sourceTransform === transform
		);
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.inner.invalidate?.();
	}

	/** 还原为原生 Markdown 子节点（mode=off 时用）。 */
	toMarkdown(): InstanceType<typeof Markdown> {
		return new Markdown(
			this.sourceText,
			0,
			0,
			this.sourceTheme,
			undefined,
			this.sourceTransform ? { transform: this.sourceTransform } : undefined,
		);
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
		if (safeWidth <= DOTTED_PREFIX.length) {
			this.cachedWidth = width;
			this.cachedLines = [truncateToWidth(DOTTED_PREFIX.trim(), safeWidth)];
			return this.cachedLines;
		}
		const contentWidth = safeWidth - DOTTED_PREFIX.length;
		const lines = this.inner.render(contentWidth);
		// 纯代码段落：首个有意义行是 ╭ 框顶，点打在段首；
		// 否则点留在首个非框线文本行，代码框不打点。
		const firstMeaningful = lines.find((line) => hasVisibleText(line));
		const isPureCodeBlock = !!firstMeaningful && isBoxTopLine(firstMeaningful);
		let dotPlaced = false;
		const rendered = lines.map((line) => {
			if (!hasVisibleText(line)) return `${DOTTED_INDENT}${line}`;
			if (isPureCodeBlock && isBoxTopLine(line) && !dotPlaced) {
				dotPlaced = true;
				return `${DOTTED_PREFIX}${line}`;
			}
			if (isBoxChromeLine(line)) return `${DOTTED_INDENT}${line}`;
			if (!dotPlaced) {
				dotPlaced = true;
				return `${DOTTED_PREFIX}${line}`;
			}
			return `${DOTTED_INDENT}${line}`;
		});
		const output = rendered.map((line) =>
			visibleWidth(line) > safeWidth ? truncateToWidth(line, safeWidth, "", false) : line,
		);
		this.cachedWidth = width;
		this.cachedLines = output;
		return output;
	}
}

export function isDottedParagraph(value: any): value is DottedParagraph {
	return value instanceof DottedParagraph;
}

/**
 * Markdown 文本块判定：pi-coding-agent 内嵌了自有 pi-tui 副本，其组件产出
 * 的 Markdown 与顶层 import 不是同一个类，`instanceof` 永假。改用构造器名
 * 兼容双实例；Text/Spacer 等构造器名不同，不会误伤。
 */
function isMarkdownTextBlock(child: any): boolean {
	if (!child || typeof child !== "object") return false;
	if (child instanceof Markdown) return true;
	try {
		return child.constructor?.name === "Markdown";
	} catch {
		return false;
	}
}

/** 单个组件内的 Markdown 文本块 ↔ DottedParagraph 双向同步（按当前 mode）。 */
function resyncAssistantComponent(component: any): void {
	const container = component?.contentContainer;
	if (!container || !Array.isArray(container.children)) return;
	const hostTheme = component?.markdownTheme;
	if (config.mode === "off") {
		for (let i = 0; i < container.children.length; i++) {
			const child = container.children[i];
			if (isDottedParagraph(child)) {
				try {
					container.children[i] = child.toMarkdown();
				} catch {
					// 还原失败保留打点行，下次 render 再试
				}
			}
		}
		return;
	}
	if (!hostTheme) return;
	for (let i = container.children.length - 1; i >= 0; i--) {
		const child = container.children[i];
		if (isDottedParagraph(child)) {
			child.invalidate();
			continue;
		}
		if (!isMarkdownTextBlock(child)) continue;
		const text = (child as any).text;
		if (typeof text !== "string" || !text) continue;
		// 斜体 Markdown = thinking 块：保持 Pi 原生，不打点。
		if ((child as any).defaultTextStyle?.italic) continue;
		const transform = (child as any).options?.transform;
		// 主题优先组件级，回退子节点自带（Pi 版本差异兜底）。
		const mdTheme = hostTheme ?? (child as any).theme;
		if (!mdTheme) continue;
		try {
			container.children[i] = new DottedParagraph(text, mdTheme, transform);
		} catch {
			// 构造失败保留原生子节点
		}
	}
}

/**
 * 包在 compact-mode 之外层：先走下游 updateContent（compact/原生），
 * 再把文本 Markdown 子节点换成打点段落。compact 摘要行非 Markdown，
 * 天然不受影响；thinking 斜体块跳过。
 */
export function installDottedParagraphs(): () => void {
	const previous = patchRegistry.get<{ dispose: () => void }>(ASSISTANT_DOTTED_PATCH);
	if (previous) previous.dispose();
	const prototype = (AssistantMessageComponent as any).prototype;
	const downstream = prototype.updateContent;
	const patch: { active: boolean; dispose: () => void } = {
		active: true,
		dispose: () => {},
	};
	const installed = function (this: any, message: any, isStreaming?: boolean) {
		const result = downstream.call(this, message, isStreaming);
		if (patch.active) {
			try {
				resyncAssistantComponent(this);
			} catch {
				// 同步失败保留下游渲染结果
			}
		}
		return result;
	};
	prototype.updateContent = installed;
	// compact-thinking shutdown 经此键直达原生：透传下游标记（compact 有则为
	// 原生），否则指向下游自身，避免恢复时停在打点包装器上。
	(installed as any)[PROTOTYPE_ORIGINAL_KEY] =
		(downstream as any)?.[PROTOTYPE_ORIGINAL_KEY] ?? downstream;
	patch.dispose = () => {
		patch.active = false;
		if (prototype.updateContent === installed) prototype.updateContent = downstream;
		patchRegistry.dispose(ASSISTANT_DOTTED_PATCH, patch);
	};
	patchRegistry.install(ASSISTANT_DOTTED_PATCH, patch);
	return patch.dispose;
}

/** 已挂载 transcript 按当前 mode 重同步（/ccstyle on|off 切换）。 */
export function refreshDottedParagraphs(root: any): void {
	walkComponentTree(root, (value: any) => {
		if (value instanceof AssistantMessageComponent) {
			try {
				resyncAssistantComponent(value);
			} catch {
				// 单个组件失败不阻断整树
			}
			value.invalidate?.();
			return false;
		}
		return true;
	});
}
