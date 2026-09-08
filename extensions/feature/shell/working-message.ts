import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Loader, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { subscribeShimmer, subscribeTicker } from "./spinner-ticker.ts";
import { RESET, hexToFgAnsi } from "./spinner-color.ts";
import { colorSweep, getShimmerIntervalMs, resolveShimmerColors } from "./spinner-shimmer.ts";
import { pickVerb } from "./spinner-verbs.ts";
import { readSpinnerSettings, spinnerModuleEnabled } from "./spinner-settings.ts";
import { formatDuration } from "../../utils/format.ts";

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
// Working message: `Crafting… (Reading 2 files · esc to interrupt · ↓ 1.4k tokens · 12s)`
// ---------------------------------------------------------------------------

/** Format elapsed ms as compact duration; sub-second shows "0s" (working footer). */
function formatWorkingDuration(ms: number): string {
	return formatDuration(ms) || "0s";
}

/** Claude-style compact token counts: 18, 1.4k, 12k */
function formatTokenCount(value: number): string {
	const n = Math.max(0, Math.round(value));
	if (n < 1000) return String(n);
	const k = n / 1000;
	if (k < 10) {
		const oneDecimal = Math.round(k * 10) / 10;
		return `${oneDecimal % 1 === 0 ? oneDecimal.toFixed(0) : oneDecimal.toFixed(1)}k`;
	}
	return `${Math.round(k)}k`;
}

function statusText(text: string): string {
	return `${STATUS_DIM}${text}${RESET}`;
}

/** Threshold before showing elapsed time in status parentheses. */
const SHOW_TIMER_AFTER_MS = 1_000;

/** How long to preserve "thought for Ns" across turns. */
const THOUGHT_DISPLAY_MS = 3_500;

/** Minimum thinking duration before showing "thought for Ns". */
const MIN_THINKING_SHOW_MS = 100;

/** Completion message linger. */
const TURN_COMPLETION_MS = 2_500;

/**
 * Claude-style working row with verb shimmer. Replaces Pi's default
 * `Working...` while a turn runs; gated by `enableWorkingMessage` in config.
 */
export default function (pi: ExtensionAPI): void {
	if (!spinnerModuleEnabled()) return;
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
		const elapsed = Date.now() - (agentStartTime || turnStartTime);
		const tokens = tokenCount();
		// Claude Code shape: `Crafting… (Reading 2 files · esc to interrupt · ↓ 1.4k tokens · 1m 2s)`
		const statusParts: string[] = ["esc to interrupt"];

		if (tokens > 0) {
			statusParts.push(`↓ ${formatTokenCount(tokens)} tokens`);
		}

		if (elapsed >= SHOW_TIMER_AFTER_MS || tokens > 0) {
			statusParts.push(formatWorkingDuration(elapsed));
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

	function updateProviderUsage(message: StreamMessage): void {
		const output = outputUsage(message);
		if (output > 0) providerOutputTokens = output;
	}

	function resetResponseTracking(message?: StreamMessage): void {
		responseTextBlockLengths = message ? textBlockLengths(message) : [];
		responseLength = message
			? responseTextBlockLengths.reduce((sum, length) => sum + length, 0)
			: 0;
		providerOutputTokens = message ? outputUsage(message) : 0;
	}

	function syncWorkingMessage(force = false): void {
		if (!activeCtx?.hasUI) return;
		applyThemeColors((activeCtx.ui as { theme?: unknown })?.theme);
		const rawMessage = buildWorkingMessage();
		// Width-safe: truncate if wider than terminal.
		const cols =
			Number.isFinite(process.stdout.columns) && (process.stdout.columns ?? 0) > 0
				? (process.stdout.columns ?? 120)
				: 120;
		const nextMessage =
			visibleWidth(rawMessage) > cols ? truncateToWidth(rawMessage, cols, "") : rawMessage;
		if (!force && nextMessage === lastWorkingMessage) return;
		lastWorkingMessage = nextMessage;
		try {
			activeCtx.ui.setWorkingMessage(nextMessage);
		} catch {
			/* noop */
		}
	}

	function restoreDefaultWorkingMessage(): void {
		lastWorkingMessage = null;
		if (!activeCtx?.hasUI) return;
		try {
			activeCtx.ui.setWorkingMessage();
		} catch {
			/* noop */
		}
	}

	let shimmerUnsub: (() => void) | null = null;

	function scheduleRefreshTick(): void {
		if (!turnActive || shimmerUnsub) return;
		shimmerUnsub = subscribeShimmer(() => {
			if (!turnActive) return;
			syncWorkingMessage();
		});
	}

	function startRefreshLoop(): void {
		stopRefreshLoop();
		syncWorkingMessage(true);
		scheduleRefreshTick();
	}

	function rescheduleRefreshLoop(): void {
		// 16ms shimmer ticker — adaptive is time-based, no reschedule needed.
		if (!turnActive) return;
		if (!shimmerUnsub) scheduleRefreshTick();
		else syncWorkingMessage(true);
	}

	function stopRefreshLoop(): void {
		if (shimmerUnsub) {
			try {
				shimmerUnsub();
			} catch {
				/* ignore */
			}
			shimmerUnsub = null;
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
		stopRefreshLoop();
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
	});

	pi.on("session_start", async (_event, ctx) => {
		activeCtx = ctx as typeof activeCtx;
		startupProgress = true;
		if (ctx.hasUI) {
			try {
				ctx.ui.setWorkingMessage(
					`${CLAUDE_ORANGE}Loading…${RESET}${statusText(" (Reading 1 file, Loading context)")}`,
				);
			} catch {
				/* noop */
			}
		}
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		activeCtx = ctx as typeof activeCtx;
		const id = String((event as any)?.toolCallId ?? `${Date.now()}-${activeTools.size}`);
		activeTools.set(id, toolLabel((event as any)?.toolName));
		startupProgress = false;
		if (turnActive) syncWorkingMessage(true);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		activeCtx = ctx as typeof activeCtx;
		const id = String((event as any)?.toolCallId ?? "");
		if (id) activeTools.delete(id);
		if (turnActive) syncWorkingMessage(true);
	});

	pi.on("turn_start", async (_event, ctx) => {
		activeTurnId++;
		turnActive = true;
		startupProgress = false;
		activeCtx = ctx as typeof activeCtx;
		applyThemeColors((ctx as { ui?: { theme?: unknown } }).ui?.theme);
		turnStartTime = Date.now();
		if (!agentStartTime) agentStartTime = turnStartTime;
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
		startRefreshLoop();
	});

	pi.on("message_update", async (event, ctx) => {
		activeCtx = ctx as typeof activeCtx;
		applyThemeColors((ctx as { ui?: { theme?: unknown } }).ui?.theme);
		const evt = (event as any)?.assistantMessageEvent;
		if (!evt) return;
		updateProviderUsage(evt.partial ?? {});
		let statusChanged = false;
		const previousTokenCount = tokenCount();

		if (evt.type === "start") {
			resetResponseTracking(evt.partial);
		} else if (evt.type === "text_start") {
			setResponseTextBlockLength(evt.contentIndex, 0);
		} else if (evt.type === "thinking_start") {
			setResponseTextBlockLength(evt.contentIndex, 0);
			clearThoughtStatusTimer();
			thinkingStatus = "thinking";
			thinkingStartTime = Date.now();
			statusChanged = true;
		} else if (evt.type === "text_delta") {
			const previous = responseTextBlockLengths[evt.contentIndex] ?? 0;
			setResponseTextBlockLength(
				evt.contentIndex,
				previous + (typeof evt.delta === "string" ? evt.delta.length : 0),
			);
		} else if (evt.type === "thinking_delta") {
			const previous = responseTextBlockLengths[evt.contentIndex] ?? 0;
			setResponseTextBlockLength(
				evt.contentIndex,
				previous + (typeof evt.delta === "string" ? evt.delta.length : 0),
			);
		} else if (evt.type === "text_end") {
			setResponseTextBlockLength(
				evt.contentIndex,
				typeof evt.content === "string" ? evt.content.length : 0,
			);
		} else if (evt.type === "done") {
			resetResponseTracking(evt.message);
		} else if (evt.type === "error") {
			resetResponseTracking(evt.error);
		}

		if (evt.type === "thinking_end") {
			onThinkingEnd();
			statusChanged = true;
		}

		if (statusChanged) {
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

	pi.on("turn_end", async (_event, ctx) => {
		turnActive = false;
		activeCtx = ctx as typeof activeCtx;
		activeTools.clear();
		startupProgress = false;
		applyThemeColors((ctx as { ui?: { theme?: unknown } }).ui?.theme);
		const turnId = activeTurnId;
		const elapsed = Date.now() - (agentStartTime || turnStartTime);
		stopRefreshLoop();
		clearCompletionTimer();

		if (typeof thinkingStatus === "number" && Date.now() - thoughtForSetAt >= THOUGHT_DISPLAY_MS) {
			thinkingStatus = null;
			clearThoughtStatusTimer();
		}

		if (activeCtx?.hasUI) {
			const message = `${STATUS_DIM}✻ Turn took ${formatWorkingDuration(elapsed)}${RESET}`;
			lastWorkingMessage = message;
			try {
				activeCtx.ui.setWorkingMessage(message);
			} catch {
				/* noop */
			}
			completionTimer = setTimeout(() => {
				completionTimer = null;
				if (activeTurnId !== turnId) return;
				restoreDefaultWorkingMessage();
			}, TURN_COMPLETION_MS);
			unrefTimer(completionTimer);
		} else if (typeof thinkingStatus !== "number") {
			restoreDefaultWorkingMessage();
		}

		responseLength = 0;
		responseTextBlockLengths = [];
	});

	pi.on("agent_end", async () => {
		turnActive = false;
		agentStartTime = 0;
		// Preserve the just-finished "Turn took …" line. Pi emits agent_end
		// immediately after the final turn, so clearing here made the completion
		// status disappear before users could see it.
		if (completionTimer) return;
		clearDisplay();
	});

	pi.on("session_shutdown", async () => {
		turnActive = false;
		clearDisplay();
		activeCtx = null;
	});
}
