/**
 * Shared tickers — 90ms for glyph/thinking, 16ms for 60fps shimmer.
 * 90ms drives the spinner glyph (180ms via 2 ticks); 16ms drives the verb
 * shimmer sweep. Both timers are unref'd and auto-stop with no subscribers.
 *
 * Ported from cc-my-pi's ticker.ts (MIT, Tim van den Hoorn / FammasMaz).
 */

let tick = 0;
let timer: ReturnType<typeof setInterval> | null = null;
const subs = new Set<() => void>();

let shimmerTick = 0;
let shimmerTimer: ReturnType<typeof setInterval> | null = null;
const shimmerSubs = new Set<() => void>();

function ensure(): void {
	if (timer) return;
	timer = setInterval(() => {
		tick++;
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
		shimmerTick++;
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

export function getTick(): number {
	return tick;
}

export function getShimmerTick(): number {
	return shimmerTick;
}

/** Test helper — how many active subscribers. */
export function _tickerSubCount(): number {
	return subs.size + shimmerSubs.size;
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
	tick = 0;
	shimmerTick = 0;
}
