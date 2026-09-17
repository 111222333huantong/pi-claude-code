/**
 * 面向用户的快捷键显示文本：统一走 pi 官方 keybindings 查询，
 * 用户改键后提示自动跟随；查不到（纯渲染测试等无绑定环境）回退默认值。
 */
import { getKeybindings, type Keybinding } from "@earendil-works/pi-tui";

function formatKeyPart(part: string): string {
	// 与 pi 内置 keybinding-hints 一致：macOS 上 alt 显示为 option
	if (process.platform === "darwin" && part.toLowerCase() === "alt") return "option";
	// 显示归一：escape 显示为 esc（历史文案口径），改键后显示实际绑定。
	if (part.toLowerCase() === "escape") return "esc";
	return part;
}

/** 指定动作的首选显示文本；无绑定时回退 fallback。 */
export function shortcutText(action: Keybinding, fallback: string): string {
	let keys: string[] = [];
	try {
		keys = getKeybindings().getKeys(action);
	} catch {
		// 无 keybinding 上下文（如纯函数测试）：直接回退。
	}
	if (keys.length === 0) return fallback;
	return keys
		.join("/")
		.split("/")
		.map((part) => part.split("+").map(formatKeyPart).join("+"))
		.join("/");
}

/** 工具卡展开键（app.tools.expand）；默认 ctrl+o。 */
export function expandShortcutText(): string {
	return shortcutText("app.tools.expand", "ctrl+o");
}

/** 中断键（app.interrupt）；默认 esc。 */
export function interruptShortcutText(): string {
	return shortcutText("app.interrupt", "esc");
}

/** 选择框取消键（tui.select.cancel）；默认 esc（多绑定时取首个，省列宽）。 */
export function selectCancelShortcutText(): string {
	return shortcutText("tui.select.cancel", "esc").split("/")[0] ?? "esc";
}

/** 句首大写（footer 与句式提示保持历史大小写口径）。 */
export function capitalizeKey(text: string): string {
	return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}
