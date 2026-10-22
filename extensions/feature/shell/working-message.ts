import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Loader, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { config } from "../../config/config.ts";
import { formatDuration, formatTokens } from "../../utils/format.ts";
import { interruptShortcutText } from "../../utils/key-hints.ts";
import { hexToFgAnsi, RESET } from "./spinner-color.ts";
import {
	loaderDebugStats,
	logSpinnerError,
	logSpinnerInstall,
	spinnerLog,
} from "./spinner-debug.ts";
import { readSpinnerSettings, spinnerModuleEnabled } from "./spinner-settings.ts";
import { colorSweep, getShimmerIntervalMs, resolveShimmerColors } from "./spinner-shimmer.ts";
import {
	claimTickerGeneration,
	isStaleTickerGeneration,
	subscribeShimmer,
	subscribeTicker,
} from "./spinner-ticker.ts";
import { pickVerb } from "./spinner-verbs.ts";
import {
	carryTokenRate,
	lastTokenAt,
	markFirstToken,
	pauseTokenRate,
	recordProviderUsage,
	resetTokenRate,
	resumeTokenRate,
	sampleTokenDelta,
	startMessageSegment,
} from "./token-rate.ts";

type ContentBlock = {
	type?: unknown;
	text?: unknown;
	thinkingSignature?: { body?: unknown };
};

type StreamMessage = {
	content?: unknown;
	usage?: { output?: unknown };
};

/** 每个 content index 的可见文本/思考长度；无对应块的 index 保持稀疏洞。 */
function textBlockLengths(message: StreamMessage): number[] {
	const content = message.content;
	if (!Array.isArray(content)) return [];
	const lengths: number[] = [];
	for (let index = 0; index < content.length; index++) {
		const block = content[index] as ContentBlock;
		if (block?.type === "text" && typeof block.text === "string") {
			lengths[index] = block.text.length;
		} else if (block?.type === "thinking" && block.thinkingSignature?.body) {
			lengths[index] = (block.thinkingSignature.body as string).length;
		}
	}
	return lengths;
}

function outputUsage(message: StreamMessage): number {
	const value = Number(message?.usage?.output);
	return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

type WorkingUi = {
	setWorkingMessage(message?: string): void;
};

// ---------------------------------------------------------------------------
// Theme-adaptive spinner colors: verb + status + glyph.
// `#rrggbb` literals bypass theme lookup; theme keys resolve against the
// active Pi theme (verb → accent, status → muted). Resolution re-runs only
// on settings change or theme swap, never per tick.
// ---------------------------------------------------------------------------

// Defaults — primary blue matches cc-dark `accent`. Orange kept as fallback.
let CLAUDE_ORANGE = "\u001B[38;2;177;185;249m";
let STATUS_DIM = "\u001B[38;2;153;153;153m";
let GLYPH_COLOR: string | null = null;

const _DEFAULT_CLAUDE_ORANGE = CLAUDE_ORANGE;
const _DEFAULT_STATUS_DIM = STATUS_DIM;

let _themeColorsCacheTheme: unknown = null;
let _themeColorsLastAdaptive: boolean | null = null;
let _themeColorsLastVerbKey: string | null = null;
let _themeColorsLastStatusKey: string | null = null;
let _themeColorsLastGlyphKey: string | null = null;

function resolveThemeColor(theme: any, key: string, fallbackKey: string): string | null {
	if (!theme || typeof theme.getFgAnsi !== "function") return null;
	try {
		const v = theme.getFgAnsi(key);
		if (typeof v === "string" && v.length > 0) return v;
	} catch {
		/* ignore */
	}
	if (fallbackKey !== key) {
		try {
			const v = theme.getFgAnsi(fallbackKey);
			if (typeof v === "string" && v.length > 0) return v;
		} catch {
			/* ignore */
		}
	}
	return null;
}

function applyThemeColors(theme: any): void {
	const { adaptive, verbColor, statusColor, glyphColor } = readSpinnerSettings();

	// Respond to runtime toggles without restarting pi.
	const settingsChanged =
		_themeColorsLastAdaptive !== adaptive ||
		_themeColorsLastVerbKey !== verbColor ||
		_themeColorsLastStatusKey !== statusColor ||
		_themeColorsLastGlyphKey !== glyphColor;
	if (settingsChanged) {
		_themeColorsLastAdaptive = adaptive;
		_themeColorsLastVerbKey = verbColor;
		_themeColorsLastStatusKey = statusColor;
		_themeColorsLastGlyphKey = glyphColor;
		_themeColorsCacheTheme = null;
		if (!adaptive) {
			CLAUDE_ORANGE = _DEFAULT_CLAUDE_ORANGE;
			STATUS_DIM = _DEFAULT_STATUS_DIM;
		}
	}

	const glyphHex = glyphColor ? hexToFgAnsi(glyphColor) || null : null;
	const verbHex = verbColor ? hexToFgAnsi(verbColor) || null : null;
	const statusHex = statusColor ? hexToFgAnsi(statusColor) || null : null;

	if (!glyphColor) GLYPH_COLOR = null;
	else if (glyphHex) GLYPH_COLOR = glyphHex;
	if (verbHex) CLAUDE_ORANGE = verbHex;
	if (statusHex) STATUS_DIM = statusHex;

	const liveTheme = theme && adaptive ? theme : null;
	if (_themeColorsCacheTheme === liveTheme) return;
	_themeColorsCacheTheme = liveTheme;
	if (!liveTheme) return;

	if (!verbHex) {
		const verb = resolveThemeColor(liveTheme, verbColor, "accent");
		if (verb) CLAUDE_ORANGE = verb;
	}
	if (!statusHex) {
		const status = resolveThemeColor(liveTheme, statusColor, "muted");
		if (status) STATUS_DIM = status;
	}
	if (glyphColor && !glyphHex) {
		const glyph = resolveThemeColor(liveTheme, glyphColor, glyphColor);
		if (glyph) GLYPH_COLOR = glyph;
	}
}

// ---------------------------------------------------------------------------
// Loader glyph patch — Claude-style ping-pong glyphs, phase-synced with the
// verb shimmer. Per-Loader generation counters retire stale ticks.
// ---------------------------------------------------------------------------

const LOADER_LAST_TEXT = Symbol.for("pi-claude-code:spinner-loader-last-text");
const LOADER_ACTIVE = Symbol.for("pi-claude-code:spinner-loader-active");
const LOADER_GENERATION = Symbol.for("pi-claude-code:spinner-loader-generation");
const ACTIVE_UI_SYMBOL = Symbol.for("pi-claude-code:spinner-active-ui");

const RAW_ANSI_RE = /\u001B\[[0-9;]*m/;

function getDefaultSpinnerCharacters(): string[] {
	if (process.env.TERM === "xterm-ghostty") {
		return ["·", "✢", "✳", "✶", "✻", "✽"];
	}
	return process.platform === "darwin"
		? ["·", "✢", "✳", "✶", "✻", "✽"]
		: ["·", "✢", "*", "✶", "✻", "✽"];
}

const SPINNER_CHARS = getDefaultSpinnerCharacters();
const OB_FRAMES = [...SPINNER_CHARS, ...[...SPINNER_CHARS].reverse()];

// Shared phase for glyph↔verb sync — both start from same origin each turn.
let shimmerOriginMs = 0;
let sharedGlyphFrame = 0;

function unrefTimer(timer: ReturnType<typeof setTimeout> | null | undefined): void {
	(timer as any)?.unref?.();
}

function stopLoaderIfUiStopped(loader: any): boolean {
	if (!loader?.ui || !(loader.ui as any).stopped) return false;
	loader.stop?.();
	return true;
}

(Loader.prototype as any).updateDisplay = function patchedUpdateDisplay() {
	loaderDebugStats.updates++;
	loaderDebugStats.lastUpdateAt = Date.now();
	if (stopLoaderIfUiStopped(this)) return;
	sharedGlyphFrame = (this.currentFrame ?? 0) % OB_FRAMES.length;
	const frame = OB_FRAMES[sharedGlyphFrame];
	const message =
		typeof this.message === "string" && RAW_ANSI_RE.test(this.message)
			? this.message
			: this.messageColorFn(this.message);
	const coloredFrame = GLYPH_COLOR ? `${GLYPH_COLOR}${frame}${RESET}` : this.spinnerColorFn(frame);
	const nextText = `${coloredFrame} ${message}`;
	if ((this as any)[LOADER_LAST_TEXT] === nextText) return;
	(this as any)[LOADER_LAST_TEXT] = nextText;
	this.setText(nextText);
	if (this.ui && !(this.ui as any).stopped) {
		(globalThis as any)[ACTIVE_UI_SYMBOL] = this.ui;
		this.ui.requestRender();
	}
};

Loader.prototype.start = function patchedStart() {
	loaderDebugStats.starts++;
	loaderDebugStats.lastStartAt = Date.now();
	this.stop();
	(this as any)[LOADER_ACTIVE] = true;
	const generation = ((this as any)[LOADER_GENERATION] ?? 0) + 1;
	(this as any)[LOADER_GENERATION] = generation;
	delete (this as any)[LOADER_LAST_TEXT];
	// Align glyph phase with verb shimmer origin so both start at 0 together.
	if (shimmerOriginMs) (this as any).currentFrame = 0;
	sharedGlyphFrame = (this as any).currentFrame ?? 0;
	(this as any).updateDisplay();
	if (OB_FRAMES.length <= 1 || stopLoaderIfUiStopped(this)) return;
	// Shared 90ms ticker drives glyph at 180ms cadence (2 ticks).
	let ticks = 0;
	const unsub = subscribeTicker(() => {
		if (
			(this as any)[LOADER_ACTIVE] !== true ||
			(this as any)[LOADER_GENERATION] !== generation ||
			stopLoaderIfUiStopped(this)
		) {
			unsub();
			(this as any)._tickerUnsub = null;
			return;
		}
		ticks++;
		if (ticks % 2 !== 0) return;
		(this as any).currentFrame = ((this as any).currentFrame + 1) % OB_FRAMES.length;
		sharedGlyphFrame = (this as any).currentFrame;
		(this as any).updateDisplay();
	});
	(this as any)._tickerUnsub = unsub;
	(this as any).intervalId = null;
};

Loader.prototype.stop = function patchedStop() {
	loaderDebugStats.stops++;
	loaderDebugStats.lastStopAt = Date.now();
	(this as any)[LOADER_ACTIVE] = false;
	(this as any)[LOADER_GENERATION] = ((this as any)[LOADER_GENERATION] ?? 0) + 1;
	if ((this as any)._tickerUnsub) {
		try {
			(this as any)._tickerUnsub();
		} catch {
			/* ignore */
		}
		(this as any)._tickerUnsub = null;
	}
	if ((this as any).intervalId) {
		clearTimeout((this as any).intervalId);
		(this as any).intervalId = null;
	}
};

// ---------------------------------------------------------------------------
// Working message: `Crafting… (Reading 2 files · esc to interrupt · ↓ 1.4k tokens)`
// 耗时与 tok/s 已收口到回合统计行（agent-summary）。
// ---------------------------------------------------------------------------

/** Format elapsed ms as compact duration; sub-second shows "0s" (working footer). */
function formatWorkingDuration(ms: number): string {
	return formatDuration(ms) || "0s";
}

/** Claude-style compact token counts: 18, 1.4k, 12k（收口自 utils/format）。 */
function formatTokenCount(value: number): string {
	return formatTokens(value);
}

function statusText(text: string): string {
	return `${STATUS_DIM}${text}${RESET}`;
}

/** How long to preserve "thought for Ns" across turns. */
const THOUGHT_DISPLAY_MS = 3_500;

/** Minimum thinking duration before showing "thought for Ns". */
const MIN_THINKING_SHOW_MS = 100;

/** Completion message linger. */
const TURN_COMPLETION_MS = 2_500;

/** 无工具执行且无 token 活动超过此时长，working 行追加 stalled 提示。 */
const STALL_AFTER_MS = 30_000;

/**
 * Claude-style working row with verb shimmer. Replaces Pi's default
 * `Working...` while a turn runs; gated by `enableWorkingMessage` in config.
 * token 数同时喂给上游 token-rate（估算 → provider usage 同源），供 footer 速率芯片读取。
 */
export default function (pi: ExtensionAPI): void {
	const spinnerEnabled = spinnerModuleEnabled();
	logSpinnerInstall({ spinnerEnabled });
	if (!spinnerEnabled) return;
	// 代际令牌：reload 后旧实例的 shimmer 回调自检过期并自退订。
	const tickerGeneration = claimTickerGeneration();
	let agentStartTime = 0;
	let turnStartTime = 0;
	let completionTimer: ReturnType<typeof setTimeout> | null = null;
	let thoughtStatusTimer: ReturnType<typeof setTimeout> | null = null;
	let currentVerb = "";
	let responseLength = 0;
	let responseTextBlockLengths: number[] = [];
	let providerOutputTokens = 0;
	let thinkingStatus: "thinking" | number /* duration ms */ | null = null;
	let thinkingStartTime = 0;
	let thoughtForSetAt = 0;
	let activeTurnId = 0;
	let turnActive = false;
	let lastWorkingMessage: string | null = null;
	let activeCtx: { ui: WorkingUi & { theme?: unknown }; hasUI: boolean } | null = null;
	const activeTools = new Map<string, string>();
	let startupProgress = false;

	// --- diagnostics (temporary; see spinner-debug.ts) ----------------------
	let turnStartedAt = 0;
	let lastTickAt = 0;
	let lastChangeAt = 0;
	let lastEvent = "install";
	let lastVisibleMessage = "";
	let lastFrame = 0;
	let tickCount = 0;
	let syncAttempts = 0;
	let syncChanged = 0;
	let syncSame = 0;
	let syncNoUi = 0;
	let syncSetErrors = 0;
	let tickErrors = 0;
	let loopStarts = 0;
	let loopStops = 0;
	let stallLogged = false;
	let lastStallLogAt = 0;
	let errorBurstLogged = false;
	let loaderPatchMissingLogged = false;
	const heartbeatPrev = {
		ticks: 0,
		attempts: 0,
		changed: 0,
		same: 0,
		noUi: 0,
		errors: 0,
		loaderUpdates: loaderDebugStats.updates,
	};

	const plain = (text: string): string => text.replace(/\u001B\[[0-9;]*m/g, "");
	const tail = (text: string, max = 100): string => {
		const visible = plain(text);
		return visible.length > max ? visible.slice(-max) : visible;
	};

	function debugState(extra: Record<string, unknown> = {}): Record<string, unknown> {
		const now = Date.now();
		return {
			turnActive,
			loop: Boolean(shimmerUnsub),
			turnAgeMs: turnStartedAt ? now - turnStartedAt : null,
			tickAgeMs: lastTickAt ? now - lastTickAt : null,
			changeAgeMs: lastChangeAt ? now - lastChangeAt : null,
			verb: currentVerb,
			frame: Number(lastFrame.toFixed(2)),
			activeTools: activeTools.size,
			lastEvent,
			visible: lastVisibleMessage,
			ticks: tickCount,
			changed: syncChanged,
			same: syncSame,
			noUi: syncNoUi,
			setErrors: syncSetErrors,
			tickErrors,
			loopStarts,
			loopStops,
			loader: {
				starts: loaderDebugStats.starts,
				stops: loaderDebugStats.stops,
				updates: loaderDebugStats.updates,
				updateAgeMs: loaderDebugStats.lastUpdateAt ? now - loaderDebugStats.lastUpdateAt : null,
			},
			...extra,
		};
	}

	function debugEvent(name: string, extra: Record<string, unknown> = {}): void {
		lastEvent = name;
		spinnerLog(name, { ...debugState(), ...extra });
	}

	const heartbeatTimer = setInterval(() => {
		if (isStaleTickerGeneration(tickerGeneration)) {
			clearInterval(heartbeatTimer);
			return;
		}
		const now = Date.now();
		if (
			!loaderPatchMissingLogged &&
			turnActive &&
			syncChanged > 0 &&
			loaderDebugStats.updates === 0
		) {
			loaderPatchMissingLogged = true;
			spinnerLog("loader_patch_missing", {
				note: "Loader.prototype patch has not run; extension pi-tui differs from host pi-tui",
				...debugState(),
			});
		}
		// 空闲时不刷心跳；只保留工作态和完成提示的几秒窗口。
		if (!turnActive && !completionTimer && now - (lastChangeAt || now) > 10_000) return;
		spinnerLog("heartbeat", {
			turnActive,
			loop: Boolean(shimmerUnsub),
			turnAgeMs: turnStartedAt ? now - turnStartedAt : null,
			tickAgeMs: lastTickAt ? now - lastTickAt : null,
			changeAgeMs: lastChangeAt ? now - lastChangeAt : null,
			verb: currentVerb,
			frame: Number(lastFrame.toFixed(2)),
			activeTools: activeTools.size,
			lastEvent,
			visible: lastVisibleMessage,
			window: {
				ticks: tickCount - heartbeatPrev.ticks,
				attempts: syncAttempts - heartbeatPrev.attempts,
				changed: syncChanged - heartbeatPrev.changed,
				same: syncSame - heartbeatPrev.same,
				noUi: syncNoUi - heartbeatPrev.noUi,
				tickErrors: tickErrors - heartbeatPrev.errors,
				loaderUpdates: loaderDebugStats.updates - heartbeatPrev.loaderUpdates,
			},
			totals: {
				ticks: tickCount,
				attempts: syncAttempts,
				changed: syncChanged,
				same: syncSame,
				noUi: syncNoUi,
				setErrors: syncSetErrors,
				tickErrors,
				loopStarts,
				loopStops,
			},
			loader: {
				starts: loaderDebugStats.starts,
				stops: loaderDebugStats.stops,
				updates: loaderDebugStats.updates,
				updateAgeMs: loaderDebugStats.lastUpdateAt ? now - loaderDebugStats.lastUpdateAt : null,
			},
			rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
		});
		heartbeatPrev.ticks = tickCount;
		heartbeatPrev.attempts = syncAttempts;
		heartbeatPrev.changed = syncChanged;
		heartbeatPrev.same = syncSame;
		heartbeatPrev.noUi = syncNoUi;
		heartbeatPrev.errors = tickErrors;
		heartbeatPrev.loaderUpdates = loaderDebugStats.updates;
	}, 1_000);
	unrefTimer(heartbeatTimer);

	// 独立 watchdog：即使 shimmer 订阅已经死掉，也能记下停摆时的工作态。
	const stallTimer = setInterval(() => {
		if (isStaleTickerGeneration(tickerGeneration)) {
			clearInterval(stallTimer);
			return;
		}
		if (!turnActive) {
			stallLogged = false;
			return;
		}
		const now = Date.now();
		const gap = lastTickAt ? now - lastTickAt : turnStartedAt ? now - turnStartedAt : 0;
		const noSubscription = !shimmerUnsub;
		if (!noSubscription && gap <= 500) {
			if (stallLogged) {
				spinnerLog("stall_cleared", debugState({ gapMs: gap }));
				stallLogged = false;
			}
			return;
		}
		if (stallLogged && now - lastStallLogAt < 5_000) return;
		stallLogged = true;
		lastStallLogAt = now;
		spinnerLog(
			"stall",
			debugState({ reason: noSubscription ? "no-subscription" : "tick-gap", gapMs: gap }),
		);
	}, 250);
	unrefTimer(stallTimer);
	// ------------------------------------------------------------------------

	function tokenCount(): number {
		return providerOutputTokens || Math.max(0, Math.round(responseLength / 4));
	}

	function toolLabel(toolName: unknown): string {
		if (toolName === "read") return "Reading";
		if (toolName === "bash") return "Running";
		return "Working";
	}

	function activitySuffix(): string {
		const counts = new Map<string, number>();
		for (const name of activeTools.values()) counts.set(name, (counts.get(name) ?? 0) + 1);
		const parts = [...counts].map(
			([name, count]) =>
				`${name} ${count} ${name === "Reading" ? "file" : name === "Running" ? "shell command" : "tool"}${count === 1 ? "" : "s"}`,
		);
		return parts.length > 0 ? parts.join(", ") : startupProgress ? "Loading context" : "";
	}

	function buildWorkingMessage(): string {
		const tokens = tokenCount();
		// Claude Code shape: `Crafting… (Reading 2 files · esc to interrupt · ↓ 1.4k tokens)`
		// 耗时与 tok/s 收口到回合统计行（agent-summary），working 行保持安静。
		const statusParts: string[] = [`${interruptShortcutText()} to interrupt`];

		if (tokens > 0) {
			statusParts.push(`↓ ${formatTokenCount(tokens)} tokens`);
		}
		// 停滞提示（抄 pi-ui 三色 working 的思想，取文本不断色）：
		// 无工具执行且 30s 无 token 活动，大概率卡住。工具执行中不报（预期内等待）。
		const idleMs = Date.now() - Math.max(turnStartTime, lastTokenAt());
		if (activeTools.size === 0 && idleMs >= STALL_AFTER_MS) {
			statusParts.push(`stalled ${formatDuration(idleMs)}`);
		}
		const activity = activitySuffix();
		if (activity) statusParts.unshift(activity);

		// Verb shimmer — continuous float phase, verb-length adaptive.
		const verbText = `${currentVerb}…`;
		const { baseRgb, shimmerRgb } = resolveShimmerColors(CLAUDE_ORANGE);
		const interval = getShimmerIntervalMs(verbText.length);
		const elapsedSinceOrigin = shimmerOriginMs
			? Date.now() - shimmerOriginMs
			: Date.now() - (agentStartTime || turnStartTime || Date.now());
		const baseFrameFloat = Math.max(0, elapsedSinceOrigin) / interval;
		// glyphInfluence continuous (no floor) — avoids phase kicks.
		const glyphWeight = Math.max(0.28, Math.min(0.38, 0.405 - verbText.length * 0.00625));
		const glyphInfluence = sharedGlyphFrame * glyphWeight;
		const frame = baseFrameFloat + glyphInfluence;
		lastFrame = frame;
		const sweptVerb = colorSweep(verbText, frame, baseRgb, shimmerRgb);
		let message = sweptVerb;
		message += statusText(` (${statusParts.join(" · ")})`);
		return message;
	}

	function setResponseTextBlockLength(index: number, length: number): void {
		const previous = responseTextBlockLengths[index] ?? 0;
		responseTextBlockLengths[index] = Math.max(0, length);
		responseLength = Math.max(0, responseLength + responseTextBlockLengths[index] - previous);
	}

	/** 当前用户指令的起点；工具调用后的 turn 复用它，直到下一条指令（供 token-rate）。 */
	let rateRunStartTime = 0;

	function updateProviderUsage(message: StreamMessage, final = false): void {
		const output = outputUsage(message);
		if (output > 0) {
			providerOutputTokens = output;
			recordProviderUsage(output, Date.now(), final);
		}
	}

	function resetResponseTracking(message?: StreamMessage): void {
		responseTextBlockLengths = message ? textBlockLengths(message) : [];
		responseLength = message
			? responseTextBlockLengths.reduce((sum, length) => sum + length, 0)
			: 0;
		providerOutputTokens = message ? outputUsage(message) : 0;
	}

	function syncWorkingMessage(force = false): void {
		syncAttempts++;
		if (!activeCtx?.hasUI) {
			syncNoUi++;
			return;
		}
		applyThemeColors((activeCtx.ui as { theme?: unknown })?.theme);
		const rawMessage = buildWorkingMessage();
		// Width-safe: truncate if wider than terminal.
		const cols =
			Number.isFinite(process.stdout.columns) && (process.stdout.columns ?? 0) > 0
				? (process.stdout.columns ?? 120)
				: 120;
		const nextMessage =
			visibleWidth(rawMessage) > cols ? truncateToWidth(rawMessage, cols, "") : rawMessage;
		if (!force && nextMessage === lastWorkingMessage) {
			syncSame++;
			return;
		}
		lastWorkingMessage = nextMessage;
		lastVisibleMessage = tail(nextMessage);
		try {
			activeCtx.ui.setWorkingMessage(nextMessage);
			syncChanged++;
			lastChangeAt = Date.now();
			errorBurstLogged = false;
		} catch (error) {
			syncSetErrors++;
			if (!errorBurstLogged) {
				errorBurstLogged = true;
				logSpinnerError("set_error", error, debugState());
			}
		}
	}

	function restoreDefaultWorkingMessage(): void {
		lastWorkingMessage = null;
		lastVisibleMessage = "";
		lastChangeAt = Date.now();
		if (!activeCtx?.hasUI) {
			syncNoUi++;
			return;
		}
		try {
			activeCtx.ui.setWorkingMessage();
		} catch (error) {
			syncSetErrors++;
			if (!errorBurstLogged) {
				errorBurstLogged = true;
				logSpinnerError("restore_error", error, debugState());
			}
		}
	}

	let shimmerUnsub: (() => void) | null = null;
	let refreshFailures = 0;

	/**
	 * 单帧异常不等于这一回合的动画结束。会话替换/reload 的瞬间 ctx getter 可能
	 * 抛一次错，后续事件会把 activeCtx 换成新 ctx；这里先跳过并继续滴答，
	 * 连续失败 2s 才停，避免一次抖动把扫光永久冻住。
	 */
	const MAX_REFRESH_FAILURES = 120;

	function scheduleRefreshTick(): void {
		if (!turnActive || shimmerUnsub) return;
		refreshFailures = 0;
		spinnerLog("loop_subscribe", { refreshFailures, ...debugState() });
		shimmerUnsub = subscribeShimmer(() => {
			if (isStaleTickerGeneration(tickerGeneration)) {
				// reload 后旧实例残留：退订自己，不再碰失效 ctx。
				stopRefreshLoop("stale-generation");
				return;
			}
			if (!turnActive) return;
			tickCount++;
			lastTickAt = Date.now();
			try {
				syncWorkingMessage();
				if (refreshFailures > 0) {
					spinnerLog("tick_recover", { failures: refreshFailures, ...debugState() });
					errorBurstLogged = false;
				}
				refreshFailures = 0;
			} catch (error) {
				// 定时器内的异常会成为 uncaughtException 终止 Pi；装饰性刷新不能逃逸。
				// 连续失败才停，给事件换新 ctx 留出恢复窗口。
				refreshFailures++;
				tickErrors++;
				if (!errorBurstLogged) {
					errorBurstLogged = true;
					logSpinnerError("tick_error", error, {
						...debugState(),
						refreshFailures,
					});
				}
				if (refreshFailures >= MAX_REFRESH_FAILURES) stopRefreshLoop("max-failures");
			}
		});
	}

	/** 若本回合仍在进行但动画订阅丢了（异常/重建），立刻补回来。 */
	function ensureRefreshLoop(): void {
		if (turnActive && !shimmerUnsub) {
			spinnerLog("loop_restart", { reason: "ensure", ...debugState() });
			scheduleRefreshTick();
		}
	}

	function startRefreshLoop(): void {
		stopRefreshLoop("restart");
		syncWorkingMessage(true);
		scheduleRefreshTick();
		loopStarts++;
	}

	function rescheduleRefreshLoop(): void {
		// 16ms shimmer ticker — adaptive is time-based, no reschedule needed.
		if (!turnActive) return;
		if (!shimmerUnsub) scheduleRefreshTick();
		else syncWorkingMessage(true);
	}

	function stopRefreshLoop(reason = "unspecified"): void {
		if (shimmerUnsub) {
			try {
				shimmerUnsub();
			} catch {
				/* ignore */
			}
			shimmerUnsub = null;
			loopStops++;
			spinnerLog("loop_stop", { reason, ...debugState() });
		}
	}

	function clearCompletionTimer(): void {
		if (completionTimer) {
			clearTimeout(completionTimer);
			completionTimer = null;
		}
	}

	function clearThoughtStatusTimer(): void {
		if (thoughtStatusTimer) {
			clearTimeout(thoughtStatusTimer);
			thoughtStatusTimer = null;
		}
	}

	function scheduleThoughtStatusClear(): void {
		clearThoughtStatusTimer();
		if (typeof thinkingStatus !== "number") return;
		const remaining = THOUGHT_DISPLAY_MS - (Date.now() - thoughtForSetAt);
		if (remaining <= 0) {
			thinkingStatus = null;
			if (turnActive) syncWorkingMessage(true);
			else if (!completionTimer) restoreDefaultWorkingMessage();
			return;
		}
		thoughtStatusTimer = setTimeout(() => {
			thoughtStatusTimer = null;
			if (typeof thinkingStatus !== "number") return;
			if (Date.now() - thoughtForSetAt < THOUGHT_DISPLAY_MS) {
				scheduleThoughtStatusClear();
				return;
			}
			thinkingStatus = null;
			if (turnActive) syncWorkingMessage(true);
			else if (!completionTimer) restoreDefaultWorkingMessage();
		}, remaining);
		unrefTimer(thoughtStatusTimer);
	}

	function clearDisplay(): void {
		debugEvent("clear_display");
		stopRefreshLoop("clear-display");
		clearCompletionTimer();
		clearThoughtStatusTimer();
		agentStartTime = 0;
		turnStartTime = 0;
		thinkingStatus = null;
		thoughtForSetAt = 0;
		resetResponseTracking();
		restoreDefaultWorkingMessage();
	}

	function onThinkingEnd(): void {
		if (thinkingStatus !== "thinking") return;
		const duration = Date.now() - thinkingStartTime;
		if (duration < MIN_THINKING_SHOW_MS) {
			thinkingStatus = null;
			clearThoughtStatusTimer();
			return;
		}
		thinkingStatus = duration;
		thoughtForSetAt = Date.now();
		scheduleThoughtStatusClear();
	}

	pi.on("before_agent_start", async () => {
		// Start once per top-level request. Steering/follow-up messages while the
		// agent is active must not reset the timer.
		if (!agentStartTime) agentStartTime = Date.now();
	});

	pi.on("agent_start", async () => {
		if (!agentStartTime) agentStartTime = Date.now();
		debugEvent("agent_start");
	});

	pi.on("session_start", async (_event, ctx) => {
		activeCtx = ctx as typeof activeCtx;
		startupProgress = true;
		debugEvent("session_start", { hasUI: ctx.hasUI });
		if (ctx.hasUI) {
			try {
				ctx.ui.setWorkingMessage(
					`${CLAUDE_ORANGE}Loading…${RESET}${statusText(" (Reading 1 file, Loading context)")}`,
				);
				lastChangeAt = Date.now();
			} catch (error) {
				logSpinnerError("session_start_set_error", error, debugState());
			}
		}
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		activeCtx = ctx as typeof activeCtx;
		ensureRefreshLoop();
		const id = String((event as any)?.toolCallId ?? `${Date.now()}-${activeTools.size}`);
		const label = toolLabel((event as any)?.toolName);
		activeTools.set(id, label);
		startupProgress = false;
		pauseTokenRate();
		debugEvent("tool_start", { id, label, toolName: (event as any)?.toolName });
		if (turnActive) syncWorkingMessage(true);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		activeCtx = ctx as typeof activeCtx;
		ensureRefreshLoop();
		const id = String((event as any)?.toolCallId ?? "");
		if (id) activeTools.delete(id);
		resumeTokenRate();
		debugEvent("tool_end", { id, remainingTools: activeTools.size });
		if (turnActive) syncWorkingMessage(true);
	});

	pi.on("turn_start", async (_event, ctx) => {
		activeTurnId++;
		turnActive = true;
		startupProgress = false;
		activeCtx = ctx as typeof activeCtx;
		turnStartedAt = Date.now();
		lastTickAt = turnStartedAt;
		stallLogged = false;
		applyThemeColors((ctx as { ui?: { theme?: unknown } }).ui?.theme);
		turnStartTime = (_event as any)?.timestamp || Date.now();
		if (!agentStartTime) agentStartTime = turnStartTime;
		// 上游 token-rate 桥：同一条用户指令内复用速率起点，供 footer 速率芯片读取。
		if (rateRunStartTime !== agentStartTime) {
			rateRunStartTime = agentStartTime;
			resetTokenRate(turnStartTime);
		}
		startMessageSegment(turnStartTime);
		// Preserve shimmer phase across verb switches — map old progress to the
		// new interval so the band doesn't snap to 0.
		const prevVerb = currentVerb;
		const now = Date.now();
		const newVerb = pickVerb();
		if (prevVerb && shimmerOriginMs) {
			const prevInterval = getShimmerIntervalMs(`${prevVerb}…`.length);
			const newInterval = getShimmerIntervalMs(`${newVerb}…`.length);
			const oldElapsed = now - shimmerOriginMs;
			const oldFrame = oldElapsed / prevInterval;
			// Keep oldFrame continuous with new interval.
			shimmerOriginMs = now - oldFrame * newInterval;
		} else {
			shimmerOriginMs = now;
		}
		// Don't reset sharedGlyphFrame — keep glyph phase continuous.
		currentVerb = newVerb;
		resetResponseTracking();
		clearCompletionTimer();
		if (typeof thinkingStatus !== "number" || Date.now() - thoughtForSetAt >= THOUGHT_DISPLAY_MS) {
			thinkingStatus = null;
			clearThoughtStatusTimer();
		} else {
			scheduleThoughtStatusClear();
		}
		debugEvent("turn_start", { verb: currentVerb, prevVerb });
		startRefreshLoop();
	});

	pi.on("message_update", async (event, ctx) => {
		activeCtx = ctx as typeof activeCtx;
		ensureRefreshLoop();
		applyThemeColors((ctx as { ui?: { theme?: unknown } }).ui?.theme);
		const evt = (event as any)?.assistantMessageEvent;
		if (!evt) return;
		lastEvent = `message_update:${String(evt.type ?? "?")}`;
		updateProviderUsage(evt.partial ?? {});
		let statusChanged = false;
		const previousTokenCount = tokenCount();

		if (evt.type === "start") {
			resetResponseTracking(evt.partial);
		} else if (evt.type === "toolcall_start") {
			// 模型直接发起 tool call（thinking/text 省略）时也算首 token。
			markFirstToken();
			updateProviderUsage(evt.partial ?? {});
		} else if (evt.type === "text_start") {
			setResponseTextBlockLength(evt.contentIndex, 0);
			markFirstToken();
		} else if (evt.type === "thinking_start") {
			markFirstToken();
			setResponseTextBlockLength(evt.contentIndex, 0);
			clearThoughtStatusTimer();
			thinkingStatus = "thinking";
			thinkingStartTime = Date.now();
			statusChanged = true;
		} else if (evt.type === "text_delta" || evt.type === "toolcall_delta") {
			// 工具参数走 toolcall_delta；不计入的话，写长文件这类调用期间 token 一直不涨。
			if (typeof evt.delta === "string") sampleTokenDelta(evt.delta);
			const previous = responseTextBlockLengths[evt.contentIndex] ?? 0;
			setResponseTextBlockLength(
				evt.contentIndex,
				previous + (typeof evt.delta === "string" ? evt.delta.length : 0),
			);
		} else if (evt.type === "thinking_delta") {
			if (typeof evt.delta === "string") sampleTokenDelta(evt.delta);
			const previous = responseTextBlockLengths[evt.contentIndex] ?? 0;
			setResponseTextBlockLength(
				evt.contentIndex,
				previous + (typeof evt.delta === "string" ? evt.delta.length : 0),
			);
		} else if (evt.type === "text_end") {
			updateProviderUsage(evt.partial ?? {});
			setResponseTextBlockLength(
				evt.contentIndex,
				typeof evt.content === "string" ? evt.content.length : 0,
			);
		} else if (evt.type === "done") {
			// Pi 目前不会把 done/error 转成 message_update，定格在下面的 message_end 里做。
			// 这两个分支只在宿主直接转发 done/error 时生效；同一个值重复定格不改变结果。
			updateProviderUsage(evt.message, true);
		} else if (evt.type === "error") {
			updateProviderUsage(evt.error);
			resetResponseTracking(evt.error);
		}

		if (evt.type === "thinking_end") {
			onThinkingEnd();
			statusChanged = true;
		}

		if (statusChanged) {
			debugEvent("status_changed", { type: evt.type });
			syncWorkingMessage(true);
			rescheduleRefreshLoop();
			// Same-frame ordering: ensure footer updates even if pi rendered first.
			const timer = setTimeout(() => syncWorkingMessage(true), 0);
			unrefTimer(timer);
			return;
		}

		const nextTokenCount = tokenCount();
		if (previousTokenCount === 0 && nextTokenCount > 0) {
			rescheduleRefreshLoop();
		} else {
			syncWorkingMessage();
		}
	});

	// message_delta 的累计 usage 只出现在 message_end 上，含未逐字流出的思考 token。
	// message_end 在工具执行和 turn_end 之前，先于 carryTokenRate 结转。
	pi.on("message_end", async (event, ctx) => {
		const message = event?.message;
		if (message?.role !== "assistant") return;
		activeCtx = ctx;
		ensureRefreshLoop();
		// 出错/中断时 usage 可能还是 message_start 的占位值，只接受变大的值。
		const failed = message.stopReason === "error" || message.stopReason === "aborted";
		updateProviderUsage(message, !failed);
		syncWorkingMessage();
		debugEvent("message_end", {
			stopReason: message.stopReason,
			output: (message as any)?.usage?.output,
			providerOutputTokens,
		});
	});

	pi.on("turn_end", async (_event, ctx) => {
		turnActive = false;
		activeCtx = ctx as typeof activeCtx;
		activeTools.clear();
		startupProgress = false;
		applyThemeColors((ctx as { ui?: { theme?: unknown } }).ui?.theme);
		const turnId = activeTurnId;
		const elapsed = Date.now() - (agentStartTime || turnStartTime);
		debugEvent("turn_end", {
			elapsedMs: elapsed,
			toolResults: Array.isArray((_event as any)?.toolResults)
				? (_event as any).toolResults.length
				: 0,
		});
		stopRefreshLoop("turn_end");
		clearCompletionTimer();

		if (typeof thinkingStatus === "number" && Date.now() - thoughtForSetAt >= THOUGHT_DISPLAY_MS) {
			thinkingStatus = null;
			clearThoughtStatusTimer();
		}

		if (activeCtx?.hasUI) {
			const message = `${STATUS_DIM}✻ Turn took ${formatWorkingDuration(elapsed)}${RESET}`;
			lastWorkingMessage = message;
			lastVisibleMessage = tail(message);
			lastChangeAt = Date.now();
			try {
				activeCtx.ui.setWorkingMessage(message);
			} catch (error) {
				syncSetErrors++;
				logSpinnerError("turn_end_set_error", error, debugState());
			}
			// 长任务完成响铃（默认关闭；TTY 才发 BEL，避免污染管道输出）。
			try {
				if (
					config.completionBellAfterSec > 0 &&
					elapsed >= config.completionBellAfterSec * 1000 &&
					process.stdout.isTTY === true
				) {
					process.stdout.write("\x07");
				}
			} catch {
				/* noop */
			}
			completionTimer = setTimeout(() => {
				completionTimer = null;
				if (activeTurnId !== turnId) return;
				debugEvent("completion_restore");
				restoreDefaultWorkingMessage();
			}, TURN_COMPLETION_MS);
			unrefTimer(completionTimer);
		} else if (typeof thinkingStatus !== "number") {
			restoreDefaultWorkingMessage();
		}

		responseLength = 0;
		responseTextBlockLengths = [];
		// 本段 token 结转进累计，下一段 turn 继续累加；此处不清速率（footer 定格显示）。
		carryTokenRate();
	});

	pi.on("agent_end", async () => {
		debugEvent("agent_end", { completionPending: Boolean(completionTimer) });
		turnActive = false;
		agentStartTime = 0;
		// Preserve the just-finished "Turn took …" line. Pi emits agent_end
		// immediately after the final turn, so clearing here made the completion
		// status disappear before users could see it.
		if (completionTimer) return;
		clearDisplay();
	});

	pi.on("session_shutdown", async () => {
		debugEvent("session_shutdown");
		turnActive = false;
		clearCompletionTimer();
		clearThoughtStatusTimer();
		clearDisplay();
		activeCtx = null;
	});
}
