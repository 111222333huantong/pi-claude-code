/**
 * 热路径基准：状态栏用量增量、bash 尾预览、展开态大 diff 上限。
 * 用法：node scripts/benchmark-hot-paths.ts（type-stripping 直跑，无需构建）。
 * 改这几处前后各跑一次，对比中位数；不接入 CI 门禁，避免机器差异误报。
 */
import { performance } from "node:perf_hooks";
import { generateDiffString, initTheme } from "@earendil-works/pi-coding-agent";
import { collectUsage } from "../extensions/feature/statusline/usage.ts";
import { bashLivePreview } from "../extensions/renderer/tool/bash-preview.ts";
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

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** 先预热，再取 5 轮样本的中位数；iterations 是每轮调用次数。 */
function measure(label: string, fn: () => void, iterations = 5): number {
	fn();
	const samples: number[] = [];
	for (let round = 0; round < 5; round++) {
		const start = performance.now();
		for (let index = 0; index < iterations; index++) fn();
		samples.push((performance.now() - start) / iterations);
	}
	const ms = median(samples);
	const shown = ms < 0.001 ? "<0.001" : ms.toFixed(3);
	console.log(`${label.padEnd(34)} ${shown} ms/call`);
	return ms;
}

// --- 状态栏用量：全量扫描 vs 同叶子缓存 vs 新增 1 条 -------------------------
const ENTRY_COUNT = 20_000;
const entries: Array<{ id: string; parentId: string | null; type: string; message: any }> = [];
for (let index = 0; index < ENTRY_COUNT; index++) {
	entries.push({
		id: `e${index}`,
		parentId: index === 0 ? null : `e${index - 1}`,
		type: "message",
		message: {
			role: "assistant",
			usage: { input: 100, output: 20, cacheRead: 80, cacheWrite: 5, cost: { total: 0.001 } },
		},
	});
}
let leaf = `e${ENTRY_COUNT - 1}`;
const byId = new Map(entries.map((entry) => [entry.id, entry]));
const usageSource = {
	getLeafId: () => leaf,
	getEntry: (id: string) => byId.get(id),
	getBranch: () => entries,
};
const full = collectUsage(usageSource, null);
console.log(`session entries: ${ENTRY_COUNT}`);
measure("usage: full scan", () => collectUsage(usageSource, null), 5);
measure("usage: same leaf (cached)", () => collectUsage(usageSource, full.cache), 5_000);

const nextEntry = {
	id: `e${ENTRY_COUNT}`,
	parentId: `e${ENTRY_COUNT - 1}`,
	type: "message",
	message: { role: "assistant", usage: { input: 1, output: 1, cost: { total: 0.0001 } } },
};
entries.push(nextEntry);
byId.set(nextEntry.id, nextEntry);
leaf = nextEntry.id;
measure("usage: incremental +1 entry", () => collectUsage(usageSource, full.cache), 1_000);

// --- bash 尾预览：6.2MB / 20 万行 -------------------------------------------
const bashLines = Array.from({ length: 200_000 }, (_, index) => `line-${index}-${"x".repeat(20)}`);
const bashText = bashLines.join("\n");
console.log(
	`bash input: ${(bashText.length / 1024 / 1024).toFixed(1)} MB, ${bashLines.length} lines`,
);
// 轮换 6 份略有差异的输入，避免命中“上一次结果”缓存，测到真实的尾扫成本。
const bashVariants = Array.from({ length: 6 }, (_, index) => `${bashText}\ntail-${index}`);
let bashCursor = 0;
measure(
	"bash preview: tail scan",
	() => {
		const text = bashVariants[bashCursor++ % bashVariants.length]!;
		bashLivePreview(text, 5);
	},
	5,
);
measure("bash preview: same input cached", () => bashLivePreview(bashText, 5), 2_000);

// 流式追加：先预热上一段，只计“上一段 + 新一行”这次调用。
const appendSamples: number[] = [];
for (let index = 0; index < 20; index++) {
	bashLivePreview(bashText, 5);
	const next = `${bashText}\nnext-${index}`;
	const start = performance.now();
	bashLivePreview(next, 5);
	appendSamples.push(performance.now() - start);
}
console.log(
	`${"bash preview: append 1 line".padEnd(34)} ${median(appendSamples).toFixed(3)} ms/call`,
);

// --- 展开态大 diff：先渲染 2000 行前缀 --------------------------------------
const before = Array.from({ length: 2_200 }, (_, index) => `old ${index}`).join("\n");
const after = Array.from({ length: 2_200 }, (_, index) => `new ${index}`).join("\n");
const diff = generateDiffString(before, after).diff;
let renderedRows = 0;
measure(
	"diff: expanded capped (2200 lines)",
	() => {
		const component = renderEditDiffResult(
			{ diff },
			{ expanded: true, filePath: "sample.ts" },
			{ ...DEFAULT_TOOL_DISPLAY_CONFIG, diffViewMode: "unified", diffWordWrap: false },
			theme,
			"",
		);
		renderedRows = component.render(100).length;
	},
	3,
);
console.log(`capped rows: ${renderedRows}`);

let fullRows = 0;
measure(
	"diff: expanded uncapped (2200 lines)",
	() => {
		const component = renderEditDiffResult(
			{ diff },
			{ expanded: true, renderAll: true, filePath: "sample.ts" },
			{ ...DEFAULT_TOOL_DISPLAY_CONFIG, diffViewMode: "unified", diffWordWrap: false },
			theme,
			"",
		);
		fullRows = component.render(100).length;
	},
	1,
);
console.log(`uncapped rows: ${fullRows}`);
