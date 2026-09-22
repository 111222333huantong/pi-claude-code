export const TOOL_LOADING_INTERVAL_MS = 80;

/** pending 圆点明暗呼吸周期：accent 亮 800ms，dim 暗 800ms（完整一亮一暗 1.6 秒）。 */
export const PENDING_DOT_INTERVAL_MS = 800;

const BRAILLE_LOADING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * 标题行状态 gutter：字形 1 列 + 后随空格 1 列 = 恒占 2 列。
 * 所有状态字形必须同宽，否则 pending→落定时标题左右抖动。
 */
export const TOOL_STATUS_GLYPH_WIDTH = 1;
export const TOOL_GUTTER_WIDTH = TOOL_STATUS_GLYPH_WIDTH + 1;

/** 排队态静态圆点：darwin 用 ⏺，其余平台用 ●（等宽回退，保证对齐）。 */
export function queuedToolGlyph(): string {
	return process.platform === "darwin" ? "⏺" : "●";
}

export type ToolStatusGlyphKind = "running" | "queued" | "success" | "error" | "halted";

/** 五态字形（思想重写自 Claude Code ToolUseLoader：同位复用，不换列宽）。 */
export function toolStatusGlyph(kind: ToolStatusGlyphKind, now = Date.now()): string {
	switch (kind) {
		case "running":
			return toolLoadingIcon(now);
		case "queued":
			return queuedToolGlyph();
		case "success":
			return "✓";
		case "error":
			return "✗";
		// 用户动作中断（非真失败）：空心圆 dim，与 mcode cancelled 词汇一致。
		case "halted":
			return "○";
	}
}

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
