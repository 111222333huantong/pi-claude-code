import { CustomEditor, type ExtensionAPI, VERSION } from "@earendil-works/pi-coding-agent";
import type { EditorComponent, EditorTheme, TUI } from "@earendil-works/pi-tui";

/** Editor 工厂签名（与 Pi 的 EditorFactory 同形；包索引未导出该类型，本地定义）。 */
type EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: unknown) => EditorComponent;

/**
 * Pi 0.85 把 streaming working spinner 移进了 editor 顶部边框
 * （`embedWorkingStatus`），重试/压缩等仍是编辑器上方的独立行。
 * 本扩展要的是 0.84 的 Claude Code 风格：spinner 和重试在同一独立行，
 * 所以这里把内嵌关掉，让 working 回落到独立行。
 *
 * 实现方式：包一层 editor 工厂，把产物实例的 `embedWorkingStatus`
 * 置 false。Pi 的 `isWorkingStatusEditor` 判定失败后会自动走
 * `statusContainer` 独立行（和 retry 同一容器），无需碰 Pi 内部类。
 * 只在运行时 Pi >= 0.85 才生效，0.84 无此字段，原样不动。
 * 工厂链顺序无关（只改一个 boolean），和其他 editor 包装共存。
 */

/** 标记已包装过的工厂，session_start 重复触发时保持幂等。 */
const WORKING_ROW_FACTORY = Symbol.for("pi-claude-code:working-row-factory");

/** 解析版本号，判断是否为带内嵌 working 行的 Pi（>= 0.85）。导出供测试。 */
export function piSupportsEmbeddedWorking(version = VERSION): boolean {
	const match = /^(\d+)\.(\d+)/.exec(version ?? "");
	if (!match) return false;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
	return major > 0 || minor >= 85;
}

/** 关掉单个 editor 实例的内嵌；非 CustomEditor 系实例本来就没有内嵌。 */
function disableEmbeddedWorking<T>(editor: T): T {
	if (editor && typeof editor === "object" && "embedWorkingStatus" in editor) {
		try {
			(editor as Record<string, unknown>).embedWorkingStatus = false;
		} catch {
			/* 某些构建下是只读字段，忽略即可 */
		}
	}
	return editor;
}

/** 注册 session_start 钩子：包一层 editor 工厂并关掉内嵌。导出供测试。 */
export function installWorkingRow(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		const ui = (
			ctx as unknown as {
				ui?: {
					setEditorComponent?: (factory: EditorFactory | undefined) => void;
					getEditorComponent?: () => EditorFactory | undefined;
				};
			}
		)?.ui;
		if (
			!ctx.hasUI ||
			!ui ||
			typeof ui.setEditorComponent !== "function" ||
			typeof ui.getEditorComponent !== "function"
		) {
			return;
		}
		const current = ui.getEditorComponent();
		if (current && (current as unknown as Record<symbol, unknown>)[WORKING_ROW_FACTORY]) {
			return;
		}
		const previous: EditorFactory | undefined = current ?? undefined;
		const factory = ((tui, theme, keybindings) => {
			const editor = previous
				? previous(tui, theme, keybindings)
				: new CustomEditor(
						tui,
						theme,
						keybindings as unknown as ConstructorParameters<typeof CustomEditor>[2],
					);
			return disableEmbeddedWorking(editor);
		}) as EditorFactory;
		(factory as unknown as Record<symbol, unknown>)[WORKING_ROW_FACTORY] = true;
		ui.setEditorComponent(factory);
	});
}

export default function (pi: ExtensionAPI): void {
	// 0.84 及更早没有内嵌逻辑，不用做任何事（VERSION 是运行时 Pi 的版本）。
	if (!piSupportsEmbeddedWorking()) return;
	installWorkingRow(pi);
}
