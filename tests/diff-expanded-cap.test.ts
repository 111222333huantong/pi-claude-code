import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { generateDiffString, initTheme } from "@earendil-works/pi-coding-agent";
import {
	EXPANDED_DIFF_MAX_LINES,
	resolveDiffDisplayLimit,
} from "../extensions/renderer/tool/diff/diff-limits.ts";
import { renderEditDiffResult } from "../extensions/renderer/tool/diff/diff-renderer.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "../extensions/renderer/tool/diff/index.ts";

initTheme("dark");

const theme = {
	fg(_color: string, text: string) {
		return text;
	},
	bg(_color: string, text: string) {
		return text;
	},
	bold(text: string) {
		return text;
	},
} as any;

function bigDiff(lines: number): string {
	const before = Array.from({ length: lines }, (_, index) => `old ${index}`).join("\n");
	const after = Array.from({ length: lines }, (_, index) => `new ${index}`).join("\n");
	return generateDiffString(before, after).diff;
}

function plain(rows: string[]): string[] {
	return rows.map((row) => stripVTControlCharacters(row));
}

test("resolveDiffDisplayLimit: 展开态默认 2000 行，renderAll 才全量", () => {
	assert.equal(EXPANDED_DIFF_MAX_LINES, 2000);
	assert.equal(resolveDiffDisplayLimit(true, 24), 2000);
	assert.equal(resolveDiffDisplayLimit(true, 24, true), Number.POSITIVE_INFINITY);
	assert.equal(resolveDiffDisplayLimit(false, 24), 24);
});

test("大 diff 展开先渲染前缀并提示 render all，第二次点击才全量", () => {
	let showAllCalls = 0;
	const component = renderEditDiffResult(
		{ diff: bigDiff(2200) },
		{
			expanded: true,
			filePath: "sample.ts",
			onShowAll: () => {
				showAllCalls++;
			},
		},
		{ ...DEFAULT_TOOL_DISPLAY_CONFIG, diffViewMode: "unified", diffWordWrap: false },
		theme,
		"",
	) as any;

	assert.equal(component.isCapped(), true);
	const capped = plain(component.render(100));
	assert.ok(capped.length < 2100, `展开态先截断，实际 ${capped.length} 行`);
	assert.ok(
		capped.some((row) => row.includes("more diff lines") && row.includes("click to render all")),
		"末尾给出 render all 提示",
	);
	assert.ok(component.isCollapsedHintLine(capped.find((row) => row.includes("render all"))!));

	assert.equal(component.showAll(), true);
	assert.equal(showAllCalls, 1);
	assert.equal(component.isCapped(), false);

	const full = plain(component.render(100));
	assert.ok(full.length > capped.length + 1000, "第二次点击后渲染全量");
	assert.ok(!full.some((row) => row.includes("render all")), "全量后不再有提示");
});
