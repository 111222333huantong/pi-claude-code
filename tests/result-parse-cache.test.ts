import assert from "node:assert/strict";
import test from "node:test";
import { outputLineCount, resultBodyLines } from "../extensions/renderer/tool/result.ts";

test("resultBodyLines: 同一 result 对象复用缓存，源文本变化后失效", () => {
	const result = {
		content: [
			{
				type: "text",
				text: "a\nb\n[500 entries limit reached. Use limit=1000 for more]",
			},
		],
	};
	const first = resultBodyLines(result);
	assert.deepEqual(first, ["a", "b"]);
	assert.equal(resultBodyLines(result), first, "重复调用返回同一个数组");
	result.content[0]!.text = "c\n";
	assert.deepEqual(resultBodyLines(result), ["c"]);
});

test("outputLineCount: CRLF 与尾部空行按原口径计数", () => {
	assert.equal(outputLineCount({ content: [{ type: "text", text: "a\r\nb\r\n\r\n" }] }), 2);
	assert.equal(outputLineCount({ content: [{ type: "text", text: "one" }] }), 1);
	assert.equal(outputLineCount({ content: [] }), 0);
	assert.equal(outputLineCount({ content: [{ type: "text", text: "" }] }), 0);
});
