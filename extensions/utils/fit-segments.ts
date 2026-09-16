import { visibleWidth } from "@earendil-works/pi-tui";

export type FitSegment = {
	/** 段文本（纯文本列宽；调用方自行处理样式映射）。 */
	text: string;
	/** 优先级：数字越大越后被牺牲。 */
	priority: number;
	/** 第一步整体替换的紧凑形（如 detail 置 ""）；缺省为不压缩直接进截断。 */
	compactText?: string;
	/** 段内截断；缺省为末尾截断加省略号。 */
	truncate?: (text: string, maxWidth: number, ellipsis: string) => string;
};

/** 缺省段截断：保留头部，超宽追加省略号（CJK 按列宽）。 */
export function truncateSegmentEnd(text: string, maxWidth: number, ellipsis = "…"): string {
	if (visibleWidth(text) <= maxWidth) return text;
	if (maxWidth <= 0) return "";
	const mark = visibleWidth(ellipsis) <= maxWidth ? ellipsis : "";
	const budget = Math.max(0, maxWidth - visibleWidth(mark));
	let head = "";
	for (const char of Array.from(text)) {
		if (visibleWidth(head + char) > budget) break;
		head += char;
	}
	return `${head}${mark}`;
}

/**
 * 按优先级把多段塞进 maxWidth（思想重写自 pi-open-tui fitSegmentsByPriority）：
 * 先整体压缩（低优先级先行），再从最低优先级起逐段截断/丢弃，
 * 存活段按原序返回（调用方决定 joiner）。
 */
export function fitSegmentsByPriority(
	segments: readonly FitSegment[],
	maxWidth: number,
	ellipsis = "…",
	/** 段间分隔列宽（空格 join 传 1，直接拼接传 0）。 */
	separatorWidth = 1,
): string[] {
	if (maxWidth <= 0) return [];
	const gap = Math.max(0, separatorWidth);
	const items = segments.map((segment) => ({
		text: segment.text,
		compactText: segment.compactText,
		priority: segment.priority,
		truncate: segment.truncate,
		width: visibleWidth(segment.text),
	}));
	const totalWidth = () => {
		const active = items.filter((item) => item.text !== "");
		return active.reduce((sum, item) => sum + item.width, 0) + Math.max(0, active.length - 1) * gap;
	};
	// totalWidth 含段间 1 列分隔；调用方 joiner 为 "" 时多算的分隔由截断循环自然消化。
	if (totalWidth() <= maxWidth) return items.map((item) => item.text);
	// 第一步：低优先级先行整体压缩（如 detail 整体丢弃）。
	const byPriority = [...items].sort((a, b) => a.priority - b.priority);
	for (const item of byPriority) {
		if (item.compactText === undefined || visibleWidth(item.compactText) >= item.width) continue;
		item.text = item.compactText;
		item.width = visibleWidth(item.text);
		if (totalWidth() <= maxWidth) break;
	}
	while (totalWidth() > maxWidth) {
		let target = -1;
		for (let i = 0; i < items.length; i++) {
			const current = items[i]!;
			if (current.text === "") continue;
			if (target === -1 || current.priority < items[target]!.priority) target = i;
		}
		if (target === -1) break;
		const others = items.filter((_, i) => i !== target && items[i]!.text !== "");
		const othersWidth =
			others.reduce((sum, item) => sum + item.width, 0) + Math.max(0, others.length - 1) * gap;
		const rest = items[target]!;
		const available = maxWidth - othersWidth - (others.length > 0 ? gap : 0);
		if (available <= Math.max(1, visibleWidth(ellipsis))) {
			rest.text = "";
			rest.width = 0;
			continue;
		}
		if (available < rest.width) {
			const truncate = rest.truncate ?? truncateSegmentEnd;
			rest.text = truncate(rest.text, available, ellipsis);
			rest.width = visibleWidth(rest.text);
			continue;
		}
		break;
	}
	return items.filter((item) => item.text !== "").map((item) => item.text);
}
