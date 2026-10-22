/**
 * Temporary spinner diagnostics.
 *
 * Writes a low-volume log (state transitions + 1s heartbeat + stall watchdog)
 * so a "shimmer froze" report can be diagnosed after the fact. The log is
 * disabled with `PI_CC_SPINNER_DEBUG=0` and can be redirected with
 * `PI_CC_SPINNER_LOG=/path/to/file`.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { VERSION } from "@earendil-works/pi-coding-agent";

const DEFAULT_LOG = join(homedir(), ".pi", "agent", "spinner-debug.log");
const MAX_LOG_BYTES = 4 * 1024 * 1024;

const envLogPath = process.env.PI_CC_SPINNER_LOG?.trim();
export const SPINNER_LOG_PATH = envLogPath && envLogPath.length > 0 ? envLogPath : DEFAULT_LOG;

const enabled =
	process.env.PI_CC_SPINNER_DEBUG !== "0" && process.env.NODE_TEST_CONTEXT === undefined;

/** Loader-patch counters: zero means the patch is running on a different
 * `@earendil-works/pi-tui` module instance than the live status indicator. */
export const loaderDebugStats = {
	starts: 0,
	stops: 0,
	updates: 0,
	lastStartAt: 0,
	lastStopAt: 0,
	lastUpdateAt: 0,
};

let initialized = false;

function runtimeHint(): Record<string, unknown> {
	const release = /\/releases\/([^/]+)\//.exec(process.argv.join(" "))?.[1];
	return {
		extensionVersion: VERSION,
		piRelease: release ?? null,
		pid: process.pid,
		cwd: process.cwd(),
		argv: process.argv.slice(0, 3),
	};
}

function ensureLog(): void {
	if (initialized) return;
	initialized = true;
	try {
		mkdirSync(dirname(SPINNER_LOG_PATH), { recursive: true });
		if (existsSync(SPINNER_LOG_PATH) && statSync(SPINNER_LOG_PATH).size > MAX_LOG_BYTES) {
			renameSync(SPINNER_LOG_PATH, `${SPINNER_LOG_PATH}.1`);
		}
	} catch {
		/* logging must never break the extension */
	}
}

export function spinnerLog(event: string, data?: Record<string, unknown>): void {
	if (!enabled) return;
	try {
		ensureLog();
		const payload = data ? ` ${JSON.stringify(data)}` : "";
		appendFileSync(
			SPINNER_LOG_PATH,
			`${new Date().toISOString()} [${process.pid}] ${event}${payload}\n`,
		);
	} catch {
		/* ignore */
	}
}

/** Install banner: runtime hint + log location. */
export function logSpinnerInstall(extra?: Record<string, unknown>): void {
	spinnerLog("install", { ...runtimeHint(), log: SPINNER_LOG_PATH, ...extra });
}

/** First error of a burst, with stack but without flooding the log. */
export function logSpinnerError(
	event: string,
	error: unknown,
	extra?: Record<string, unknown>,
): void {
	spinnerLog(event, {
		message: error instanceof Error ? error.message : String(error),
		stack: error instanceof Error ? error.stack?.split("\n").slice(0, 5).join("\n") : undefined,
		...extra,
	});
}
