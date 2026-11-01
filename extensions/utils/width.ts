/**
 * 快速终端列宽测量。
 *
 * pi-tui 的 `visibleWidth` 只要字符串里出现一个非 ASCII 字形，就会放弃 ASCII 快速
 * 路径，改为整行 `Intl.Segmenter` 字素切分；diff 行前缀的 `│`/`▎` 正好命中这条路，
 * 实测 16–25µs/行。这里用一条受限的单遍扫描覆盖「ASCII + 本扩展自绘装饰字形」这
 * 类绝大多数行，遇到未知字符/组合簇/宽字符时原样回落 `visibleWidth`，因此结果与
 * pi-tui 始终一致。
 *
 * 白名单在模块初始化时用 `visibleWidth` 逐个校验：只有真实宽度为 1 的字形才进表，
 * 表外字符一律回落。ANSI 解析规则与 pi-tui `ansiCodeLength` 保持一致（CSI 只认
 * m/G/K/H/J，OSC/APC 到 BEL 或 ST），保证剥离边界不漂移。
 */
import { visibleWidth } from "@earendil-works/pi-tui";

/** 本扩展自绘的装饰字形；不在表内的字符一律回落 `visibleWidth`。 */
const CANDIDATE_GLYPHS = "│┃┆┊▎▏▌▐⋮…·•›‹─━┄┈↳↴⏺⏵⎿✓✗⚠↑↓←→▸▾▴◂⌄⌃⏶⏷■□●○◆◇";

const SINGLE_WIDTH_GLYPHS = new Map<number, number>();
for (const glyph of CANDIDATE_GLYPHS) {
	const codePoint = glyph.codePointAt(0);
	if (codePoint === undefined) continue;
	if (visibleWidth(glyph) === 1) SINGLE_WIDTH_GLYPHS.set(codePoint, 1);
}

/** 与 pi-tui `ansiCodeLength` 同规则；返回 0 表示无法识别（调用方回落）。 */
function ansiSequenceLength(text: string, pos: number): number {
	const next = text[pos + 1];
	if (next === "[") {
		for (let index = pos + 2; index < text.length; index++) {
			const code = text.charCodeAt(index);
			if (code === 0x6d || code === 0x47 || code === 0x4b || code === 0x48 || code === 0x4a) {
				return index + 1 - pos;
			}
		}
		return 0;
	}
	if (next === "]" || next === "_") {
		for (let index = pos + 2; index < text.length; index++) {
			const code = text.charCodeAt(index);
			if (code === 0x07) return index + 1 - pos;
			if (code === 0x1b && text[index + 1] === "\\") return index + 2 - pos;
		}
		return 0;
	}
	return 0;
}

/**
 * 终端列宽；与 `visibleWidth` 等值，但对 ASCII + 装饰字形走单遍扫描。
 * 无法判定的输入直接委托 pi-tui，避免维护第二套 Unicode 宽度表。
 */
export function measureWidth(text: string): number {
	if (text.length === 0) return 0;

	let width = 0;
	let index = 0;
	while (index < text.length) {
		const code = text.charCodeAt(index);
		// 可打印 ASCII
		if (code >= 0x20 && code <= 0x7e) {
			width++;
			index++;
			continue;
		}
		if (code === 0x1b) {
			const length = ansiSequenceLength(text, index);
			if (length === 0) return visibleWidth(text);
			index += length;
			continue;
		}
		// 与 pi-tui 一致：制表符按 3 列计
		if (code === 0x09) {
			width += 3;
			index++;
			continue;
		}
		// 其余控制字符交给 pi-tui（可能被忽略或参与字素簇）
		if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return visibleWidth(text);

		const codePoint = text.codePointAt(index);
		if (codePoint === undefined) return visibleWidth(text);
		const glyphWidth = SINGLE_WIDTH_GLYPHS.get(codePoint);
		if (glyphWidth === undefined) return visibleWidth(text);
		width += glyphWidth;
		index += codePoint > 0xffff ? 2 : 1;
	}
	return width;
}
