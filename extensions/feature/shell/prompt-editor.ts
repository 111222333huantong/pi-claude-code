/**
 * 输入框 `❯` 提示符（issue #68）。
 *
 * 实现为 editor factory 的渲染包装层：保留 pi-paster 的自定义编辑器、
 * working-row 的内嵌状态开关等已有包装，只在渲染出的首内容行前加前缀。
 * 这样 image-paster / working-row / 本扩展的 factory 链不会互相覆盖。
 *
 * `inputTextIndent()` 返回输入文本起始列，footer 用它对齐左侧基线：
 * 前缀开 = editorPaddingX + 2，关 = editorPaddingX。
 */
import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { config } from "../../config/config.ts";
import { prefixEditorPromptLine } from "../../renderer/user-message.ts";

/** `❯ ` 固定 2 列：glyph + 尾随空格。 */
const PROMPT_COLS = 2;

/** 最近一次 render 读到的用户 editorPaddingX；未渲染过时为 0。 */
let userPaddingX = 0;

/** 输入文本起始列：footer 按它对齐。 */
export function inputTextIndent(): number {
	return config.enableEditorPrefix ? userPaddingX + PROMPT_COLS : userPaddingX;
}

type EditorFactory = Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0];

type DecoratedEditor = {
	render: (width: number) => string[];
	getPaddingX?: () => number;
};

/** 给单个 editor 实例的渲染加前缀，不改变编辑器本身的输入/粘贴能力。 */
function decorateEditor<T>(editor: T): T {
	if (
		!editor ||
		typeof editor !== "object" ||
		typeof (editor as unknown as DecoratedEditor).render !== "function"
	) {
		return editor;
	}
	const target = editor as unknown as DecoratedEditor;
	const originalRender = target.render.bind(target);
	target.render = (width: number): string[] => {
		const lines = originalRender(width);
		if (!Array.isArray(lines) || lines.length < 3 || width < 2) return lines;
		try {
			const paddingX = target.getPaddingX?.() ?? 0;
			userPaddingX = paddingX;
			lines[1] = prefixEditorPromptLine(lines[1] ?? "", paddingX, width);
		} catch {
			// 装饰失败保留原生行
		}
		return lines;
	};
	return editor;
}

/** 是否正占着插槽；占据前的工厂用于原样还回去。 */
let active = false;
let previousEditorFactory: EditorFactory | undefined;

const promptEditorFactory: EditorFactory = (tui, theme, keybindings) => {
	const editor = previousEditorFactory
		? previousEditorFactory(tui, theme, keybindings)
		: new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: false });
	return decorateEditor(editor);
};

/** 撤销本扩展占据的插槽；从未占用就不碰插槽。 */
function releasePromptEditor(ctx: ExtensionContext): void {
	if (!active) return;
	ctx.ui.setEditorComponent(previousEditorFactory);
	active = false;
	previousEditorFactory = undefined;
}

/** 应用输入框前缀；enableEditorPrefix=false 时只撤自己装的那层。 */
export function applyPromptEditor(ctx: ExtensionContext): void {
	if (!ctx?.hasUI || typeof ctx.ui?.setEditorComponent !== "function") return;
	try {
		if (!config.enableEditorPrefix) {
			releasePromptEditor(ctx);
			return;
		}
		if (!active) {
			// pi 的插槽是硬替换、没有栈，先记住是谁占着，撤销时还回去。
			previousEditorFactory = ctx.ui.getEditorComponent?.();
			active = true;
		}
		ctx.ui.setEditorComponent(promptEditorFactory);
	} catch (err) {
		ctx.ui.notify(
			`prompt editor error: ${err instanceof Error ? err.message : String(err)}`,
			"error",
		);
	}
}

/** 恢复本扩展占据前的编辑器；未占用时不动作。 */
export function clearPromptEditor(ctx: ExtensionContext): void {
	if (!ctx?.hasUI || typeof ctx.ui?.setEditorComponent !== "function") return;
	releasePromptEditor(ctx);
}
