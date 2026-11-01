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

/** 去掉尾部换行后的长度（不分配新字符串）。 */
function trimmedEnd(text: string): number {
	let end = text.length;
	while (end > 0 && text.charCodeAt(end - 1) === 10) end--;
	return end;
}

type PreviewCache = {
	text: string;
	/** 去掉尾部换行后的文本；流式追加时作为前缀比较基准。 */
	normalized: string;
	limit: number;
	total: number;
	result: BashLivePreview;
};

/** 上一次输入 → 结果缓存：同一帧重复渲染直接复用，不必再扫一遍。 */
let lastPreview: PreviewCache | null = null;

/** 切分输出尾窗口；空输出 total 为 0 且 tail 为空（调用方回落 Pending）。 */
export function bashLivePreview(text: string, limit: number): BashLivePreview {
	const safeLimit = Math.max(1, limit);
	if (lastPreview?.limit === safeLimit && lastPreview.text === text) {
		return lastPreview.result;
	}

	// 流式追加快路径：新输出以旧输出为前缀时只扫新增后缀，不再重数 6MB 换行。
	// 含 CR 的输入语义不同（全局替换会改变偏移），保持全量慢路径。
	if (text.indexOf("\r") === -1 && lastPreview) {
		const previous = lastPreview;
		const end = trimmedEnd(text);
		if (
			previous.limit === safeLimit &&
			previous.total > 0 &&
			end >= previous.normalized.length &&
			// slice 比较比 startsWith 快一个数量级（V8 对切片走 memcmp 快路径）。
			text.slice(0, previous.normalized.length) === previous.normalized
		) {
			const delta =
				end > previous.normalized.length ? text.slice(previous.normalized.length, end) : "";
			const normalized = end === text.length ? text : text.slice(0, end);
			const total = previous.total + countNewlines(delta);
			const combined = `${previous.result.tail.join("\n")}${delta}`.split("\n");
			const tail = combined.length > safeLimit ? combined.slice(-safeLimit) : combined;
			const hidden = total - tail.length;
			const result: BashLivePreview = {
				total,
				header: hidden > 0 ? `… (${hidden} earlier lines)` : null,
				tail,
			};
			lastPreview = { text, normalized, limit: safeLimit, total, result };
			return result;
		}
	}

	// 只有含 CR 才走全局替换；末尾换行手动回退，避免正则从字符串开头扫一遍。
	const normalized = text.indexOf("\r") === -1 ? text : text.replace(/\r\n?/g, "\n");
	const end = trimmedEnd(normalized);
	if (!/\S/.test(normalized.slice(0, end))) {
		const result: BashLivePreview = { total: 0, header: null, tail: [] };
		lastPreview = { text, normalized: "", limit: safeLimit, total: 0, result };
		return result;
	}

	const trimmed = end === normalized.length ? normalized : normalized.slice(0, end);
	const total = countNewlines(trimmed) + 1;
	const start = tailStartIndex(trimmed, safeLimit);
	const tail = trimmed.slice(start).split("\n");
	const hidden = total - tail.length;
	const result: BashLivePreview = {
		total,
		header: hidden > 0 ? `… (${hidden} earlier lines)` : null,
		tail,
	};
	lastPreview = { text, normalized: trimmed, limit: safeLimit, total, result };
	return result;
}
