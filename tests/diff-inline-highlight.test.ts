import assert from "node:assert/strict";
import test from "node:test";
import { computeInlineDiffSpans } from "../extensions/renderer/tool/diff/diff-inline.ts";

test("改一个值仍做词级高亮", () => {
	const spans = computeInlineDiffSpans("const foo = 1;", "const foo = 2;");
	assert.ok(spans.left.length > 0, "左侧应标出改动区间");
	assert.ok(spans.right.length > 0, "右侧应标出改动区间");
});

test("完全重写的行不叠加词级高亮", () => {
	const spans = computeInlineDiffSpans("alpha beta gamma", "one two three");
	assert.deepEqual(spans.left, []);
	assert.deepEqual(spans.right, []);
});

test("只共享标点的改写也不高亮", () => {
	const spans = computeInlineDiffSpans("delete foo.bar();", "return baz;");
	assert.deepEqual(spans.left, []);
	assert.deepEqual(spans.right, []);
});

test("超过长度上限的行不做词级高亮", () => {
	const spans = computeInlineDiffSpans(
		`const a = "${"x".repeat(800)}";`,
		`const a = "${"y".repeat(800)}";`,
	);
	assert.deepEqual(spans.left, []);
	assert.deepEqual(spans.right, []);
});
