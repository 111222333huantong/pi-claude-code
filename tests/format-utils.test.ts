import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { formatDuration, oneLine, truncateByWidth } from "../extensions/utils/format.ts";

test("formatDuration formats elapsed seconds", () => {
	assert.equal(formatDuration(999), "");
	assert.equal(formatDuration(1_000), "1s");
	assert.equal(formatDuration(62_000), "1m 2s");
	assert.equal(formatDuration(3_721_000), "1h 2m 1s");
});

test("oneLine: 默认 max=96，超长截断加省略号", () => {
	const long = "x".repeat(120);
	const out = oneLine(long);
	assert.equal(out.length, 96);
	assert.equal(out.endsWith("…"), true);
	assert.equal(out, `${"x".repeat(95)}…`);
});

test("oneLine: 显式 max 覆盖默认；空白折叠为单行", () => {
	assert.equal(oneLine("a\n\tb  c", 10), "a b c");
	assert.equal(oneLine("hello world", 8), "hello w…");
	assert.equal(oneLine(null), "");
	assert.equal(oneLine(undefined), "");
});

test("oneLine: sanitize 上限 4096，避免扫超大输入", () => {
	// 超过 4096 的前缀被截断后再折叠；结果长度仍受 max 约束
	const huge = `${"y".repeat(5000)}\nmore`;
	const out = oneLine(huge, 20);
	assert.equal(out.length, 20);
	assert.equal(out.startsWith("y"), true);
});

test("truncateByWidth: CJK 计 2 列，不断半个宽字符", () => {
	// max=10 → 预算 9 列 → 4 汉字（8 列）+ …
	assert.equal(truncateByWidth("中文路径测试长", 10), "中文路径…");
	assert.equal(visibleWidth(truncateByWidth("中文路径测试长", 10)), 9);
	// 放得下原样返回；ASCII 与旧 slice 行为一致
	assert.equal(truncateByWidth("hello", 10), "hello");
	assert.equal(truncateByWidth("hello world", 8), "hello w…");
	assert.equal(truncateByWidth("abc", 0), "");
	assert.equal(truncateByWidth("纯中文", 7), "纯中文");
});
