import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/**
 * 统一圆角框（思想模仿 MiniMax Code panel-frame / TUI 通用圆角框，代码自实现）。
 * 纪律：只服务弹出面板（/context 弹框、文本预览）；transcript 工具卡保持白描树线不套框。
 * 几何行截断一律用 ""（结构不被 … 破坏），正文行才用 "…"。
 */

/** 圆角框主题面（Pi theme 的最小子集）。 */
export type FrameTheme = {
	fg(color: string, text: string): string;
	bold?: (text: string) => string;
};

/** 低于此宽度放弃画框，退化为平铺文本（窄降级思想重写自 mcode panel-frame）。 */
export const FRAME_MIN_WIDTH = 12;

export type FrameHeaderOptions = {
	/**
	 * 右端元信息（如 `[esc]`）：渲染为 `… [esc]╮`，5 列宽、贴 width-6..width-2——
	 * 与 escCloseHitbox 的 `left+width-5 .. left+width-1` 精确对齐。
	 */
	meta?: string;
	/** meta 颜色（hover 可换 text）。默认 muted。 */
	metaColor?: string;
	/** 标题颜色，默认 accent。 */
	titleColor?: string;
};

/**
 * 圆角框顶边，标题嵌框：`╭─ Context Usage ───── [esc]╮`。
 * 标题过长按可见列截断（""省略号）；窄于 FRAME_MIN_WIDTH 退化为裸标题行。
 */
export function frameHeader(
	theme: FrameTheme,
	width: number,
	title: string,
	options: FrameHeaderOptions = {},
): string {
	const safe = Math.max(0, Math.floor(width));
	const { meta, metaColor = "muted", titleColor = "accent" } = options;
	if (safe < FRAME_MIN_WIDTH) return truncateToWidth(title, safe, "");
	const metaWidth = meta ? visibleWidth(meta) : 0;
	// `╭─ ` 3 + title + ` ` 1 + fill + (meta 前 ` ` 1 + meta) + `╮` 1；
	// 标题预算额外留 1 列给最小 fill，保证 `─` 分隔不消失。
	const budget = Math.max(0, meta ? safe - 7 - metaWidth : safe - 6);
	const clipped = truncateToWidth(title, budget, "");
	const styledTitle = theme.fg(
		titleColor,
		typeof theme.bold === "function" ? theme.bold(clipped) : clipped,
	);
	const fillCount = Math.max(1, (meta ? safe - 6 - metaWidth : safe - 5) - visibleWidth(clipped));
	const metaPart = meta ? ` ${theme.fg(metaColor, meta)}` : "";
	return `╭─ ${styledTitle} ${"─".repeat(fillCount)}${metaPart}╮`;
}

/**
 * 内容行：`│ content │`，正文预算 width-4（两侧各 1 列留白）。
 * 超宽正文 "…" 截断；窄于 FRAME_MIN_WIDTH 退化为裸正文。
 */
export function frameRow(
	theme: FrameTheme,
	width: number,
	content: string,
	color = "border",
): string {
	const safe = Math.max(0, Math.floor(width));
	if (safe < FRAME_MIN_WIDTH) return truncateToWidth(content, safe, "");
	const inner = Math.max(0, safe - 4);
	const body = truncateToWidth(content, inner, "…");
	const pad = " ".repeat(Math.max(0, inner - visibleWidth(body)));
	return `${theme.fg(color, "│")} ${body}${pad} ${theme.fg(color, "│")}`;
}

/** 中缝分隔线 `├───┤`；窄于 FRAME_MIN_WIDTH 退化为空（无框平铺不画横线）。 */
export function frameDivider(theme: FrameTheme, width: number, color = "border"): string {
	const safe = Math.max(0, Math.floor(width));
	if (safe < FRAME_MIN_WIDTH) return "";
	return theme.fg(color, `├${"─".repeat(Math.max(0, safe - 2))}┤`);
}

/** 底边 `╰───╯`；窄于 FRAME_MIN_WIDTH 退化为空。 */
export function frameBottom(theme: FrameTheme, width: number, color = "border"): string {
	const safe = Math.max(0, Math.floor(width));
	if (safe < FRAME_MIN_WIDTH) return "";
	return theme.fg(color, `╰${"─".repeat(Math.max(0, safe - 2))}╯`);
}
