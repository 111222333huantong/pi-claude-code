/**
 * Pure terminal-color math for the spinner: xterm-256/truecolor ANSI ↔ RGB
 * parsing, hex conversion, and tint mixing. No module state — every function
 * takes its inputs directly.
 *
 * Ported from cc-my-pi's color-utils.ts subset (MIT, Tim van den Hoorn /
 * FammasMaz). Only the helpers the spinner shimmer needs are included.
 */

export type Rgb = { r: number; g: number; b: number };

export const ESC = "\u001B";
export const RESET = `${ESC}[0m`;
const FG = `${ESC}[38;2;`;

const CUBE_VALUES = [0, 95, 135, 175, 215, 255];

export function xterm256ToRgb(index: number): Rgb | null {
	if (!Number.isInteger(index) || index < 0 || index > 255) return null;
	if (index < 16) {
		const basic: Array<[number, number, number]> = [
			[0, 0, 0],
			[128, 0, 0],
			[0, 128, 0],
			[128, 128, 0],
			[0, 0, 128],
			[128, 0, 128],
			[0, 128, 128],
			[192, 192, 192],
			[128, 128, 128],
			[255, 0, 0],
			[0, 255, 0],
			[255, 255, 0],
			[0, 0, 255],
			[255, 0, 255],
			[0, 255, 255],
			[255, 255, 255],
		];
		const [r, g, b] = basic[index] ?? [255, 255, 255];
		return { r, g, b };
	}
	if (index < 232) {
		const i = index - 16;
		return {
			r: CUBE_VALUES[Math.floor(i / 36) % 6] ?? 0,
			g: CUBE_VALUES[Math.floor(i / 6) % 6] ?? 0,
			b: CUBE_VALUES[i % 6] ?? 0,
		};
	}
	const level = 8 + (index - 232) * 10;
	return { r: level, g: level, b: level };
}

export function parseAnsiRgb(ansi: string): Rgb | null {
	if (!ansi) return null;
	// Truecolor: ESC[38;2;R;G;Bm or ESC[48;2;R;G;Bm
	const tc = ansi.match(new RegExp(`${ESC}\\[(?:38|48);2;(\\d+);(\\d+);(\\d+)m`));
	if (tc) return { r: +tc[1], g: +(tc[2] ?? 0), b: +(tc[3] ?? 0) };
	// 256-color: ESC[38;5;Nm or ESC[48;5;Nm
	const idx = ansi.match(new RegExp(`${ESC}\\[(?:38|48);5;(\\d+)m`));
	if (idx) return xterm256ToRgb(+idx[1]);
	return null;
}

export function hexToFgAnsi(hex: string): string {
	if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return "";
	const r = Number.parseInt(hex.slice(1, 3), 16);
	const g = Number.parseInt(hex.slice(3, 5), 16);
	const b = Number.parseInt(hex.slice(5, 7), 16);
	return `${FG}${r};${g};${b}m`;
}

export function mixRgb(a: Rgb, b: Rgb, ratio: number): Rgb {
	return {
		r: a.r + (b.r - a.r) * ratio,
		g: a.g + (b.g - a.g) * ratio,
		b: a.b + (b.b - a.b) * ratio,
	};
}

export function rgbToFgAnsi(c: Rgb): string {
	return `${FG}${Math.round(c.r)};${Math.round(c.g)};${Math.round(c.b)}m`;
}

export function hexToRgb(hex: string): Rgb | null {
	if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex.trim())) return null;
	const n = Number.parseInt(hex.trim().slice(1), 16);
	return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}
