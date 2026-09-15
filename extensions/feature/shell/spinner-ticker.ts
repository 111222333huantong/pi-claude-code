/**
 * Shared tickers — 90ms for glyph/thinking, 16ms for 60fps shimmer.
 * 90ms drives the spinner glyph (180ms via 2 ticks); 16ms drives the verb
 * shimmer sweep. Both timers are unref'd and auto-stop with no subscribers.
 *
 * Ported from cc-my-pi's ticker.ts (MIT, Tim van den Hoorn / FammasMaz).
 */

let timer: ReturnType<typeof setInterval> | null = null;
const subs = new Set<() => void>();

let shimmerTimer: ReturnType<typeof setInterval> | null = null;
const shimmerSubs = new Set<() => void>();

function ensure(): void {
	if (timer) return;
	timer = setInterval(() => {
		for (const fn of [...subs]) {
			try {
				fn();
			} catch {
				/* ignore */
			}
		}
	}, 90);
	(timer as any)?.unref?.();
}

function maybeStop(): void {
	if (subs.size === 0 && timer) {
		clearInterval(timer);
		timer = null;
	}
}

function ensureShimmer(): void {
	if (shimmerTimer) return;
	shimmerTimer = setInterval(() => {
		for (const fn of [...shimmerSubs]) {
			try {
				fn();
			} catch {
				/* ignore */
			}
		}
	}, 16);
	(shimmerTimer as any)?.unref?.();
}

function maybeStopShimmer(): void {
	if (shimmerSubs.size === 0 && shimmerTimer) {
		clearInterval(shimmerTimer);
		shimmerTimer = null;
	}
}

export function subscribeTicker(fn: () => void): () => void {
	subs.add(fn);
	ensure();
	return () => {
		subs.delete(fn);
		maybeStop();
	};
}

export function subscribeShimmer(fn: () => void): () => void {
	shimmerSubs.add(fn);
	ensureShimmer();
	return () => {
		shimmerSubs.delete(fn);
		maybeStopShimmer();
	};
}

/**
 * 跨 `/reload` 的代际防抖（抄 cc-my-pi `LOADER_GENERATION` 思想）。
 *
 * reload 会重跑扩展入口（新闭包重新订阅），但旧模块实例的 interval
 * 可能仍在跑、旧订阅仍指向已失效的 ctx。每次安装时调
 * `claimTickerGeneration()` 领新代际，tick 回调里用
 * `isStaleTickerGeneration(captured)` 自检：过期即自退订并停调，
 * 避免旧实例每 16ms 往失效 UI 写。
 */
const TICKER_GENERATION_KEY = Symbol.for("pi-claude-code.ticker-generation");

export function claimTickerGeneration(): number {
	const host = globalThis as Record<symbol, unknown>;
	const next =
		(typeof host[TICKER_GENERATION_KEY] === "number"
			? (host[TICKER_GENERATION_KEY] as number)
			: 0) + 1;
	host[TICKER_GENERATION_KEY] = next;
	return next;
}

export function isStaleTickerGeneration(captured: number): boolean {
	const host = globalThis as Record<symbol, unknown>;
	return host[TICKER_GENERATION_KEY] !== captured;
}

/** Test helper — force stop. */
export function _resetTicker(): void {
	if (timer) {
		clearInterval(timer);
		timer = null;
	}
	if (shimmerTimer) {
		clearInterval(shimmerTimer);
		shimmerTimer = null;
	}
	subs.clear();
	shimmerSubs.clear();
}
