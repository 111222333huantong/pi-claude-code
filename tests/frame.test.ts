import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	FRAME_MIN_WIDTH,
	frameBottom,
	frameDivider,
	frameHeader,
	frameRow,
} from "../extensions/utils/frame.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

test("frameHeader embeds the title and keeps [esc] on the hitbox columns", () => {
	const header = frameHeader(theme, 64, "Context Usage", { meta: "[esc]" });
	assert.equal(header, `╭─ Context Usage ${"─".repeat(40)} [esc]╮`);
	assert.equal(visibleWidth(header), 64);
	// [esc] 占 0-based 58..62（= width-6..width-2），转 1-based 即 left+width-5..left+width-1，
	// 与 escCloseHitbox 精确对齐；右角 ╮ 恰在最后一列。
	assert.equal(header.slice(58, 63), "[esc]");
	assert.equal(header[63], "╮");

	const noMeta = frameHeader(theme, 40, "Preview");
	assert.equal(noMeta, `╭─ Preview ${"─".repeat(28)}╮`);
	assert.equal(visibleWidth(noMeta), 40);
});

test("frameHeader truncates long titles without breaking geometry", () => {
	const clipped = frameHeader(theme, 20, "A very long dialog title", { meta: "[esc]" });
	assert.equal(visibleWidth(clipped), 20, "结构行几何恒等于 width");
	assert.ok(!clipped.includes("dialog title"), "长标题按列截断");
	assert.ok(clipped.endsWith("[esc]╮"));
});

test("frame degrades to flat text below FRAME_MIN_WIDTH", () => {
	assert.equal(FRAME_MIN_WIDTH, 12);
	assert.equal(frameHeader(theme, 10, "Tiny"), "Tiny");
	assert.equal(frameRow(theme, 8, "content"), "content");
	assert.equal(frameDivider(theme, 11), "");
	assert.equal(frameBottom(theme, 11), "");
});

test("frameRow pads content to width-4 and truncates overflow", () => {
	const row = frameRow(theme, 20, "hello");
	assert.equal(visibleWidth(row), 20);
	assert.ok(row.startsWith("│ hello"), "正文左留白 1 列");
	assert.ok(row.endsWith(" │"), "正文右留白 1 列");

	const overflow = frameRow(theme, 12, "x".repeat(50));
	assert.equal(visibleWidth(overflow), 12, "超宽正文截断不破框");
	assert.ok(overflow.includes("…"), '正文用 … 截断（区别于结构行的 ""）');
});

test("frameDivider and frameBottom span the full width", () => {
	assert.equal(frameDivider(theme, 16), `├${"─".repeat(14)}┤`);
	assert.equal(frameBottom(theme, 16), `╰${"─".repeat(14)}╯`);
	assert.equal(visibleWidth(frameDivider(theme, 64)), 64);
	assert.equal(visibleWidth(frameBottom(theme, 64)), 64);
});
