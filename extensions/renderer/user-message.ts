/**
 * 用户端朴素 ❯ 美化（移植自 cc-my-pi `user-message-render.ts`，MIT）。
 *
 * 只做朴素版：蓝条 ▎ 变体、半块上下描边、拷贝分区一律不搬。
 *
 * A. 已提交消息：整宽 userMessageBg 底行，首行 `❯ `，续行 2 空格顶齐，
 *    去原生边框与上下留白；附件树收成单个 ⎿；pi-paster 图片路径块仅隐藏
 *    显示（模型照收原文）。
 * B. 输入框：实例级 factory 包裹给提示行加 `❯ `，续行对齐；bash `!` 开头
 *    不重复装饰。
 */
import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { config } from "../config/config.ts";
import { PROMPT_GLYPH_FACTORY, USER_MESSAGE_PATCH, patchRegistry } from "../utils/patch-keys.ts";
import { stripAnsi } from "../utils/ansi-text.ts";
import { walkComponentTree } from "../utils/component-tree.ts";
import { getMessageDisplayTheme } from "./tool/message-display.ts";

export type UserMessagePaint = {
	bg: (text: string) => string;
	dim: (text: string) => string;
};

/** 首行 `❯ ` 占 2 列，续行补 2 空格顶齐。 */
export const USER_PROMPT_PREFIX = "❯ ";
export const USER_CONTINUATION_INDENT = "  ";

/** 去行首尾空白（含 ANSI 后缀空格），保留行内样式。 */
function trimLineEnds(line: string): string {
	let out = line.replace(/^[ \t]+/, "");
	out = out.replace(/[ \t]+((?:\x1b\[[0-9;]*m)*)$/g, "$1");
	return out;
}

/**
 * 去原生上下留白与孤立提示符行（❯/›/> 独占一行时是原生边框残留）。
 * 移植自 cc-my-pi `trimUserMessagePadding`。
 */
export function trimUserMessagePadding(lines: string[]): string[] {
	const blank = (line: string) => stripAnsi(line).trim() === "";
	let start = 0;
	let end = lines.length;
	while (start < end && blank(lines[start] ?? "")) start += 1;
	while (end > start && blank(lines[end - 1] ?? "")) end -= 1;
	while (start < end && /^(?:❯|›|>)$/.test(stripAnsi(lines[start] ?? "").trim())) start += 1;
	while (start < end && blank(lines[start] ?? "")) start += 1;
	return lines.slice(start, end);
}

const CONTEXT_CONTINUATION_MARK = "\uE000";
const CONTEXT_BRANCH =
	/^((?:\x1b\[[0-?]*[ -/]*[@-~]|\s)*)([├└│⎿])(?:─)?((?:\x1b\[[0-?]*[ -/]*[@-~])*)(?:\s*)/;

/**
 * Pi 附件/上下文树收成单个 Claude 式 ⎿：首个分支行换 ⎿，
 * 后续分支行标记续行（渲染时按续行缩进）。
 * 移植自 cc-my-pi `normalizeClaudeUserContextBranches`。
 */
export function normalizeUserContextBranches(lines: string[]): string[] {
	let armSeen = false;
	return lines.map((line, index) => {
		if (index === 0 || !CONTEXT_BRANCH.test(line)) return line;
		if (armSeen) return line.replace(CONTEXT_BRANCH, `${CONTEXT_CONTINUATION_MARK}$1$3`);
		armSeen = true;
		return line.replace(CONTEXT_BRANCH, "$1⎿$3  ");
	});
}

/**
 * 藏掉 pi-paster 追加的附件路径块（显示层 only）：
 *   Attached image paths:
 *   - [#image 1]: /path/to/img.png
 * 仅尾部完整块才剥；模型侧原文不受影响。
 * 移植自 cc-my-pi `stripAttachedImagePathsBlock`。
 */
export function stripAttachedImagePathsBlock(lines: string[]): string[] {
	const plain = lines.map((line) => stripAnsi(line).trim());
	let header = -1;
	for (let i = plain.length - 1; i >= 0; i--) {
		if (plain[i] === "Attached image paths:") {
			header = i;
			break;
		}
	}
	if (header === -1) return lines;
	for (let i = header + 1; i < plain.length; i++) {
		if (plain[i] === "") continue;
		if (!/^-\s*\[#image \d+\]:\s/.test(plain[i]!)) return lines;
	}
	let end = header;
	while (end > 0 && plain[end - 1] === "") end -= 1;
	return lines.slice(0, end);
}

/**
 * 单行渲染：首行 `❯ ` + 内容，续行 2 空格顶齐，整行铺底色垫满宽度。
 * 续行标记（CONTEXT_CONTINUATION_MARK）按普通续行缩进。
 */
export function renderUserMessageLine(
	line: string,
	width: number,
	first: boolean,
	paint: UserMessagePaint,
): string {
	const cleaned = trimLineEnds(
		line.startsWith(CONTEXT_CONTINUATION_MARK)
			? line.slice(CONTEXT_CONTINUATION_MARK.length)
			: line,
	);
	const prefix = first ? paint.dim(USER_PROMPT_PREFIX) : USER_CONTINUATION_INDENT;
	// 前缀固定占 2 可见列（`❯ `/两空格）。
	const innerWidth = Math.max(1, width - 2);
	const content = truncateToWidth(cleaned, innerWidth, "");
	const body = `${prefix}${content}`;
	const padding = " ".repeat(Math.max(0, width - visibleWidth(stripAnsi(body))));
	return paint.bg(`${body}${padding}`);
}

/**
 * 输入框提示行：去 editor 左 padding，加朴素 `❯ `；bash `!` 开头与已装饰
 * 行原样放过。移植自 cc-my-pi `prefixEditorPromptLine`（去颜色参数）。
 */
export function prefixEditorPromptLine(line: string, paddingX: number, width: number): string {
	const removablePadding = Math.min(Math.max(0, paddingX), line.match(/^ */)?.[0].length ?? 0);
	const content = line.slice(removablePadding);
	const plainStart = stripAnsi(content).trimStart();
	if (plainStart.startsWith("❯") || plainStart.startsWith("!")) return line;
	return truncateToWidth(`${USER_PROMPT_PREFIX}${content}`, Math.max(0, width), "");
}

/** 输入框续行：去 padding 后补 2 空格顶齐。移植自 `indentEditorContinuationLine`。 */
export function indentEditorContinuationLine(
	line: string,
	paddingX: number,
	width: number,
): string {
	const removablePadding = Math.min(Math.max(0, paddingX), line.match(/^ */)?.[0].length ?? 0);
	return truncateToWidth(
		`${USER_CONTINUATION_INDENT}${line.slice(removablePadding)}`,
		Math.max(0, width),
		"",
	);
}

function userMessagePaint(): UserMessagePaint | undefined {
	const theme = getMessageDisplayTheme() as
		| { bg?: (color: string, text: string) => string; fg?: (color: string, text: string) => string }
		| undefined;
	if (typeof theme?.bg !== "function" || typeof theme?.fg !== "function") return undefined;
	return {
		bg: (text: string) => theme.bg!("userMessageBg", text),
		dim: (text: string) => theme.fg!("dim", text),
	};
}

/** patch 已提交消息 render；mode=off 回退原生。返回 dispose。 */
export function installUserMessageRender(): () => void {
	const previous = patchRegistry.get<{ dispose: () => void }>(USER_MESSAGE_PATCH);
	if (previous) previous.dispose();
	const prototype = (UserMessageComponent as any).prototype;
	const original = prototype.render;
	if (typeof original !== "function") return () => {};
	const patch: { active: boolean; dispose: () => void } = { active: true, dispose: () => {} };
	const installed = function (this: any, width: number): string[] {
		if (!patch.active || config.mode === "off") return original.call(this, width);
		try {
			const paint = userMessagePaint();
			if (!paint) return original.call(this, width);
			const messageWidth = Math.max(1, Math.floor(width) || 80);
			const lines = trimUserMessagePadding(
				normalizeUserContextBranches(
					stripAttachedImagePathsBlock(original.call(this, Math.max(1, messageWidth - 2)) ?? []),
				),
			);
			if (lines.length === 0) return original.call(this, width);
			return lines.map((line, index) =>
				renderUserMessageLine(line, messageWidth, index === 0, paint),
			);
		} catch {
			return original.call(this, width);
		}
	};
	prototype.render = installed;
	patch.dispose = () => {
		patch.active = false;
		if (prototype.render === installed) prototype.render = original;
		patchRegistry.dispose(USER_MESSAGE_PATCH, patch);
	};
	patchRegistry.install(USER_MESSAGE_PATCH, patch);
	return patch.dispose;
}

/** 已挂载用户消息按当前 mode 重渲染（/ccstyle 切换）。 */
export function refreshUserMessages(root: any): void {
	walkComponentTree(root, (value: any) => {
		if (value instanceof UserMessageComponent) {
			value.invalidate?.();
			return false;
		}
		return true;
	});
}

type EditorFactory = (tui: any, theme: any, keybindings: unknown) => any;

/**
 * 输入框实例级 factory 包裹：提示行加 `❯ `，续行对齐。
 * 跨 CustomEditor 副本生效；与 image-paster/working-row 链式共存，
 * session_start 重复触发幂等。挂载顺序：后注册包外层（见 index.ts）。
 */
export function registerPromptGlyph(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		const ui = (ctx as any)?.ui;
		if (!ctx?.hasUI || !ui || typeof ui.setEditorComponent !== "function") return;
		if (typeof ui.getEditorComponent !== "function") return;
		const current = ui.getEditorComponent();
		if (current && (current as any)[PROMPT_GLYPH_FACTORY]) return;
		const previous: EditorFactory | undefined = current ?? undefined;
		const factory = ((tui: any, theme: any, keybindings: unknown) => {
			const editor = previous ? previous(tui, theme, keybindings) : undefined;
			if (!editor || typeof editor.render !== "function") return editor;
			const originalRender = editor.render.bind(editor);
			editor.render = (width: number): string[] => {
				const lines = originalRender(width);
				if (!Array.isArray(lines) || lines.length < 3 || width < 2) return lines;
				try {
					const paddingX = editor.getPaddingX?.() ?? 0;
					lines[1] = prefixEditorPromptLine(lines[1] ?? "", paddingX, width);
					for (let index = 2; index < lines.length - 1; index++) {
						lines[index] = indentEditorContinuationLine(lines[index] ?? "", paddingX, width);
					}
				} catch {
					// 装饰失败保留原生行
				}
				return lines;
			};
			return editor;
		}) as EditorFactory;
		(factory as any)[PROMPT_GLYPH_FACTORY] = true;
		ui.setEditorComponent(factory);
	});
}
