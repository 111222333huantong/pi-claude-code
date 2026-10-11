/**
 * footer 输出速率的共享状态：working-message 负责采集，footer 负责显示。
 *
 * average：一次用户指令的墙钟平均（工具等待计入分母），显示 `avg`。
 * live：最近一个窗口的瞬时速率（工具等待暂停计时），显示 `live`；指令结束定格为整段平均。
 * Pi 的 turn 是单次 assistant 消息，工具调用结束会开新 turn。token 跨 turn 累加，
 * 计时与 TTFT 直到下一条用户指令才重置。
 * TTFT：用户指令开始到第一个内容块（text/thinking/toolcall）开始的毫秒数，
 * 同一指令内只记第一次，定格后保留到下一条指令覆盖。
 */

export type TokenRateMode = "average" | "live";

const LIVE_WINDOW_MS = 1_000;
const MIN_SPAN_MS = 250;

interface TokenSample {
	t: number;
	cum: number;
}

let runStartTime = 0;
let carriedTokens = 0;
let pauseStartedAt = 0;
let lastRate = 0;
let lastLiveRate = 0;
let firstTokenAt = 0;
let samples: TokenSample[] = [];

/** 新的用户指令：重置计时、累计 token、定格值与 TTFT。 */
export function resetTokenRate(startAt = 0): void {
	runStartTime = startAt;
	carriedTokens = 0;
	pauseStartedAt = 0;
	lastRate = 0;
	lastLiveRate = 0;
	firstTokenAt = 0;
	samples = [];
}

/**
 * 一段 assistant 回复结束：保留计时与 TTFT，把本段已计 token 结算进累计。
 * 下一段的 token 从 0 重计，采样时加回来。
 */
export function carryTokenRate(tokens: number): void {
	if (tokens > 0) carriedTokens += tokens;
}

/** 工具开始执行：暂停实时采样，工具等待不进瞬时速率。 */
export function pauseTokenRate(now = Date.now()): void {
	if (!runStartTime || pauseStartedAt) return;
	pauseStartedAt = now;
}

/** 工具执行结束：恢复实时采样。 */
export function resumeTokenRate(): void {
	pauseStartedAt = 0;
}

/** 本指令第一个内容块开始时调用；同一指令后续消息不覆盖。 */
export function markFirstToken(now = Date.now()): void {
	if (runStartTime && !firstTokenAt) firstTokenAt = now;
}

/** 每个 message_update 采样一次。本段 0 token 不覆盖已显示的速率。 */
export function sampleTokenRate(tokens: number, now = Date.now()): void {
	if (!runStartTime || tokens <= 0) return;
	const total = carriedTokens + tokens;
	const elapsed = (now - runStartTime) / 1000;
	if (elapsed > 0) lastRate = total / elapsed;

	if (pauseStartedAt) {
		samples = [];
		return;
	}
	samples.push({ t: now, cum: total });
	const cutoff = now - LIVE_WINDOW_MS;
	while (samples.length > 1 && samples[0]!.t < cutoff) samples.shift();
	if (samples.length < 2) return;
	const first = samples[0]!;
	const last = samples[samples.length - 1]!;
	const span = last.t - first.t;
	if (span < MIN_SPAN_MS) return;
	lastLiveRate = ((last.cum - first.cum) * 1000) / span;
}

/** average 的当前值：指令中为实时平均，指令外为上一段定格值。 */
export function currentTokenRate(): number {
	return lastRate;
}

/**
 * 按显示模式取值。live 在生成中取窗口速率，生成空档与指令结束后回到整段平均。
 * 窗口还不够 250ms 时也回退到平均，避免一闪而过的空值。
 */
export function displayTokenRate(mode: TokenRateMode): number {
	if (mode === "live" && !pauseStartedAt && samples.length >= 2 && lastLiveRate > 0) {
		return lastLiveRate;
	}
	return lastRate;
}

/** 本指令 TTFT（毫秒）；未出首 token 或无活动指令返回 0。定格后保留。 */
export function currentTtftMs(): number {
	if (!runStartTime || !firstTokenAt) return 0;
	return Math.max(0, firstTokenAt - runStartTime);
}

/** `avg 1.2k tok/s (TTFT: 812ms)`；无数据显示空串，未出首 token 时无括号段。 */
export function formatTokenRate(rate: number, ttftMs = 0, mode: TokenRateMode = "average"): string {
	if (!Number.isFinite(rate) || rate <= 0) return "";
	const value = rate >= 1000 ? `${(rate / 1000).toFixed(1)}k` : `${Math.round(rate)}`;
	const ttft = Number.isFinite(ttftMs) && ttftMs > 0 ? ` (TTFT: ${Math.round(ttftMs)}ms)` : "";
	const label = mode === "live" ? "live" : "avg";
	return `${label} ${value} tok/s${ttft}`;
}
