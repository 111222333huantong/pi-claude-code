/**
 * Compaction 进行态增强：把 Pi 原生的 `Compacting context...` 状态行升级为
 * 带进度条与耗时的加载行，并在结束后把压缩规模信息回填给压缩卡片标题。
 *
 * Pi 的 `CompactionStatusIndicator extends StatusIndicator extends Loader`：
 * 实例放进 `statusContainer`（或 0.85+ 内嵌 editor 边框）后由 Loader 自己的
 * ~80ms interval 驱动 `updateDisplay`。这里再包一层 `updateDisplay`：
 * `kind === "compaction"` 且压缩在途时把 message 换成进度条文本，其余透传
 * 给链上下一层实现（working-message 的 glyph patch 或原生）。
 *
 * 进度模型（时间渐近条）：
 * compaction 的摘要请求走 `modelRuntime.streamSimple`，不经过
 * `provider_stream_event` 回调（那只在 agent 主回合的 streamFn 上挂着），
 * token 级信号拿不到，做不了真 determinate 进度。改用时间渐近曲线：
 * `progress = HARD_CEILING × (1 − exp(−elapsed/expectedMs))`，
 * `expectedMs` 用上一次压缩的实际耗时（缺省 30s，钳 5–120s）。
 * 前期走快、尾部越走越慢，永远不到 95% 上限——超时也不定格，曲线仍在爬。
 * 完成由 session_compact 收口（条消失/卡片出现），不做 100% 定格：
 * Pi 的 compaction_end UI 事件同 tick clearStatusIndicator → dispose，
 * 定格根本走不到。
 */
import { type ExtensionAPI, estimateTokens } from "@earendil-works/pi-coding-agent";
import { Loader } from "@earendil-works/pi-tui";
import { config } from "../config/config.ts";
import { formatDuration } from "../utils/format.ts";
import { interruptShortcutText } from "../utils/key-hints.ts";
import { patchRegistry } from "../utils/patch-keys.ts";

const COMPACTION_PROGRESS_PATCH = Symbol.for("pi.ccstyle.compaction-progress-patch");

/** 进度条宽度（字符数）。 */
const BAR_WIDTH = 14;
/** 进度条显示的绝对上限：等真实完成才收条，永不显示 100%。 */
const HARD_CEILING = 0.95;
/** 首次压缩前的缺省预期耗时（毫秒），之后用上次实际耗时。 */
const DEFAULT_EXPECTED_MS = 30_000;
/** 预期耗时的合理区间：超出则钳制，避免一次异常压缩带偏后续节奏。 */
const MIN_EXPECTED_MS = 5_000;
const MAX_EXPECTED_MS = 120_000;

type CompactionReason = "manual" | "threshold" | "overflow" | string;

type ProgressState = {
	active: boolean;
	reason: CompactionReason;
	startedAt: number;
};

const state: ProgressState = {
	active: false,
	reason: "manual",
	startedAt: 0,
};

/** 上一次压缩的实际耗时，作为本次时间轴的预期（缺省 30s）。 */
let lastDurationMs = DEFAULT_EXPECTED_MS;

/**
 * 最近一次压缩的结果记录，按 `tokensBefore`（Pi 自报值）作 key。
 * 卡片标题渲染时（compaction_end → addMessageToChat 同一 tick）即可查到。
 * resume 的旧条目没有记录，标题退回只显示 before。
 *
 * `reportedBefore`：Pi 写入 compactionEntry.tokensBefore 的自报值，
 *   某些 provider（swe-2 等）usage 漏报导致它偏小；
 * `correctedBefore`：本次压缩 preparation.messagesToSummarize 的本地累加值，
 *   在 session_compact 时计算，作为显示用 before；
 * `after`：压缩后 token 数（LLM usage 实测 + 估算）。
 */
type CompactionRecord = {
	reportedBefore: number;
	correctedBefore: number | undefined;
	after: number;
};
const compactionAfterByTokens = new Map<number, CompactionRecord>();

/** session_before_compact 暂存的 preparation.messagesToSummarize，
 *  供 session_compact 时本地估算 before。 */
let pendingSummarizeMessages: readonly unknown[] | null = null;

/** 粗估 summary token 数：英文 ≈4 字符/token，与 pi 内部估算口径同阶。 */
export function estimateSummaryTokens(summary: string): number {
	return Math.ceil((summary ?? "").length / 4);
}

export function recordCompactionResult(
	tokensBefore: number,
	tokensAfter: number,
	correctedBefore?: number,
): void {
	if (!Number.isFinite(tokensBefore) || !Number.isFinite(tokensAfter)) return;
	compactionAfterByTokens.set(Math.round(tokensBefore), {
		reportedBefore: Math.round(tokensBefore),
		correctedBefore:
			correctedBefore !== undefined && Number.isFinite(correctedBefore)
				? Math.round(correctedBefore)
				: undefined,
		after: Math.round(tokensAfter),
	});
	if (compactionAfterByTokens.size > 64) {
		const firstKey = compactionAfterByTokens.keys().next().value;
		if (firstKey !== undefined) compactionAfterByTokens.delete(firstKey);
	}
}

/** message-display 标题用：已知压缩前 token 数时返回 { correctedBefore, after }。 */
export function lookupTokensAfter(
	tokensBefore: number,
): { correctedBefore: number; after: number } | undefined {
	const record = compactionAfterByTokens.get(Math.round(tokensBefore));
	if (!record) return undefined;
	// correctedBefore 显著大于 reported（>1.5×）时认为 provider 漏报，显示修正值；
	// 否则保留原值，避免估算误差覆盖正常 provider 的精确值。
	const before =
		record.correctedBefore !== undefined && record.correctedBefore > record.reportedBefore * 1.5
			? record.correctedBefore
			: record.reportedBefore;
	return { correctedBefore: before, after: record.after };
}

/**
 * 时间渐近进度（0–HARD_CEILING）：`1 − exp(−elapsed/expectedMs)`。
 * expectedMs 用上一次实际耗时：压缩耗时稳定时曲线与实际节奏同步；
 * 超时时进度仍缓慢爬升，不会在某一格停死。
 */
export function computeProgress(elapsedMs: number): number {
	const expectedMs = Math.min(MAX_EXPECTED_MS, Math.max(MIN_EXPECTED_MS, lastDurationMs));
	if (elapsedMs <= 0) return 0;
	return HARD_CEILING * (1 - Math.exp(-elapsedMs / expectedMs));
}

/**
 * 渲染一帧进度条。`elapsedMs` 由调用方给（测试友好）。
 * 返回 `■■■■■□□□□□□□□□ 34%`。
 */
export function barFrame(elapsedMs: number): string {
	const progress = computeProgress(elapsedMs);
	const filled = Math.round(progress * BAR_WIDTH);
	let bar = "";
	for (let i = 0; i < BAR_WIDTH; i++) {
		bar += i < filled ? "■" : "□";
	}
	const percent = Math.round(progress * 100);
	return `${bar} ${percent}%`;
}

function reasonPrefix(reason: CompactionReason): string {
	if (reason === "overflow") return "Context overflow — auto-compacting";
	if (reason === "threshold") return "Auto-compacting";
	return "Compacting context";
}

function buildProgressMessage(now = Date.now()): string {
	const elapsed = Math.max(0, now - state.startedAt);
	const parts = [
		`${reasonPrefix(state.reason)}… ${barFrame(elapsed)}`,
		formatDuration(elapsed) || "0s",
		`${interruptShortcutText()} to cancel`,
	];
	return parts.join(" · ");
}

function installLoaderPatch(): () => void {
	const previous = patchRegistry.get<{ dispose: () => void }>(COMPACTION_PROGRESS_PATCH);
	if (previous) previous.dispose();
	const proto = (Loader as any)?.prototype;
	if (!proto || typeof proto.updateDisplay !== "function") {
		// pi-tui 内部结构变了就降级：打一次 warn，不静默失效
		try {
			console.warn?.("[pi-claude-code] Loader.updateDisplay missing; compaction progress disabled");
		} catch {}
		return () => {};
	}
	// 当前值即链上下一层（可能是原生 updateDisplay，也可能已被
	// working-message 换成 glyph 版）；直接改 this.message 后透传，
	// 下一层照旧负责 spinner glyph 与颜色。
	const inner = proto.updateDisplay;
	const installed = function (this: any) {
		if (state.active && this?.kind === "compaction") {
			this.message = buildProgressMessage();
		}
		return inner.call(this);
	};
	proto.updateDisplay = installed;
	const patch = {
		dispose: () => {
			if (proto.updateDisplay === installed) proto.updateDisplay = inner;
			patchRegistry.dispose(COMPACTION_PROGRESS_PATCH, patch);
		},
	};
	patchRegistry.install(COMPACTION_PROGRESS_PATCH, patch);
	return patch.dispose;
}

export default function compactionProgress(pi: ExtensionAPI): void {
	if (!config.enableCompactionProgress) return;
	const disposePatch = installLoaderPatch();

	pi.on("session_before_compact", async (event: any) => {
		state.active = true;
		// 暂存 preparation.messagesToSummarize 供 session_compact 时本地累加
		pendingSummarizeMessages = Array.isArray(event?.preparation?.messagesToSummarize)
			? event.preparation.messagesToSummarize
			: null;
		state.reason = (event?.reason as CompactionReason) ?? "manual";
		state.startedAt = Date.now();
	});

	pi.on("session_compact", async (event: any) => {
		const now = Date.now();
		if (state.startedAt > 0) lastDurationMs = now - state.startedAt;
		const entry = event?.compactionEntry;
		const tokensBefore = Number(entry?.tokensBefore);
		// 用 preparation.messagesToSummarize 本地累加修正 before：
		// provider usage 漏报时（swe-2 等）文件里的 tokensBefore 偏小，
		// 显示层用修正值让 "Compacted from X → Y" 数据自洽。
		let correctedBefore: number | undefined;
		if (pendingSummarizeMessages && pendingSummarizeMessages.length > 0) {
			try {
				let sum = 0;
				for (const msg of pendingSummarizeMessages) sum += estimateTokens(msg as any);
				if (sum > 0) correctedBefore = sum;
			} catch {
				correctedBefore = undefined;
			}
		}
		pendingSummarizeMessages = null;
		if (Number.isFinite(tokensBefore) && entry?.usage) {
			const { output_tokens, cache_creation_input_tokens } = entry.usage;
			const tokensAfter = output_tokens + (cache_creation_input_tokens ?? 0);
			recordCompactionResult(tokensBefore, tokensAfter, correctedBefore);
		} else {
			recordCompactionResult(
				tokensBefore,
				estimateSummaryTokens(String(entry?.summary ?? "")),
				correctedBefore,
			);
		}
		// Pi 的 compaction_end UI 事件同步 clearStatusIndicator → indicator.dispose()，
		// ticker 立刻停。直接关，不做定格。
		state.active = false;
	});
	const stop = async () => {
		state.active = false;
		pendingSummarizeMessages = null;
	};
	pi.on("session_compact_failed", stop);
	pi.on("session_shutdown", async () => {
		state.active = false;
		pendingSummarizeMessages = null;
		disposePatch();
	});
}
