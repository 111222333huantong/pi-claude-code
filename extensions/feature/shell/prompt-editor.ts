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

/** 标记 editor 实例已经加过前缀，避免外层再次包装时重复渲染。 */
const DECORATED = Symbol.for("pi-claude-code:prompt-editor-decorated");

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
	if ((editor as Record<symbol, unknown>)[DECORATED]) return editor;
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
	try {
		(editor as Record<symbol, unknown>)[DECORATED] = true;
	} catch {
		// 非扩展对象：忽略标记，渲染仍然生效
	}
	return editor;
}

/** 是否正占着插槽；占据前的工厂用于原样还回去。 */
let active = false;
let previousEditorFactory: EditorFactory | undefined;
let activeFactory: EditorFactory | undefined;

/**
 * 每次安装都创建独立工厂并固定它包住的那一层，避免再次安装时
 * `previousEditorFactory` 被改成外层 wrapper，形成 F → wrapper → F 的递归。
 */
function createPromptEditorFactory(base: EditorFactory | undefined): EditorFactory {
	return (tui, theme, keybindings) => {
		const editor = base
			? base(tui, theme, keybindings)
			: new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: false });
		return decorateEditor(editor);
	};
}

/**
 * 撤销本扩展占据的插槽；从未占用就不碰插槽。
 *
 * 插槽可能已经被其他扩展包在外层（pi-inline-skills 会把当前工厂再包一层），
 * 那种结构里无法只拆内层，直接还回占据前的工厂；外层扩展会在下次终端输入时
 * 自己重新包装，前缀不会因此复活。
 *
 * 例外：插槽被 pi 重置回占据前的工厂时（/new、/reload 走 resetExtensionUI），
 * 我们已经不在槽里，再写一次会把 pi 刚重置的结果又覆盖掉；此时只清状态。
 */
function releasePromptEditor(ctx: ExtensionContext): void {
	if (!active) return;
	const previous = previousEditorFactory;
	active = false;
	previousEditorFactory = undefined;
	activeFactory = undefined;
	if (ctx.ui.getEditorComponent?.() === previous) return;
	ctx.ui.setEditorComponent(previous);
}

/**
 * 应用输入框前缀；enableEditorPrefix=false 时只撤自己装的那层。
 *
 * 只在没有扩展对话框开着时调用：pi 的 setEditorComponent 会清空 editorContainer 并
 * 抢走焦点，把正在设置面板里的对话框踢出渲染树，对话框的 done() 再也走不到，
 * `ctx.ui.custom()` 的 Promise 永不落定，后续输入全部卡死。设置面板自己不做替换，
 * 等 `ctx.ui.custom()` 返回后再调本函数。
 *
 * 插槽已经装着本扩展的编辑器时直接返回：重复安装只会重建实例，丢掉撤销栈、
 * 历史等编辑器状态，还会打断其他扩展包在外层的编辑器。
 */
export function applyPromptEditor(ctx: ExtensionContext): void {
	if (!ctx?.hasUI || typeof ctx.ui?.setEditorComponent !== "function") return;
	if (!config.enableEditorPrefix) {
		releasePromptEditor(ctx);
		return;
	}
	const current = ctx.ui.getEditorComponent?.();
	if (activeFactory && current === activeFactory) return;
	try {
		// pi 的插槽是硬替换、没有栈，先记住是谁占着，撤销时还回去。
		previousEditorFactory = current;
		activeFactory = createPromptEditorFactory(current);
		active = true;
		ctx.ui.setEditorComponent(activeFactory);
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
