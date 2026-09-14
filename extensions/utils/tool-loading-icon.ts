export const TOOL_LOADING_INTERVAL_MS = 80;

/** pending 圆点明暗呼吸周期：accent 亮 800ms，dim 暗 800ms（完整一亮一暗 1.6 秒）。 */
export const PENDING_DOT_INTERVAL_MS = 800;

const BRAILLE_LOADING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function toolLoadingIcon(now = Date.now()): string {
	return BRAILLE_LOADING_FRAMES[
		Math.floor(now / TOOL_LOADING_INTERVAL_MS) % BRAILLE_LOADING_FRAMES.length
	]!;
}

/**
 * 执行中圆点呼吸色：偶相位 accent，奇相位 dim。
 * 纯函数（时间可注入），分组头/单工具 pending 图标共用；
 * 只变颜色不换字形，宽度稳定不抖动。
 */
export function pendingDotColor(now = Date.now()): "accent" | "dim" {
	return Math.floor(now / PENDING_DOT_INTERVAL_MS) % 2 === 0 ? "accent" : "dim";
}
