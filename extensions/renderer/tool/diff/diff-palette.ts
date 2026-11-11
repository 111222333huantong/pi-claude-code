import { config } from "../../../config/config.ts";
import { ansi256ToRgb } from "../../../utils/ansi-color.ts";
import {
	ANSI_SGR_PATTERN,
	expandSgrReset,
	filterSgrSequences,
	readSgrColorSequence,
	toSgrParams,
} from "./ansi-utils.ts";
import { type DiffSpan, mergeSpans } from "./diff-inline.ts";
import type { DiffLineKind } from "./diff-parse.ts";
import { fitToWidth } from "./diff-text.ts";

export interface DiffTheme {
	fg(color: string, text: string): string;
	bg?(color: string, text: string): string;
	bold?(text: string): string;
	getFgAnsi?(color: string): string;
	getBgAnsi?(color: string): string;
}

export interface RgbColor {
	r: number;
	g: number;
	b: number;
}

export interface DiffPalette {
	addRowBgAnsi: string;
	removeRowBgAnsi: string;
	addEmphasisBgAnsi: string;
	removeEmphasisBgAnsi: string;
}

/**
 * 行底不再直接拿主题 toolSuccessBg/toolErrorBg 去混，而是取 diff 前景色的
 * 色相，把亮度/饱和度归一到成熟 CLI 的暗色 tint 区间。主题自带的背景色
 * 深浅差异很大（cc-dark 的行底只有 ~13% 亮度，Codex/Crush 在 ~18–22%），
 * 直接混会把行底压得发闷，浅色主题又会过艳。
 */
interface DiffTintTarget {
	lightness: number;
	minSaturation: number;
	maxSaturation: number;
}

const DARK_ROW_TINT: DiffTintTarget = { lightness: 0.18, minSaturation: 0.24, maxSaturation: 0.32 };
const DARK_EMPHASIS_TINT: DiffTintTarget = {
	lightness: 0.25,
	minSaturation: 0.36,
	maxSaturation: 0.48,
};
const LIGHT_ROW_TINT: DiffTintTarget = {
	lightness: 0.93,
	minSaturation: 0.36,
	maxSaturation: 0.5,
};
const LIGHT_EMPHASIS_TINT: DiffTintTarget = {
	lightness: 0.875,
	minSaturation: 0.4,
	maxSaturation: 0.55,
};

export const ANSI_BG_RESET = "\x1b[49m";

/**
 * Claude 固定 diff 板（实测值）：删行 bg #3D0100、删 token bg #5C0200、
 * 加行 bg #022800、加 token bg #044700。gutter/sign 前景由调用方取主题
 * toolDiffAdded/Removed（#50C850/#DC5A5A 量级），此处只定背景。
 */
const bgAnsi = (r: number, g: number, b: number): string => `\x1b[48;2;${r};${g};${b}m`;
export const CLAUDE_DIFF_PALETTE: DiffPalette = {
	addRowBgAnsi: bgAnsi(2, 40, 0),
	removeRowBgAnsi: bgAnsi(61, 1, 0),
	addEmphasisBgAnsi: bgAnsi(4, 71, 0),
	removeEmphasisBgAnsi: bgAnsi(92, 2, 0),
};

export function emphasis(theme: DiffTheme, text: string): string {
	return typeof theme.bold === "function" ? theme.bold(text) : text;
}

function sequenceResetsBackground(params: number[]): boolean {
	let index = 0;
	while (index < params.length) {
		const param = params[index] ?? 0;
		if (param === 0 || param === 49) {
			return true;
		}

		const colorSequence = readSgrColorSequence(params, index);
		index += colorSequence ? colorSequence.length : 1;
	}

	return false;
}

function stripBackgroundResetParams(params: number[]): number[] {
	const filtered: number[] = [];

	for (let i = 0; i < params.length; i++) {
		const param = params[i] ?? 0;

		if (param === 0) {
			filtered.push(...expandSgrReset(param)!);
			continue;
		}

		if (param === 49) {
			continue;
		}

		const colorSequence = readSgrColorSequence(params, i);
		if (colorSequence) {
			filtered.push(...colorSequence);
			i += colorSequence.length - 1;
			continue;
		}

		filtered.push(param);
	}

	return filtered;
}

export function stabilizeBackgroundResets(text: string): string {
	if (!text) {
		return text;
	}
	return filterSgrSequences(text, stripBackgroundResetParams);
}

export function keepBackgroundAcrossResets(text: string, rowBg: string): string {
	if (!text?.includes("\x1b[")) {
		return text;
	}

	return text.replace(ANSI_SGR_PATTERN, (sequence, rawParams: string) => {
		const params = toSgrParams(rawParams);
		if (params.length === 0 || !sequenceResetsBackground(params)) {
			return sequence;
		}
		return `${sequence}${rowBg}`;
	});
}

/**
 * 上下文行整体压暗一档：保留语法色，只叠 faint（SGR 2）。
 * 语法高亮内部会不断 `\x1b[0m`，这里在每个 reset 后补回 faint，避免只有第一个 token 变暗。
 */
export function keepFaintAcrossResets(text: string): string {
	if (!text) return text;
	const faint = "\x1b[2m";
	const resetFaint = "\x1b[22m";
	if (!text.includes("\x1b[")) {
		return `${faint}${text}${resetFaint}`;
	}
	const stable = text.replace(ANSI_SGR_PATTERN, (sequence, rawParams: string) => {
		const params = toSgrParams(rawParams);
		return params.length === 0 || params.some((param) => param === 0 || param === 22)
			? `${sequence}${faint}`
			: sequence;
	});
	return `${faint}${stable}${resetFaint}`;
}

export function colorizeSegment(
	theme: DiffTheme,
	color: "dim" | "success" | "error",
	text: string,
	rowBg: string | undefined,
): string {
	let themedText: string;
	try {
		themedText = theme.fg(color, text);
	} catch {
		themedText = text;
	}

	if (!rowBg) {
		return themedText;
	}

	const stableText = keepBackgroundAcrossResets(themedText, rowBg);
	return `${rowBg}${stableText}${rowBg}`;
}

function applyBackgroundToVisualRow(
	text: string,
	width: number,
	rowBgAnsi: string,
	restoreBgAnsi: string,
): string {
	if (width <= 0) {
		return "";
	}

	const fitted = fitToWidth(text, width);
	const withStableBackground = keepBackgroundAcrossResets(fitted, rowBgAnsi);
	return stabilizeBackgroundResets(`${rowBgAnsi}${withStableBackground}${restoreBgAnsi}`);
}

export function applyLineBackgroundToWrappedRows(
	rows: string[],
	width: number,
	rowBgAnsi: string,
	restoreBgAnsi: string,
): string[] {
	if (rows.length === 0) {
		return [applyBackgroundToVisualRow("", width, rowBgAnsi, restoreBgAnsi)];
	}

	return rows.map((row) => applyBackgroundToVisualRow(row, width, rowBgAnsi, restoreBgAnsi));
}

/** utils 版返回 tuple，此处适配为本文件使用的 RgbColor 形状。 */
function ansi256ToRgbColor(code: number): RgbColor {
	const [r, g, b] = ansi256ToRgb(code);
	return { r, g, b };
}

export function parseAnsiColorCode(ansi: string | undefined): RgbColor | null {
	if (!ansi) {
		return null;
	}
	const rgbMatch = /\x1b\[(?:3|4)8;2;(\d{1,3});(\d{1,3});(\d{1,3})m/.exec(ansi);
	if (rgbMatch) {
		const r = Number.parseInt(rgbMatch[1] ?? "0", 10);
		const g = Number.parseInt(rgbMatch[2] ?? "0", 10);
		const b = Number.parseInt(rgbMatch[3] ?? "0", 10);
		if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
			return {
				r: Math.max(0, Math.min(255, r)),
				g: Math.max(0, Math.min(255, g)),
				b: Math.max(0, Math.min(255, b)),
			};
		}
	}

	const bitMatch = /\x1b\[(?:3|4)8;5;(\d{1,3})m/.exec(ansi);
	if (bitMatch) {
		const code = Number.parseInt(bitMatch[1] ?? "0", 10);
		if (Number.isFinite(code)) {
			return ansi256ToRgbColor(code);
		}
	}

	const basicMatch = /\x1b\[(?:3|4)([0-7])m/.exec(ansi);
	if (basicMatch) return ansi256ToRgbColor(Number(basicMatch[1]));
	const brightMatch = /\x1b\[(?:9|10)([0-7])m/.exec(ansi);
	if (brightMatch) return ansi256ToRgbColor(Number(brightMatch[1]) + 8);
	return null;
}

function rgbToBgAnsi(color: RgbColor): string {
	const r = Math.max(0, Math.min(255, Math.round(color.r)));
	const g = Math.max(0, Math.min(255, Math.round(color.g)));
	const b = Math.max(0, Math.min(255, Math.round(color.b)));
	return `\x1b[48;2;${r};${g};${b}m`;
}

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}

function rgbToHsl(color: RgbColor): { h: number; s: number; l: number } {
	const r = clamp01(color.r / 255);
	const g = clamp01(color.g / 255);
	const b = clamp01(color.b / 255);
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const lightness = (max + min) / 2;
	if (max === min) {
		return { h: 0, s: 0, l: lightness };
	}

	const delta = max - min;
	const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
	let hue: number;
	if (max === r) {
		hue = (g - b) / delta + (g < b ? 6 : 0);
	} else if (max === g) {
		hue = (b - r) / delta + 2;
	} else {
		hue = (r - g) / delta + 4;
	}
	return { h: hue / 6, s: saturation, l: lightness };
}

function hslToRgb(color: { h: number; s: number; l: number }): RgbColor {
	const { h, s, l } = color;
	if (s <= 0) {
		const value = Math.round(l * 255);
		return { r: value, g: value, b: value };
	}

	const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
	const p = 2 * l - q;
	const hueToChannel = (rawT: number): number => {
		let t = rawT;
		if (t < 0) t += 1;
		if (t > 1) t -= 1;
		if (t < 1 / 6) return p + (q - p) * 6 * t;
		if (t < 1 / 2) return q;
		if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
		return p;
	};

	return {
		r: Math.round(hueToChannel(h + 1 / 3) * 255),
		g: Math.round(hueToChannel(h) * 255),
		b: Math.round(hueToChannel(h - 1 / 3) * 255),
	};
}

/** 取前景色色相，把亮度和饱和度夹到目标区间，得到柔和的 diff 行底。 */
function tintedBackground(fg: RgbColor, target: DiffTintTarget): RgbColor {
	const hsl = rgbToHsl(fg);
	return hslToRgb({
		h: hsl.h,
		s: Math.max(target.minSaturation, Math.min(target.maxSaturation, hsl.s)),
		l: target.lightness,
	});
}

function extractThemeBackgroundAnsi(text: string): string | undefined {
	if (!text?.includes("\x1b[")) {
		return undefined;
	}

	ANSI_SGR_PATTERN.lastIndex = 0;
	let match: RegExpExecArray | null = ANSI_SGR_PATTERN.exec(text);
	while (match !== null) {
		const parsed = toSgrParams(match[1] ?? "");
		for (let index = 0; index < parsed.length; index += 1) {
			const param = parsed[index] ?? 0;
			if ((param >= 40 && param <= 47) || (param >= 100 && param <= 107)) {
				return `\x1b[${param}m`;
			}

			const colorSequence = readSgrColorSequence(parsed, index);
			if (colorSequence?.[0] === 48) {
				return `\x1b[${colorSequence.join(";")}m`;
			}
			if (colorSequence) {
				index += colorSequence.length - 1;
			}
		}
		match = ANSI_SGR_PATTERN.exec(text);
	}

	return undefined;
}

export function readThemeAnsi(
	theme: DiffTheme,
	kind: "fg" | "bg",
	slot: string,
): string | undefined {
	try {
		if (kind === "fg" && typeof theme.getFgAnsi === "function") {
			return theme.getFgAnsi(slot);
		}
		if (kind === "bg") {
			if (typeof theme.getBgAnsi === "function") {
				return theme.getBgAnsi(slot);
			}
			if (typeof theme.bg === "function") {
				return extractThemeBackgroundAnsi(theme.bg(slot, " "));
			}
		}
	} catch {
		return undefined;
	}
	return undefined;
}

export function resolveDiffPalette(theme: DiffTheme): DiffPalette {
	// claude 固定板：与主题无关的 CC 精确红绿（实测值，见 pi-claudify 语法文档）。
	if (config.diffPalette === "claude") return CLAUDE_DIFF_PALETTE;
	const baseBg = parseAnsiColorCode(readThemeAnsi(theme, "bg", "toolPendingBg")) ??
		parseAnsiColorCode(readThemeAnsi(theme, "bg", "userMessageBg")) ?? { r: 32, g: 35, b: 42 };
	const baseLuminance = (baseBg.r * 299 + baseBg.g * 587 + baseBg.b * 114) / 1000;
	const dark = baseLuminance < 128;
	// 色相取主题里真正用于 diff 的前景 slot；老主题没有时退回 success/error。
	const addFg = parseAnsiColorCode(readThemeAnsi(theme, "fg", "toolDiffAdded")) ??
		parseAnsiColorCode(readThemeAnsi(theme, "fg", "success")) ?? { r: 88, g: 173, b: 88 };
	const removeFg = parseAnsiColorCode(readThemeAnsi(theme, "fg", "toolDiffRemoved")) ??
		parseAnsiColorCode(readThemeAnsi(theme, "fg", "error")) ?? { r: 196, g: 98, b: 98 };

	return {
		addRowBgAnsi: rgbToBgAnsi(tintedBackground(addFg, dark ? DARK_ROW_TINT : LIGHT_ROW_TINT)),
		removeRowBgAnsi: rgbToBgAnsi(tintedBackground(removeFg, dark ? DARK_ROW_TINT : LIGHT_ROW_TINT)),
		addEmphasisBgAnsi: rgbToBgAnsi(
			tintedBackground(addFg, dark ? DARK_EMPHASIS_TINT : LIGHT_EMPHASIS_TINT),
		),
		removeEmphasisBgAnsi: rgbToBgAnsi(
			tintedBackground(removeFg, dark ? DARK_EMPHASIS_TINT : LIGHT_EMPHASIS_TINT),
		),
	};
}

export function getLineBackground(
	kind: DiffLineKind,
	palette: DiffPalette,
	emphasis: boolean,
): string | undefined {
	if (kind === "add") {
		return emphasis ? palette.addEmphasisBgAnsi : palette.addRowBgAnsi;
	}
	if (kind === "remove") {
		return emphasis ? palette.removeEmphasisBgAnsi : palette.removeRowBgAnsi;
	}
	return undefined;
}

function applyBackgroundToVisibleRange(
	ansiText: string,
	start: number,
	end: number,
	backgroundAnsi: string,
	restoreBackgroundAnsi: string,
): string {
	if (!ansiText || start >= end || end <= 0) {
		return ansiText;
	}

	const rangeStart = Math.max(0, start);
	const rangeEnd = Math.max(rangeStart, end);
	let output = "";
	let visibleIndex = 0;
	let index = 0;
	let inRange = false;

	while (index < ansiText.length) {
		if (ansiText[index] === "\x1b") {
			const sequenceEnd = ansiText.indexOf("m", index);
			if (sequenceEnd !== -1) {
				output += ansiText.slice(index, sequenceEnd + 1);
				index = sequenceEnd + 1;
				continue;
			}
		}

		if (visibleIndex === rangeStart && !inRange) {
			output += backgroundAnsi;
			inRange = true;
		}
		if (visibleIndex === rangeEnd && inRange) {
			output += restoreBackgroundAnsi;
			inRange = false;
		}

		output += ansiText[index] ?? "";
		visibleIndex++;
		index++;
	}

	if (inRange) {
		output += restoreBackgroundAnsi;
	}

	return output;
}

export function applyInlineSpanHighlight(
	plainText: string,
	renderedText: string,
	spans: DiffSpan[],
	emphasisBgAnsi: string | undefined,
	rowBgAnsi: string | undefined,
	fallbackBgAnsi: string | undefined,
): string {
	if (!renderedText || !plainText || spans.length === 0 || !emphasisBgAnsi) {
		return renderedText;
	}

	const sorted = mergeSpans(
		spans
			.map((span) => ({
				start: Math.max(0, Math.min(plainText.length, span.start)),
				end: Math.max(0, Math.min(plainText.length, span.end)),
			}))
			.filter((span) => span.end > span.start),
	);
	if (sorted.length === 0) {
		return renderedText;
	}

	const restoreBackgroundAnsi = rowBgAnsi ?? fallbackBgAnsi ?? ANSI_BG_RESET;
	let highlighted = renderedText;
	for (let index = sorted.length - 1; index >= 0; index--) {
		const span = sorted[index];
		if (!span) {
			continue;
		}
		highlighted = applyBackgroundToVisibleRange(
			highlighted,
			span.start,
			span.end,
			emphasisBgAnsi,
			restoreBackgroundAnsi,
		);
	}

	return highlighted;
}

export function resolveShikiTheme(theme: DiffTheme): string {
	if (process.env.DIFF_THEME) return process.env.DIFF_THEME;
	const background =
		parseAnsiColorCode(readThemeAnsi(theme, "bg", "toolSuccessBg")) ??
		parseAnsiColorCode(readThemeAnsi(theme, "bg", "toolPendingBg")) ??
		parseAnsiColorCode(readThemeAnsi(theme, "bg", "userMessageBg"));
	if (!background) return "github-dark";
	const luminance = (background.r * 299 + background.g * 587 + background.b * 114) / 1000;
	return luminance >= 128 ? "github-light" : "github-dark";
}
