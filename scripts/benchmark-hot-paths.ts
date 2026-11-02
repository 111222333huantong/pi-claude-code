/**
 * 热路径基准：状态栏用量增量、bash 尾预览、展开态大 diff 上限。
 *
 * 两种用法：
 * - `node scripts/benchmark-hot-paths.ts`：打印便于人读的表格
 * - `node scripts/benchmark-hot-paths.ts --json`：输出机器可读 JSON（门禁用）
 * - `node scripts/benchmark-hot-paths.ts --update-baseline`：重写基线文件
 *
 * 每个指标同时记录原始耗时与「归一化耗时」（除以同机 calibration 指标），
 * 后者用于跨机器比较：CI runner 通常比开发机慢，只看绝对值会误报。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
	AssistantMessageComponent,
	generateDiffString,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import { config } from "../extensions/config/config.ts";
import { collectUsage } from "../extensions/feature/statusline/usage.ts";
import {
	_setStreamThrottleClock,
	_setStreamThrottleEnabledForTests,
	installStreamThrottle,
} from "../extensions/renderer/stream-throttle.ts";
import { bashLivePreview } from "../extensions/renderer/tool/bash-preview.ts";
import { renderEditDiffResult } from "../extensions/renderer/tool/diff/diff-renderer.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "../extensions/renderer/tool/diff/index.ts";
import { measureWidth } from "../extensions/utils/width.ts";

export type BenchMetric = {
	/** 每次调用耗时（ms）。 */
	ms: number;
	/** 除以 calibration 后的相对值；calibration 本身为 1。 */
	normalized: number;
	/** 每轮调用次数。 */
	iterations: number;
};

export type BenchResult = {
	metrics: Record<string, BenchMetric>;
	/** 便于人工核对的附加信息（数据规模、渲染行数）。 */
	info: Record<string, number>;
};

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const BASELINE_PATH = join(SCRIPT_DIR, "bench-baseline.json");

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** 先预热，再取 5 轮样本的中位数；iterations 是每轮调用次数。 */
function measure(fn: () => void, iterations = 5): number {
	fn();
	const samples: number[] = [];
	for (let round = 0; round < 5; round++) {
		const start = performance.now();
		for (let index = 0; index < iterations; index++) fn();
		samples.push((performance.now() - start) / iterations);
	}
	return median(samples);
}

/**
 * 跑完整套基准。单独导出给门禁脚本复用，避免两套测量逻辑漂移。
 */
export function runHotPathBenchmarks(): BenchResult {
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

	const metrics: Record<string, BenchMetric> = {};
	const info: Record<string, number> = {};

	// --- calibration：本扩展最热的字符串宽度测量，用作跨机器归一化 --------
	const calibrationText = `\x1b[38;2;120;200;120m│ +12 │\x1b[0m const value = ${"x".repeat(80)}`;
	const calibrationMs = measure(() => measureWidth(calibrationText), 20_000);
	metrics["calib: measureWidth"] = {
		ms: calibrationMs,
		normalized: 1,
		iterations: 20_000,
	};

	const record = (label: string, ms: number, iterations: number) => {
		metrics[label] = {
			ms,
			normalized: calibrationMs > 0 ? ms / calibrationMs : 0,
			iterations,
		};
	};

	// --- 状态栏用量：全量扫描 vs 同叶子缓存 vs 新增 1 条 ---------------------
	const ENTRY_COUNT = 20_000;
	info["session entries"] = ENTRY_COUNT;
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
	record(
		"usage: full scan",
		measure(() => collectUsage(usageSource, null), 5),
		5,
	);
	record(
		"usage: same leaf (cached)",
		measure(() => collectUsage(usageSource, full.cache), 5_000),
		5_000,
	);

	const nextEntry = {
		id: `e${ENTRY_COUNT}`,
		parentId: `e${ENTRY_COUNT - 1}`,
		type: "message",
		message: { role: "assistant", usage: { input: 1, output: 1, cost: { total: 0.0001 } } },
	};
	entries.push(nextEntry);
	byId.set(nextEntry.id, nextEntry);
	leaf = nextEntry.id;
	record(
		"usage: incremental +1 entry",
		measure(() => collectUsage(usageSource, full.cache), 1_000),
		1_000,
	);

	// --- bash 尾预览：6.2MB / 20 万行 ---------------------------------------
	const bashLines = Array.from(
		{ length: 200_000 },
		(_, index) => `line-${index}-${"x".repeat(20)}`,
	);
	const bashText = bashLines.join("\n");
	info["bash MB"] = Number((bashText.length / 1024 / 1024).toFixed(1));
	info["bash lines"] = bashLines.length;
	// 轮换 6 份略有差异的输入，避免命中“上一次结果”缓存，测到真实的尾扫成本。
	const bashVariants = Array.from({ length: 6 }, (_, index) => `${bashText}\ntail-${index}`);
	let bashCursor = 0;
	record(
		"bash preview: tail scan",
		measure(() => {
			const text = bashVariants[bashCursor++ % bashVariants.length]!;
			bashLivePreview(text, 5);
		}, 5),
		5,
	);
	record(
		"bash preview: same input cached",
		measure(() => bashLivePreview(bashText, 5), 2_000),
		2_000,
	);

	// 流式追加：先预热上一段，只计“上一段 + 新一行”这次调用。
	const appendSamples: number[] = [];
	for (let index = 0; index < 20; index++) {
		bashLivePreview(bashText, 5);
		const next = `${bashText}\nnext-${index}`;
		const start = performance.now();
		bashLivePreview(next, 5);
		appendSamples.push(performance.now() - start);
	}
	record("bash preview: append 1 line", median(appendSamples), 1);

	// --- assistant 流式渲染：每个 token 重建整段 Markdown 的真实成本 --------
	// 与 Pi 1.4 的 message_update 行为一致：同一条消息逐步变长，每次
	// updateContent + render。节流版用 16ms/帧的合成时钟推进，等价于 60fps 流。
	const latinStream = "The quick brown fox jumps over the lazy dog. **bold** `code`\n\n".repeat(
		900,
	);
	const cjkStream = "这是一个用于测试流式渲染性能的中文段落，包含 **粗体** 和 `代码`。\n\n".repeat(
		600,
	);
	info["stream chars"] = latinStream.length;
	const STREAM_UPDATES = 40;
	type StreamRunOptions = {
		/** 是否每帧调用 render（默认 true，匹配 Pi 的 message_update + requestRender）。 */
		render?: boolean;
		onUpdate?: (index: number) => void;
	};
	const runStream = (text: string, options: StreamRunOptions = {}): number => {
		const { render = true, onUpdate } = options;
		const message: any = {
			role: "assistant",
			timestamp: 1,
			content: [{ type: "text", text: "" }],
		};
		const component: any = new AssistantMessageComponent(message, true);
		const start = performance.now();
		for (let index = 1; index <= STREAM_UPDATES; index++) {
			onUpdate?.(index);
			message.content[0].text = text.slice(0, Math.floor((text.length * index) / STREAM_UPDATES));
			component.updateContent(message, true);
			if (render) component.render(100);
		}
		// message_end：最终帧无条件渲染。
		component.updateContent(message, false);
		if (render) component.render(100);
		return performance.now() - start;
	};
	/** 内容不变时重复 render：节流后 Pi 仍会每 token requestRender 的真实成本。 */
	const runRenderOnly = (text: string): number => {
		const message: any = {
			role: "assistant",
			timestamp: 1,
			content: [{ type: "text", text }],
		};
		const component: any = new AssistantMessageComponent(message, true);
		component.updateContent(message, false);
		component.render(100);
		const start = performance.now();
		for (let index = 0; index < STREAM_UPDATES; index++) component.render(100);
		return performance.now() - start;
	};
	record(
		"stream: latin 40 updates",
		measure(() => runStream(latinStream), 1),
		1,
	);
	record(
		"stream: cjk 40 updates",
		measure(() => runStream(cjkStream), 1),
		1,
	);
	record(
		"stream: latin 40 updates (update only)",
		measure(() => runStream(latinStream, { render: false }), 1),
		1,
	);
	record(
		"stream: cjk 40 updates (update only)",
		measure(() => runStream(cjkStream, { render: false }), 1),
		1,
	);
	record(
		"stream: latin 40 renders",
		measure(() => runRenderOnly(latinStream), 1),
		1,
	);
	record(
		"stream: cjk 40 renders",
		measure(() => runRenderOnly(cjkStream), 1),
		1,
	);

	const previousThrottle = config.streamThrottleMs;
	config.streamThrottleMs = 100;
	_setStreamThrottleEnabledForTests(true);
	const streamThrottle = installStreamThrottle();
	try {
		let clock = 0;
		_setStreamThrottleClock(() => clock);
		const runThrottled = (text: string): number => {
			clock = 0;
			return runStream(text, {
				onUpdate: () => {
					clock += 16;
				},
			});
		};
		record(
			"stream: latin 40 updates (throttled)",
			measure(() => runThrottled(latinStream), 1),
			1,
		);
		record(
			"stream: cjk 40 updates (throttled)",
			measure(() => runThrottled(cjkStream), 1),
			1,
		);
	} finally {
		streamThrottle.dispose();
		_setStreamThrottleClock(null);
		_setStreamThrottleEnabledForTests(false);
		config.streamThrottleMs = previousThrottle;
	}

	// --- 展开态大 diff：先渲染 2000 行前缀 ----------------------------------
	const before = Array.from({ length: 2_200 }, (_, index) => `old ${index}`).join("\n");
	const after = Array.from({ length: 2_200 }, (_, index) => `new ${index}`).join("\n");
	const diff = generateDiffString(before, after).diff;
	let renderedRows = 0;
	const cappedMs = measure(() => {
		const component = renderEditDiffResult(
			{ diff },
			{ expanded: true, filePath: "sample.ts" },
			{ ...DEFAULT_TOOL_DISPLAY_CONFIG, diffViewMode: "unified", diffWordWrap: false },
			theme,
			"",
		);
		renderedRows = component.render(100).length;
	}, 3);
	record("diff: expanded capped (2200 lines)", cappedMs, 3);
	info["capped rows"] = renderedRows;

	let fullRows = 0;
	const uncappedMs = measure(() => {
		const component = renderEditDiffResult(
			{ diff },
			{ expanded: true, renderAll: true, filePath: "sample.ts" },
			{ ...DEFAULT_TOOL_DISPLAY_CONFIG, diffViewMode: "unified", diffWordWrap: false },
			theme,
			"",
		);
		fullRows = component.render(100).length;
	}, 1);
	record("diff: expanded uncapped (2200 lines)", uncappedMs, 1);
	info["uncapped rows"] = fullRows;

	return { metrics, info };
}

function formatMs(ms: number): string {
	return ms < 0.001 ? "<0.001" : ms.toFixed(3);
}

function printHuman(result: BenchResult): void {
	for (const [label, value] of Object.entries(result.metrics)) {
		console.log(`${label.padEnd(34)} ${formatMs(value.ms)} ms/call`);
	}
	for (const [label, value] of Object.entries(result.info)) {
		console.log(`${label}: ${value}`);
	}
}

function readBaseline():
	| { metrics?: Record<string, { ms: number; normalized?: number }> }
	| undefined {
	try {
		return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
	} catch {
		return undefined;
	}
}

function main(): void {
	const args = new Set(process.argv.slice(2));
	const result = runHotPathBenchmarks();

	if (args.has("--json")) {
		console.log(JSON.stringify(result, null, 2));
	} else {
		printHuman(result);
	}

	if (args.has("--update-baseline")) {
		const payload = {
			generatedAt: new Date().toISOString(),
			node: process.version,
			platform: `${process.platform}/${process.arch}`,
			metrics: result.metrics,
			info: result.info,
		};
		writeFileSync(BASELINE_PATH, `${JSON.stringify(payload, null, "\t")}\n`);
		console.log(`baseline written: ${BASELINE_PATH}`);
	} else if (args.has("--check")) {
		const baseline = readBaseline();
		if (!baseline?.metrics) {
			console.error(`baseline missing: ${BASELINE_PATH}`);
			process.exit(1);
		}
		const failures: string[] = [];
		const tolerance = Number(process.env.BENCH_TOLERANCE ?? 1.8);
		// 绝对值差小于该值时只报不拦：缓存类指标本来就在 1µs 量级，噪声占比大。
		const noiseFloorMs = Number(process.env.BENCH_NOISE_FLOOR_MS ?? 0.3);
		for (const [label, current] of Object.entries(result.metrics)) {
			const base = baseline.metrics[label];
			if (!base || base.ms <= 0) continue;
			if (base.ms < 0.05) continue;
			const ratio = current.ms / base.ms;
			// 优先用 calibration 归一化后的比值：CI runner 比开发机慢是常态，
			// 只看绝对值会把「换机器」误判成「性能回退」。
			const normalizedRatio =
				base.normalized && current.normalized ? current.normalized / base.normalized : ratio;
			const gateRatio = normalizedRatio;
			const delta = current.ms - base.ms;
			if (gateRatio > tolerance && delta > noiseFloorMs) {
				failures.push(
					`${label}: ${formatMs(base.ms)} -> ${formatMs(current.ms)} ms ` +
						`(normalized ${gateRatio.toFixed(2)}x, raw ${ratio.toFixed(2)}x, tolerance ${tolerance}x)`,
				);
			}
		}
		if (failures.length > 0) {
			console.error("\nperf gate failed:");
			for (const failure of failures) console.error(`  - ${failure}`);
			console.error(`\n若这是有意变更，运行 npm run bench:update 重写基线（${BASELINE_PATH}）。`);
			process.exit(1);
		}
		console.log(`\nperf gate ok (tolerance ${tolerance}x, noise floor ${noiseFloorMs}ms)`);
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}
