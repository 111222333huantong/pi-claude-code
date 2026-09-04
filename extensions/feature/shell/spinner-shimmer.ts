/**
 * Blue shimmer sweep for the spinner verb text (glyph unchanged).
 * A 6-char Gaussian band sweeps left→right over the verb string, derived
 * from the current verb color lightened toward white.
 *
 * Ported from cc-my-pi's spinner.ts shimmer section (MIT, Tim van den Hoorn).
 * `colorSweep` is a pure function — no side effects.
 */
import { hexToRgb, mixRgb, parseAnsiRgb, rgbToFgAnsi, type Rgb } from "./spinner-color.ts";

import { RESET } from "./spinner-color.ts";

export const SHIMMER_BAND_WIDTH = 6;

/** Parse a `#rrggbb` literal into a 24-bit ANSI foreground escape, or null. */
export function hexToAnsiFg(value: string): string | null {
	const ansi = hexToFgAnsiLocal(value.trim());
	return ansi ? ansi : null;
}

function hexToFgAnsiLocal(value: string): string {
	if (!value || !/^#[0-9a-fA-F]{6}$/.test(value)) return "";
	const rgb = hexToRgb(value);
	if (!rgb) return "";
	return rgbToFgAnsi(rgb);
}

/**
 * Gaussian-feathered sweep: ping-pong 0→L-1→1→0 with wrap, sub-char smooth.
 *
 * @param text verb text including the trailing `…`
 * @param frame monotonically increasing frame counter (drives sweep phase)
 * @param baseRgb verb base color
 * @param shimmerRgb highlight color mixed toward white
 */
export function colorSweep(
	text: string,
	frame: number,
	baseRgb: Rgb,
	shimmerRgb: Rgb,
	bandWidth = SHIMMER_BAND_WIDTH,
): string {
	if (!text) return "";
	const total = text.length;
	if (total === 0) return "";
	if (total === 1) return `${rgbToFgAnsi(shimmerRgb)}${text}${RESET}`;
	const cycle = Math.max(1, (total - 1) * 2);
	const c = ((frame % cycle) + cycle) % cycle;
	const pos = c < total ? c : cycle - c;
	const sigma = bandWidth / 2.2;
	let out = "";
	for (let i = 0; i < text.length; i++) {
		const dist = (i - pos + total) % total;
		if (dist < bandWidth) {
			// Gaussian falloff: 0->1, 1->0.86, 2->0.54, 3->0.25, 4->0.08
			const w = Math.exp(-(dist * dist) / (2 * sigma * sigma));
			const rgb = mixRgb(baseRgb, shimmerRgb, w);
			out += `${rgbToFgAnsi(rgb)}${text[i]}`;
		} else {
			out += `${rgbToFgAnsi(baseRgb)}${text[i]}`;
		}
	}
	out += RESET;
	return out;
}

// Cache for resolveShimmerColors — avoids parse+mix on every 16ms tick.
let _shimmerCacheAnsi: string | null = null;
let _shimmerCacheValue: { baseRgb: Rgb; shimmerRgb: Rgb } | null = null;

export function resolveShimmerColors(baseAnsi: string): {
	baseRgb: Rgb;
	shimmerRgb: Rgb;
} {
	if (_shimmerCacheAnsi === baseAnsi && _shimmerCacheValue) return _shimmerCacheValue;
	const fallback = hexToRgb("#b1b9f9") ?? { r: 177, g: 185, b: 249 };
	const baseRgb = parseAnsiRgb(baseAnsi) ?? fallback;
	// Lighten toward white — keep in blue family.
	let shimmerRgb = mixRgb(baseRgb, { r: 255, g: 255, b: 255 }, 0.48);
	const avgDelta =
		(shimmerRgb.r - baseRgb.r + shimmerRgb.g - baseRgb.g + shimmerRgb.b - baseRgb.b) / 3;
	if (avgDelta < 18) {
		shimmerRgb = mixRgb(baseRgb, { r: 255, g: 255, b: 255 }, 0.62);
	}
	const value = { baseRgb, shimmerRgb };
	_shimmerCacheAnsi = baseAnsi;
	_shimmerCacheValue = value;
	return value;
}

export function getShimmerIntervalMs(verbLength: number): number {
	const raw = 130 - verbLength * 2;
	return Math.max(90, Math.min(raw, 122));
}
