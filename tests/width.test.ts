import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { measureWidth } from "../extensions/utils/width.ts";

/**
 * measureWidth 是 visibleWidth 的快速路径：只要结果与 pi-tui 不一致，
 * 布局就会出现 1 列漂移。这里用一批真实出现过的行做等值断言。
 */
const SAMPLES: string[] = [
	"",
	"plain ascii",
	"  indented  ",
	"\x1b[32m+\x1b[0m const value = 1;",
	"\x1b[38;2;120;200;120m│ +12 │\x1b[0m const x = 1;",
	"│ ▎ ▏ ⋮ ↳ ⏺ ⎿ … · • ›",
	"┃┆┊▌▐─━┄┈↴⏵✓✗!↑↓←→▸▾▴◂⌄⌃⏶⏷■□●○◆◇",
	"中文路径测试",
	"│ 中文内容 │",
	"e\u0301clair",
	"👨‍👩‍👧‍👦 family",
	"🇨🇳 flag",
	"👍🏽 ok",
	"a\tb",
	"\x1b]8;;https://example.com\x07link\x1b]8;;\x07",
	"\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\",
	"\x1b[?25lhidden cursor\x1b[?25h",
	"\x1b[2Jclear",
	"\x00control",
	"\x7fdelete",
	"\x1b_Ga=T,f=100;image\x1b\\",
	"mixed │ ascii \x1b[1mbold\x1b[0m 中文 👨‍👩‍👧‍👦",
];

test("measureWidth: 与 visibleWidth 逐条等值", () => {
	for (const sample of SAMPLES) {
		assert.equal(
			measureWidth(sample),
			visibleWidth(sample),
			`mismatch for ${JSON.stringify(sample)}`,
		);
	}
});

test("measureWidth: 纯 ASCII 与装饰字形走快路径且结果正确", () => {
	assert.equal(measureWidth("abc"), 3);
	assert.equal(measureWidth("│ +12 │"), 7);
	assert.equal(measureWidth("\x1b[31mred\x1b[0m"), 3);
	assert.equal(measureWidth("a\tb"), 5);
});

test("measureWidth: 未知字符回落 visibleWidth（宽字符/emoji 仍正确）", () => {
	for (const sample of ["中文", "👨‍👩‍👧‍👦", "🇨🇳", "👍🏽"]) {
		assert.equal(measureWidth(sample), visibleWidth(sample));
	}
});
