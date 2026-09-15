/**
 * Write diff 基准：Myers 精确统计 + 展开渲染耗时（行数 500→4000）。
 * 用法：node scripts/benchmark-write-diff.ts（type-stripping 直跑，无需构建）。
 * 改 diff 相关代码前后各跑一次，对比耗时。
 */
import { performance } from "node:perf_hooks";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { renderWriteDiffResult } from "../extensions/renderer/tool/diff/diff-renderer.ts";
import { countWriteDiffStats } from "../extensions/renderer/tool/diff/diff-write-render.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "../extensions/renderer/tool/diff/index.ts";

// 高亮需要先初始化主题（与测试 harness 一致）。
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

function makeLines(count: number, tag: string): string {
	return Array.from({ length: count }, (_, i) => `const ${tag}${i} = ${i};`).join("\n");
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function bench(label: string, fn: () => void, iters = 5): number {
	// 首轮预热（JIT + shiki 懒加载），取后 N 轮中位数。
	fn();
	const samples: number[] = [];
	for (let i = 0; i < iters; i++) {
		const start = performance.now();
		fn();
		samples.push(performance.now() - start);
	}
	const ms = median(samples);
	console.log(`${label}: ${ms.toFixed(1)}ms (median of ${iters})`);
	return ms;
}

const SIZES = [500, 1500, 3000, 4000];
for (const size of SIZES) {
	const oldText = makeLines(size, "old");
	const lines = oldText.split("\n");
	// 约 5% 行改动 + 尾部追加，模拟真实 overwrite。
	for (let i = 0; i < lines.length; i += 20) lines[i] = `const changed${i} = ${i};`;
	const newText = `${lines.join("\n")}\nconst appended = 1;`;
	console.log(`--- ${size} lines ---`);
	bench("countWriteDiffStats", () => {
		countWriteDiffStats(newText, oldText, true);
	});
	bench("renderWriteDiffResult expanded render(120)", () => {
		renderWriteDiffResult(
			newText,
			{
				expanded: true,
				filePath: "bench.ts",
				previousContent: oldText,
				fileExistedBeforeWrite: true,
			},
			{ ...DEFAULT_TOOL_DISPLAY_CONFIG },
			theme,
			"",
		).render(120);
	});
}
