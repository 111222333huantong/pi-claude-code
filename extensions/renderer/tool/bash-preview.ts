/** bash live 尾预览：执行中取输出尾部 N 行，落定后保留。纯函数。 */

/** 默认尾窗口行数（liveToolPreviewLines 未配置时）。 */
export const BASH_LIVE_PREVIEW_LINES = 5;

export type BashLivePreview = {
	/** 输出总行数（去尾空行后）。 */
	total: number;
	/** 截断提示头（`… (M earlier lines)`），未截断时为 null。 */
	header: string | null;
	/** 尾窗口行（原文顺序）。 */
	tail: string[];
};

/**
 * 从末尾反向找到最后 `limit` 行的起点。
 * 只扫描尾部，不 split 整个输出；长命令流式刷新时不再反复分配全量行数组。
 */
function tailStartIndex(text: string, limit: number): number {
	let position = text.length;
	let lines = 0;
	while (lines < limit) {
		if (position <= 0) return 0;
		const newline = text.lastIndexOf("\n", position - 1);
		if (newline < 0) return 0;
		lines++;
		position = newline;
	}
	return position + 1;
}

function countNewlines(text: string): number {
	let count = 0;
	let index = text.indexOf("\n");
	while (index !== -1) {
		count++;
		index = text.indexOf("\n", index + 1);
	}
	return count;
}

/** 上一次输入 → 结果缓存：同一帧重复渲染直接复用，不必再扫一遍。 */
let lastPreview: { text: string; limit: number; result: BashLivePreview } | null = null;

/** 切分输出尾窗口；空输出 total 为 0 且 tail 为空（调用方回落 Pending）。 */
export function bashLivePreview(text: string, limit: number): BashLivePreview {
	const safeLimit = Math.max(1, limit);
	if (lastPreview?.limit === safeLimit && lastPreview.text === text) {
		return lastPreview.result;
	}

	const normalized = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
	if (!/\S/.test(normalized)) {
		const result: BashLivePreview = { total: 0, header: null, tail: [] };
		lastPreview = { text, limit: safeLimit, result };
		return result;
	}

	const total = countNewlines(normalized) + 1;
	const start = tailStartIndex(normalized, safeLimit);
	const tail = normalized.slice(start).split("\n");
	const hidden = total - tail.length;
	const result: BashLivePreview = {
		total,
		header: hidden > 0 ? `… (${hidden} earlier lines)` : null,
		tail,
	};
	lastPreview = { text, limit: safeLimit, result };
	return result;
}
