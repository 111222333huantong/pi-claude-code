/**
 * 平滑离散的 token 目标值，供 working 行 token 芯片逐帧上升。
 *
 * provider 一次 SSE 增量常是 40–110 字符（≈10–30 tokens），直接把目标值
 * 写进 working 行，芯片就会整段跳一次。这里缓存一个显示值：目标上涨时按
 * 指数缓动逼近（每帧至少 +1），回合中途 provider 的偏小修正值不让芯片倒
 * 退，只有目标清零（换回合）时才归位，既跟得上真实速率，又能看到数字逐帧
 * 往上走。
 */

/** 缓动时间常数；越大越慢，250ms 在 60fps 下大约每帧 1–2 tokens。 */
export const DEFAULT_SMOOTHING_TAU_MS = 250;

export type TokenSmoother = {
	/** 给定时刻的目标值，返回该时刻应显示的整数 token 数。 */
	next(target: number, now?: number): number;
};

export function createTokenSmoother(tauMs = DEFAULT_SMOOTHING_TAU_MS): TokenSmoother {
	let displayed = 0;
	let at = 0;
	const tau = Math.max(1, tauMs);
	return {
		next(target: number, now = Date.now()): number {
			if (!Number.isFinite(target) || target <= 0) {
				displayed = 0;
				at = now;
				return 0;
			}
			// 首个样本：从真实值开始，避免从 0 慢慢爬。
			if (displayed <= 0) {
				displayed = target;
				at = now;
				return Math.ceil(target);
			}
			// provider 在消息中途偶尔会给出偏小的修正值（例如 text_end 的
			// 全文比流式增量短）。回合进行中保持单调，不让芯片倒退重爬；
			// 真正的换回合由 target = 0 归位。
			if (target < displayed) {
				at = now;
				return Math.max(1, Math.floor(displayed));
			}
			const dt = Math.max(0, now - at);
			at = now;
			const gap = target - displayed;
			if (gap <= 0) return Math.floor(displayed);
			const step = Math.max(1, gap * (1 - Math.exp(-dt / tau)));
			displayed = Math.min(target, displayed + step);
			return Math.max(1, Math.floor(displayed));
		},
	};
}
