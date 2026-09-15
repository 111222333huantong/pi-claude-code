import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { renderWriteDiffResult } from "../extensions/renderer/tool/diff/diff-renderer.ts";
import { countWriteDiffStats } from "../extensions/renderer/tool/diff/diff-write-render.ts";
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

function renderOverwriteExpanded(previousContent: string, content: string, width = 100): string[] {
	return renderWriteDiffResult(
		content,
		{
			expanded: true,
			filePath: "sample.ts",
			previousContent,
			fileExistedBeforeWrite: true,
		},
		{ ...DEFAULT_TOOL_DISPLAY_CONFIG },
		theme,
		"",
	).render(width);
}

test("myers overwrite: 增删计数精确（旧 LCS 对拍口径）", () => {
	assert.deepEqual(countWriteDiffStats("a\nb\nc", "a\nB\nc", true), { added: 1, removed: 1 });
	assert.deepEqual(countWriteDiffStats("a\nb\nc\nd", "a\nb", true), { added: 2, removed: 0 });
	assert.deepEqual(countWriteDiffStats("a", "a\nb\nc", true), { added: 0, removed: 2 });
	assert.deepEqual(countWriteDiffStats("same", "same", true), { added: 0, removed: 0 });
	assert.deepEqual(countWriteDiffStats("new\n", undefined, false), { added: 1, removed: 0 });
	assert.equal(countWriteDiffStats(undefined, "old", true), undefined);
	assert.equal(countWriteDiffStats("new", undefined, true), undefined);
});

test("myers overwrite: 超 4000 行熔断（旧矩阵 guard 的线性替代）", () => {
	const big = Array.from({ length: 4001 }, (_, i) => `line ${i}`).join("\n");
	assert.equal(countWriteDiffStats(big, "small", true), undefined);
	assert.equal(countWriteDiffStats("small", big, true), undefined);
	const edge = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join("\n");
	assert.deepEqual(countWriteDiffStats(edge, edge, true), { added: 0, removed: 0 });
});

test("myers overwrite: 远距离两处改动折成 2 hunk（context:3，旧全文展开的预期变化）", () => {
	const oldLines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
	const newLines = [...oldLines];
	newLines[1] = "CHANGED-2";
	newLines[27] = "CHANGED-28";
	const rows = stripVTControlCharacters(
		renderOverwriteExpanded(oldLines.join("\n"), newLines.join("\n")).join("\n"),
	);
	assert.match(rows, /CHANGED-2/);
	assert.match(rows, /CHANGED-28/);
	// 中间未改动行被折叠，不全文展开。
	assert.doesNotMatch(rows, /line 15/);
});

test("myers overwrite: 内容一致时全量 context（不显示 empty file）", () => {
	const rows = renderOverwriteExpanded("a\nb", "a\nb").join("\n");
	assert.match(rows, /\ba\b/);
	assert.match(rows, /\bb\b/);
	assert.doesNotMatch(rows, /empty file/);
});

test("myers overwrite: 行号连续、无 `\\ No newline` 残留", () => {
	const rows = renderOverwriteExpanded("old", "new", 100).join("\n");
	assert.match(rows, /old/);
	assert.match(rows, /new/);
	assert.doesNotMatch(rows, /No newline/);
	assert.deepEqual(countWriteDiffStats("old", "new", true), { added: 1, removed: 1 });
});

test("myers overwrite: 3000 行大文件毫秒级（旧 O(N*M) 会触熔断）", () => {
	const oldLines = Array.from({ length: 3000 }, (_, i) => `old ${i}`);
	const newLines = Array.from({ length: 3000 }, (_, i) => (i % 2 === 0 ? `old ${i}` : `new ${i}`));
	const start = performance.now();
	const stats = countWriteDiffStats(newLines.join("\n"), oldLines.join("\n"), true);
	const elapsed = performance.now() - start;
	assert.deepEqual(stats, { added: 1500, removed: 1500 });
	assert.ok(elapsed < 2000, `myers 3000 行应在 2s 内，实际 ${elapsed.toFixed(0)}ms`);
});
