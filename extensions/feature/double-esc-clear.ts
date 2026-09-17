/**
 * double-esc-clear：非空草稿双击 Esc 清空（2000ms 窗口）。
 *
 * 内置双 Esc 只对空编辑器生效；有字草稿闲时按 Esc 是 no-op。
 * 本功能：第一下 Esc 右上弹 `Esc again to clear` 提示，第二下清空，
 * 永不透传（误触不丢字）；忙时吞掉 Esc，保住运行中的 turn
 * （忙时 Esc 中断只属于空草稿，即 esc-steer）。
 *
 * 绝不拦截的内置路径：bash 运行中 abort、`!` bash-mode 单 Esc、
 * 自动补全取消、空草稿双 Esc（doubleEscapeAction）。
 *
 * 契约（思想重写自 cc-my-pi `double-esc-clear.ts`，MIT，
 * 其 vendored 自 `@thisux/pi-double-esc-clear`）：
 * - 能力检测不用 instanceof（跨 node_modules 双副本会误判）。
 * - handleInput 拦截而非 onEscape 赋值（框架在工厂返回后重绑 onEscape）。
 * - EDITOR_FEATURES 标记与 esc-steer 同命名空间，重复安装幂等。
 */
import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { config } from "../config/config.ts";

/** 第二下 Esc 确认窗口（同时是提示可见时长）。 */
export const DOUBLE_ESC_MS = 2000;

const EDITOR_FEATURES = Symbol.for("@tmustier/pi-editor-features");
const FEATURE = "double-esc-clear";

const HINT_WIDGET_KEY = "ccstyle-double-esc-hint";
const HINT_TEXT = "Esc again to clear";

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
type ComposedEditorFactory = EditorFactory & { [EDITOR_FEATURES]?: ReadonlySet<string> };

function editorFeatures(factory: EditorFactory | undefined): ReadonlySet<string> {
	return (factory as ComposedEditorFactory | undefined)?.[EDITOR_FEATURES] ?? new Set();
}

/** Pi 原生 Esc 会放过的草稿不碰：空串与 `!` bash-mode。 */
export function isClearableDraft(text: string): boolean {
	if (text.trim().length === 0) return false;
	if (text.trimStart().startsWith("!")) return false;
	return true;
}

export function registerDoubleEscClear(pi: ExtensionAPI): void {
	let hintTimer: ReturnType<typeof setTimeout> | undefined;
	let hintCtx: ExtensionContext | undefined;
	let installTimer: ReturnType<typeof setTimeout> | undefined;

	const isEnabled = (): boolean => config.enableDoubleEscClear;

	const hideHint = (): void => {
		if (hintTimer) clearTimeout(hintTimer);
		hintTimer = undefined;
		try {
			hintCtx?.ui.setWidget(HINT_WIDGET_KEY, undefined);
		} catch {
			// 卸载期 ctx 已失效：静默即可。
		}
		hintCtx = undefined;
	};

	const showHint = (ctx: ExtensionContext): void => {
		hideHint();
		hintCtx = ctx;
		try {
			ctx.ui.setWidget(
				HINT_WIDGET_KEY,
				(_tui, theme) => ({
					render: (width: number) => {
						const styled =
							theme && typeof theme.fg === "function" ? theme.fg("dim", HINT_TEXT) : HINT_TEXT;
						const pad = Math.max(0, width - HINT_TEXT.length);
						return [`${" ".repeat(pad)}${styled}`];
					},
					invalidate() {},
				}),
				{ placement: "aboveEditor" },
			);
		} catch {
			// widget 挂载失败不影响 Esc 本体逻辑。
		}
		hintTimer = setTimeout(hideHint, DOUBLE_ESC_MS);
	};

	const installEditor = (ctx: ExtensionContext): void => {
		if (ctx.mode !== "tui") return;
		const previous = ctx.ui.getEditorComponent();
		if (editorFeatures(previous).has(FEATURE)) return;

		const factory = ((tui, theme, keybindings: KeybindingsManager) => {
			const editor = (previous?.(tui, theme, keybindings) ??
				new CustomEditor(tui, theme, keybindings)) as CustomEditor;
			if (
				typeof editor.getText !== "function" ||
				typeof editor.setText !== "function" ||
				typeof editor.isShowingAutocomplete !== "function" ||
				typeof editor.handleInput !== "function"
			) {
				return editor;
			}

			const originalHandleInput = editor.handleInput.bind(editor);
			let lastEscapeTime = 0;

			editor.handleInput = (data: string) => {
				const isEscape =
					typeof keybindings.matches === "function"
						? keybindings.matches(data, "app.interrupt")
						: matchesKey(data, "escape");
				if (
					isEscape &&
					isEnabled() &&
					!editor.isShowingAutocomplete() &&
					isClearableDraft(editor.getText())
				) {
					const now = Date.now();
					if (now - lastEscapeTime < DOUBLE_ESC_MS) {
						editor.setText("");
						lastEscapeTime = 0;
						hideHint();
						return;
					}
					lastEscapeTime = now;
					showHint(ctx);
					// 闲时透传（bash abort 等原生路径照走）；忙时吞掉保 turn。
					if (ctx.isIdle()) originalHandleInput(data);
					return;
				}
				if (!isEscape) {
					lastEscapeTime = 0;
					if (hintTimer) hideHint();
				}
				originalHandleInput(data);
			};

			return editor;
		}) as ComposedEditorFactory;
		factory[EDITOR_FEATURES] = new Set([...editorFeatures(previous), FEATURE]);
		ctx.ui.setEditorComponent(factory);
	};

	const scheduleInstall = (ctx: ExtensionContext): void => {
		if (installTimer) clearTimeout(installTimer);
		installTimer = setTimeout(() => {
			installTimer = undefined;
			installEditor(ctx);
		}, 0);
	};

	pi.on("session_start", (_event, ctx) => {
		installEditor(ctx);
		scheduleInstall(ctx);
	});
	pi.on("agent_start", (_event, ctx) => {
		installEditor(ctx);
		scheduleInstall(ctx);
	});
	pi.on("session_shutdown", () => {
		if (installTimer) clearTimeout(installTimer);
		installTimer = undefined;
		hideHint();
	});
}

export default registerDoubleEscClear;
