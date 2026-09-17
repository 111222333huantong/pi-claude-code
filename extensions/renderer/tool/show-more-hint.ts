/**
 * show-more 提示文本：fullscreen 下鼠标 hover/click 可用，提示 "click to show more"；
 * 其他模式（regular 保留终端原生 scrollback、不启用鼠标上报）提示默认展开快捷键。
 *
 * tui 模式由 mouse-interaction 在 renderer 回调中维护；未安装时按 fullscreen 处理，
 * 保证纯渲染测试与既有行为不变。
 */
import { expandShortcutText } from "../../utils/key-hints.ts";

export { expandShortcutText };

let toolTuiFullscreen: boolean | undefined;

export function setToolTuiFullscreen(value: boolean): void {
	toolTuiFullscreen = value;
}

export function isToolTuiFullscreen(): boolean {
	return toolTuiFullscreen !== false;
}

export function showMoreHintText(): string {
	return isToolTuiFullscreen() ? "click to show more" : `${expandShortcutText()} to show more`;
}
