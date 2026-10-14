import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { config, getToolDisplayConfig } from "../extensions/config/config.ts";
import {
	_resetTicker,
	subscribeShimmer,
	subscribeTicker,
} from "../extensions/feature/shell/spinner-ticker.ts";
import { installDefaultMode } from "../extensions/renderer/default-mode.ts";
import { renderPendingDiffPreview } from "../extensions/renderer/tool/diff/pending-preview.ts";
import { WriteExecutionMetadataStore } from "../extensions/renderer/tool/diff/write-execution.ts";
import { clearAllAnimations } from "../extensions/renderer/tool/tool-state.ts";

initTheme("dark");

const ui = {
	theme: {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	},
	requestRender() {},
	setStatus() {},
} as any;

const theme = ui.theme;

function makeLines(count: number, tag: string): string {
	return Array.from({ length: count }, (_, i) => `const ${tag}${i} = ${i};`).join("\n");
}

function percentile(sorted: number[], p: number): number {
	return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

function installOnMode() {
	const previousMode = config.mode;
	config.mode = "on";
	const store = new WriteExecutionMetadataStore();
	const hooks = installDefaultMode(store);
	return {
		store,
		done() {
			clearAllAnimations();
			hooks.shutdown();
			config.mode = previousMode;
		},
	};
}

/** pending write 行：executionStarted + partial 结果（盲文动画路径）。 */
function pendingWrite(
	id: string,
	content: string,
	previousContent: string,
	store: WriteExecutionMetadataStore,
) {
	const tool = new ToolExecutionComponent(
		"write",
		id,
		{ path: "perf.ts", content },
		{},
		undefined,
		ui,
		process.cwd(),
	) as any;
	store.set(id, { fileExistedBeforeWrite: true, previousContent });
	tool.markExecutionStarted();
	tool.updateResult({ content: [{ type: "text", text: "partial" }], isError: false }, true);
	return tool;
}

test("T1: pending write 行单帧渲染 p95 < 50ms（0.5k/2k/8k 三档）", () => {
	const { store, done } = installOnMode();
	try {
		for (const size of [500, 2000, 8000]) {
			const oldText = makeLines(size, "old");
			const lines = oldText.split("\n");
			for (let i = 0; i < lines.length; i += 20) lines[i] = `const changed${i} = ${i};`;
			const tool = pendingWrite(`perf-${size}`, lines.join("\n"), oldText, store);
			const samples: number[] = [];
			for (let i = 0; i < 30; i++) {
				// 强制重算：否则组件级行缓存会让 2~30 次 render 都是 0ms，测不到真成本。
				tool.invalidate?.();
				const start = performance.now();
				tool.render(100);
				samples.push(performance.now() - start);
			}
			samples.sort((a, b) => a - b);
			const p50 = percentile(samples, 50);
			const p95 = percentile(samples, 95);
			assert.ok(
				p95 < 50,
				`${size} 行 pending 行 p95=${p95.toFixed(1)}ms（p50=${p50.toFixed(1)}ms），超过单帧预算 50ms，动画会跳拍`,
			);
		}
	} finally {
		done();
	}
});

test("T1b: pending 预览 plan+Myers 单次耗时预算（2k 行 < 500ms）", () => {
	const oldText = makeLines(2000, "old");
	const lines = oldText.split("\n");
	for (let i = 0; i < lines.length; i += 20) lines[i] = `const changed${i} = ${i};`;
	const context: any = {
		args: { path: "perf.ts", content: lines.join("\n") },
		cwd: process.cwd(),
	};
	const input = { expanded: false, displayConfig: getToolDisplayConfig, theme };
	const samples: number[] = [];
	for (let i = 0; i < 5; i++) {
		delete context.state;
		const start = performance.now();
		const component = renderPendingDiffPreview("write", context, input);
		assert.ok(component && typeof component.render === "function");
		samples.push(performance.now() - start);
	}
	samples.sort((a, b) => a - b);
	const worst = samples[samples.length - 1] ?? 0;
	assert.ok(worst < 500, `2k 行预览最慢一次 ${worst.toFixed(0)}ms，超过 500ms 预算`);
});

test("T2: pending 期间 shiki 异步升级不造成 invalidate 风暴（≤3 次）", async () => {
	const oldText = makeLines(60, "old");
	const lines = oldText.split("\n");
	lines[5] = "const changed5 = 5;";
	const context: any = {
		args: { path: "storm.ts", content: lines.join("\n") },
		cwd: process.cwd(),
	};
	let invalidations = 0;
	const input = {
		expanded: true,
		displayConfig: getToolDisplayConfig,
		theme,
		invalidate: () => {
			invalidations++;
		},
	};
	const component = renderPendingDiffPreview("write", context, input);
	assert.ok(component && typeof component.render === "function");
	component.render(100);
	// 等 shiki 异步升级落地（引擎懒加载 + 回调）。
	await new Promise((resolve) => setTimeout(resolve, 2500));
	assert.ok(
		invalidations <= 3,
		`pending 2.5s 内 invalidate 触发 ${invalidations} 次，超过 3 次即升级风暴，会打断盲文节拍`,
	);
});

test("T3: 双驱动节拍刻画（90ms braille + 16ms shimmer，mock 时钟确定性）", (t) => {
	t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
	try {
		const tickerStamps: number[] = [];
		const shimmerStamps: number[] = [];
		const unsubs = [
			subscribeTicker(() => tickerStamps.push(Date.now())),
			subscribeShimmer(() => shimmerStamps.push(Date.now())),
		];
		try {
			t.mock.timers.tick(1000);
		} finally {
			for (const unsub of unsubs) unsub();
			_resetTicker();
		}
		// 90ms 档约 11 次，16ms 档约 62 次；允许 ±2 容差（边界对齐）。
		assert.ok(
			tickerStamps.length >= 9 && tickerStamps.length <= 13,
			`1s 内 90ms tick 应约 11 次，实际 ${tickerStamps.length} 次`,
		);
		assert.ok(
			shimmerStamps.length >= 55 && shimmerStamps.length <= 70,
			`1s 内 16ms tick 应约 62 次，实际 ${shimmerStamps.length} 次`,
		);
		// braille 相邻两拍间隔应均匀：最大间隔不超过 200ms，否则节拍已散。
		let maxGap = 0;
		for (let i = 1; i < tickerStamps.length; i++) {
			maxGap = Math.max(maxGap, tickerStamps[i]! - tickerStamps[i - 1]!);
		}
		assert.ok(maxGap <= 200, `braille tick 最大间隔 ${maxGap}ms，超过 200ms 即节拍不稳`);
	} finally {
		t.mock.timers.reset();
	}
});
