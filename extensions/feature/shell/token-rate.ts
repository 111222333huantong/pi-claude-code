/**
 * 本回合平均输出速率 + TTFT 的共享状态：working-message 负责采集，footer 负责显示。
 *
 * 口径：整回合墙钟平均（工具等待也计入分母），与滑动窗口瞬时速率（pi-tps-status）
 * 区分，显示带 `avg` 前缀。
 * TTFT：turn_start 到本回合第一个内容块（text/thinking/toolcall）开始的毫秒数，
 * 同一回合内只记第一次，定格后保留到下一回合覆盖。
 */

let turnStartTime = 0;
let lastRate = 0;
let firstTokenAt = 0;

/** 新回合开始：重置计时、上回合定格值与 TTFT。 */
export function resetTokenRate(startAt = 0): void {
	turnStartTime = startAt;
	lastRate = 0;
	firstTokenAt = 0;
}

/** 本回合第一个内容块开始时调用；同一回合后续消息不覆盖。 */
export function markFirstToken(now = Date.now()): void {
	if (turnStartTime && !firstTokenAt) firstTokenAt = now;
}

/** 每个 message_update 采样一次：token 数 + 该次采样的耗时；0 token 不覆盖定格值。 */
export function sampleTokenRate(tokens: number, now = Date.now()): void {
	if (!turnStartTime || tokens <= 0) return;
	const elapsed = (now - turnStartTime) / 1000;
	if (elapsed <= 0) return;
	lastRate = tokens / elapsed;
}

/** 当前显示值：回合中为实时平均，回合外为上一回合定格值。 */
export function currentTokenRate(): number {
	return lastRate;
}

/** 本回合 TTFT（毫秒）；未出首 token 或无活动回合返回 0。定格后保留。 */
export function currentTtftMs(): number {
	if (!turnStartTime || !firstTokenAt) return 0;
	return Math.max(0, firstTokenAt - turnStartTime);
}

/** `avg 1.2k tok/s (TTFT: 812ms)`；无数据显示空串，未出首 token 时无括号段。 */
export function formatTokenRate(rate: number, ttftMs = 0): string {
	if (!Number.isFinite(rate) || rate <= 0) return "";
	const value = rate >= 1000 ? `${(rate / 1000).toFixed(1)}k` : `${Math.round(rate)}`;
	const ttft = Number.isFinite(ttftMs) && ttftMs > 0 ? ` (TTFT: ${Math.round(ttftMs)}ms)` : "";
	return `avg ${value} tok/s${ttft}`;
}
