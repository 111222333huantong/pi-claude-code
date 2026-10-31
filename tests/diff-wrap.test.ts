import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { MAX_WRAPPED_LINES, wrapToWidth } from "../extensions/renderer/tool/diff/diff-text.ts";

test("超长单行最多展开 MAX_WRAPPED_LINES 行，并以 … 收尾", () => {
	const lines = wrapToWidth("x".repeat(5_000), 40, true);
	assert.equal(lines.length, MAX_WRAPPED_LINES);
	assert.match(lines.at(-1)!, /…/);
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 40, `line exceeds width: ${visibleWidth(line)}`);
	}
});

test("带颜色的超长行同样受限且不超宽", () => {
	const lines = wrapToWidth(`\x1b[31m${"z".repeat(5_000)}\x1b[0m`, 32, true);
	assert.equal(lines.length, MAX_WRAPPED_LINES);
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 32);
	}
});

test("普通长行仍然完整换行，不触发省略号", () => {
	const lines = wrapToWidth("y".repeat(200), 40, true);
	assert.equal(lines.length, 5);
	assert.equal(lines.at(-1)!.includes("…"), false);
});
