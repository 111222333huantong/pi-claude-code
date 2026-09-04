/**
 * Spinner color settings, read from Pi settings files.
 *
 * Keys (all optional): `themeAdaptive` (default true), `spinnerVerbColor`
 * (default `"borderAccent"`), `spinnerStatusColor` (default `"muted"`),
 * `spinnerGlyphColor` (default unset = Pi accent), `spinnerEnabled`
 * (default true). Project `./.pi/settings.json` overrides global
 * `~/.pi/settings.json`. Values accept a theme color key or a `#rrggbb`
 * hex literal.
 *
 * Follows cc-my-pi's slim-spinner semantics (MIT); kept as a separate
 * reader so a future `/ccstyle` panel row can take over persistence.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type SpinnerColorSettings = {
	adaptive: boolean;
	verbColor: string;
	statusColor: string;
	glyphColor: string;
};

const SETTINGS_TTL_MS = 1_000;
let _cache: { value: SpinnerColorSettings; expires: number } | null = null;

function readJsonFile(path: string): Record<string, unknown> {
	try {
		if (!existsSync(path)) return {};
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		/* ignore malformed settings */
	}
	return {};
}

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

export function readSpinnerSettings(): SpinnerColorSettings {
	const now = Date.now();
	if (_cache && _cache.expires > now) return _cache.value;
	const global = readJsonFile(join(homedir(), ".pi", "settings.json"));
	const project = readJsonFile(join(process.cwd(), ".pi", "settings.json"));
	const raw: Record<string, unknown> = { ...global, ...project };
	const value: SpinnerColorSettings = {
		adaptive: raw.themeAdaptive !== false,
		verbColor: asString(raw.spinnerVerbColor) || "borderAccent",
		statusColor: asString(raw.spinnerStatusColor) || "muted",
		glyphColor: asString(raw.spinnerGlyphColor),
	};
	_cache = { value, expires: now + SETTINGS_TTL_MS };
	return value;
}

/** One-shot gate: the module stays dormant when explicitly disabled. */
export function spinnerModuleEnabled(): boolean {
	const global = readJsonFile(join(homedir(), ".pi", "settings.json"));
	const project = readJsonFile(join(process.cwd(), ".pi", "settings.json"));
	const raw: unknown = project.spinnerEnabled ?? global.spinnerEnabled;
	if (typeof raw === "boolean") return raw;
	return true;
}

/** Test helper — drop the memoized settings. */
export function _resetSpinnerSettingsCache(): void {
	_cache = null;
}
