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

/** 切分输出尾窗口；空输出 total 为 0 且 tail 为空（调用方回落 Pending）。 */
export function bashLivePreview(text: string, limit: number): BashLivePreview {
	const normalized = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
	if (!normalized.trim()) return { total: 0, header: null, tail: [] };
	const all = normalized.split("\n");
	const tail = all.slice(Math.max(0, all.length - Math.max(1, limit)));
	const hidden = all.length - tail.length;
	return {
		total: all.length,
		header: hidden > 0 ? `… (${hidden} earlier lines)` : null,
		tail,
	};
}
