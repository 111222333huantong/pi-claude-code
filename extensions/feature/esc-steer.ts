/**
 * esc-steer：运行中空输入框按 Esc，中断本轮并在落定后自动续发排队内容。
 *
 * 不拥有队列，只做编排：Esc 本体透传（原生队列恢复/第三方暂停逻辑照走），
 * 记一个 continueAfterAbort 标记，`agent_settled` 且空闲时注一个空回车，
 * 让暂停的 lane 恢复或原生恢复的排队文本自动提交。
 *
 * 契约（思想重写自 cc-my-pi `esc-steer.ts`，MIT）：
 * - 仅空草稿才 arm；有字草稿归 double-esc-clear，绝不自动提交用户文字。
 * - editor 包裹打 EDITOR_FEATURES 标记（与 cc-my-pi / queue-steer 同一个
 *   `Symbol.for` 命名空间，跨包互斥不双包）。
 * - session_start 立装 + tick 延时重装 + agent_start 重装，保外层位置。
 */
import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { config } from "../config/config.ts";

const EDITOR_FEATURES = Symbol.for("@tmustier/pi-editor-features");
const FEATURE = "esc-steer";

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
type ComposedEditorFactory = EditorFactory & { [EDITOR_FEATURES]?: ReadonlySet<string> };

function editorFeatures(factory: EditorFactory | undefined): ReadonlySet<string> {
	return (factory as ComposedEditorFactory | undefined)?.[EDITOR_FEATURES] ?? new Set();
}

/** ESC 控制字符（不用转义字面写法，避免源码出现不可见字符）。 */
const ESC_DATA = String.fromCharCode(27);

export function registerEscSteer(pi: ExtensionAPI): void {
	let editorInstallTimer: ReturnType<typeof setTimeout> | undefined;
	let continueAfterAbort = false;
	let injectSubmit: (() => void) | undefined;

	const isEnabled = (): boolean => config.enableEscSteer;

	const tryContinueQueued = (ctx: ExtensionContext): void => {
		if (!isEnabled() || !continueAfterAbort) {
			continueAfterAbort = false;
			return;
		}
		if (!ctx.isIdle()) return;
		continueAfterAbort = false;
		const fire = injectSubmit;
		if (!fire) return;
		// 落定收尾之后再注回车，避免嵌套 prompt。
		setTimeout(() => {
			if (!ctx.isIdle()) return;
			try {
				fire();
			} catch (error) {
				ctx.ui.notify(
					`esc-steer: could not continue after abort: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		}, 0);
	};

	const installEditor = (ctx: ExtensionContext): void => {
		if (ctx.mode !== "tui") return;
		const previousFactory = ctx.ui.getEditorComponent();
		if (editorFeatures(previousFactory).has(FEATURE)) return;

		const factory = ((tui, theme, keybindings: KeybindingsManager) => {
			const editor =
				previousFactory?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
			const handleInput = editor.handleInput.bind(editor);

			const draftIsEmpty = (): boolean => {
				const candidate = editor as typeof editor & { getText?: () => string };
				return (candidate.getText?.() ?? "").trim().length === 0;
			};
			const autocompleteOpen = (): boolean => {
				const candidate = editor as typeof editor & { isShowingAutocomplete?: () => boolean };
				return candidate.isShowingAutocomplete?.() ?? false;
			};

			injectSubmit = () => {
				for (const submit of ["\r", "\n"]) {
					if (keybindings.matches(submit, "tui.input.submit")) {
						handleInput(submit);
						return;
					}
				}
				handleInput("\r");
			};

			editor.handleInput = (data: string): void => {
				const isInterrupt =
					typeof keybindings.matches === "function"
						? keybindings.matches(data, "app.interrupt")
						: data === ESC_DATA;
				if (isInterrupt && isEnabled() && !autocompleteOpen() && !ctx.isIdle() && draftIsEmpty()) {
					// 先透传：让原生/第三方完成暂停与队列恢复，落定后再续发。
					continueAfterAbort = true;
					handleInput(data);
					return;
				}
				handleInput(data);
			};

			return editor;
		}) as ComposedEditorFactory;
		factory[EDITOR_FEATURES] = new Set([...editorFeatures(previousFactory), FEATURE]);
		ctx.ui.setEditorComponent(factory);
	};

	const scheduleInstall = (ctx: ExtensionContext): void => {
		if (editorInstallTimer) clearTimeout(editorInstallTimer);
		editorInstallTimer = setTimeout(() => {
			editorInstallTimer = undefined;
			installEditor(ctx);
		}, 0);
	};

	pi.on("session_start", (_event, ctx) => {
		continueAfterAbort = false;
		installEditor(ctx);
		scheduleInstall(ctx);
	});
	pi.on("agent_start", (_event, ctx) => {
		installEditor(ctx);
		scheduleInstall(ctx);
	});
	pi.on("agent_settled", (_event, ctx) => {
		tryContinueQueued(ctx);
	});
	pi.on("session_shutdown", () => {
		if (editorInstallTimer) clearTimeout(editorInstallTimer);
		editorInstallTimer = undefined;
		continueAfterAbort = false;
		injectSubmit = undefined;
	});
}

export default registerEscSteer;
