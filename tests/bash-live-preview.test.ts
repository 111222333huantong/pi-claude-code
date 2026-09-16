import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { config } from "../extensions/config/config.ts";
import { installDefaultMode } from "../extensions/renderer/default-mode.ts";
import { bashLivePreview } from "../extensions/renderer/tool/bash-preview.ts";
import { WriteExecutionMetadataStore } from "../extensions/renderer/tool/diff/write-execution.ts";
import { installToolGrouping } from "../extensions/renderer/tool/grouping.ts";
import { clearAllAnimations } from "../extensions/renderer/tool/result.ts";

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

function rows(n: number): string {
	return Array.from({ length: n }, (_, i) => `row-${String(i + 1).padStart(2, "0")}`).join("\n");
}

function startedBash(id = "bash-live", command = "npm test") {
	const tool = new ToolExecutionComponent(
		"bash",
		id,
		{ command },
		{},
		undefined,
		ui,
		process.cwd(),
	) as any;
	tool.markExecutionStarted();
	return tool;
}

function plainTool(name: string, id: string, args: any = {}) {
	return new ToolExecutionComponent(name, id, args, {}, undefined, ui, process.cwd()) as any;
}

function partial(tool: any, text: string) {
	tool.updateResult({ content: [{ type: "text", text }], isError: false }, true);
}

function settled(tool: any, text: string, isError = false) {
	tool.updateResult({ content: [{ type: "text", text }], isError }, false);
}

const render = (component: any, width = 100): string[] => component.render(width);
const strip = (s: string) => s.replace(/\[[0-?]*[ -/]*[@-~]/g, "");

test("bashLivePreview splits tail window with earlier-lines head", () => {
	const long = bashLivePreview(rows(8), 5);
	assert.equal(long.total, 8);
	assert.equal(long.header, "… (3 earlier lines)");
	assert.deepEqual(long.tail, ["row-04", "row-05", "row-06", "row-07", "row-08"]);
	const short = bashLivePreview(rows(3), 5);
	assert.equal(short.total, 3);
	assert.equal(short.header, null);
	assert.deepEqual(short.tail, ["row-01", "row-02", "row-03"]);
	const empty = bashLivePreview("   \n ", 5);
	assert.equal(empty.total, 0);
	assert.deepEqual(empty.tail, []);
});

test("running bash shows tail preview with count in title", () => {
	const previousMode = config.mode;
	const previousFlag = config.liveToolPreview;
	config.mode = "on";
	config.liveToolPreview = true;
	const hooks = installDefaultMode(new WriteExecutionMetadataStore());
	try {
		const bash = startedBash();
		partial(bash, rows(8));
		render(bash);
		// renderCall 闭包按次缓存：updateDisplay 重建后第二拍才读到 count
		// （生产环境由 tick/更新驱动重建，约一帧延迟，cc-tools 同机制）。
		bash.updateDisplay();
		const lines = render(bash).map(strip);
		const text = lines.join("\n");
		assert.match(text, /… \(3 earlier lines\)/);
		assert.match(text, /row-08/);
		assert.doesNotMatch(text, /row-01/);
		assert.match(text, /· 8 lines/);
		// 方案B：尾行无 ↳，4 空格缩进与 … 内容列对齐。
		assert.doesNotMatch(text, /↳ row-08/);
		assert.match(text, /^ {5}row-08$/m);
	} finally {
		config.mode = previousMode;
		config.liveToolPreview = previousFlag;
		clearAllAnimations();
		hooks.shutdown();
	}
});

test("short bash output shows all lines without earlier head", () => {
	const previousMode = config.mode;
	const previousFlag = config.liveToolPreview;
	config.mode = "on";
	config.liveToolPreview = true;
	const hooks = installDefaultMode(new WriteExecutionMetadataStore());
	try {
		const bash = startedBash("bash-short");
		partial(bash, rows(3));
		const text = render(bash).map(strip).join("\n");
		assert.match(text, /row-01/);
		assert.match(text, /row-03/);
		assert.doesNotMatch(text, /earlier lines/);
		// 不够折叠时也只有一个 ↳（首行），其余缩进。
		assert.match(text, /^ {3}↳ row-01$/m);
		assert.match(text, /^ {5}row-02$/m);
		assert.doesNotMatch(text, /↳ row-02/);
	} finally {
		config.mode = previousMode;
		config.liveToolPreview = previousFlag;
		clearAllAnimations();
		hooks.shutdown();
	}
});

test("empty bash output falls back to Pending", () => {
	const previousMode = config.mode;
	const previousFlag = config.liveToolPreview;
	config.mode = "on";
	config.liveToolPreview = true;
	const hooks = installDefaultMode(new WriteExecutionMetadataStore());
	try {
		const bash = startedBash("bash-empty");
		partial(bash, "");
		const text = render(bash).map(strip).join("\n");
		assert.match(text, /Pending/);
	} finally {
		config.mode = previousMode;
		config.liveToolPreview = previousFlag;
		clearAllAnimations();
		hooks.shutdown();
	}
});

test("settled bash falls back to single-line summary without count", () => {
	const previousMode = config.mode;
	const previousFlag = config.liveToolPreview;
	config.mode = "on";
	config.liveToolPreview = true;
	const hooks = installDefaultMode(new WriteExecutionMetadataStore());
	try {
		const bash = startedBash("bash-settled");
		partial(bash, rows(8));
		render(bash);
		bash.updateDisplay();
		settled(bash, rows(8));
		render(bash);
		bash.updateDisplay();
		const text = render(bash).map(strip).join("\n");
		// 落定：单行摘要，无尾块，无计数（只执行时才有）。
		assert.match(text, /8 lines returned/);
		assert.doesNotMatch(text, /earlier lines/);
		assert.doesNotMatch(text, /· 8 lines/);
	} finally {
		config.mode = previousMode;
		config.liveToolPreview = previousFlag;
		clearAllAnimations();
		hooks.shutdown();
	}
});

test("liveToolPreview=false restores Pending-only behavior", () => {
	const previousMode = config.mode;
	const previousFlag = config.liveToolPreview;
	config.mode = "on";
	config.liveToolPreview = false;
	const hooks = installDefaultMode(new WriteExecutionMetadataStore());
	try {
		const bash = startedBash("bash-off");
		partial(bash, rows(8));
		const text = render(bash).map(strip).join("\n");
		assert.match(text, /Pending/);
		assert.doesNotMatch(text, /earlier lines/);
		assert.doesNotMatch(text, /· 8 lines/);
	} finally {
		config.mode = previousMode;
		config.liveToolPreview = previousFlag;
		clearAllAnimations();
		hooks.shutdown();
	}
});

test("grouped bash glance row shows live line count while running", () => {
	const previousMode = config.mode;
	const previousFlag = config.liveToolPreview;
	config.mode = "on";
	config.liveToolPreview = true;
	const defaultHooks = installDefaultMode(new WriteExecutionMetadataStore());
	const groupingHooks = installToolGrouping(() => true);
	try {
		const parent = new Container() as any;
		const read = plainTool("read", "gr-read", { path: "a.ts" });
		read.updateResult({ content: [{ type: "text", text: "hi" }], isError: false });
		const bash = startedBash("gr-bash");
		bash.updateResult({ content: [{ type: "text", text: rows(8) }], isError: false }, true);
		const grep = plainTool("grep", "gr-grep", { pattern: "x" });
		grep.updateResult({ content: [{ type: "text", text: "a:1:x" }], isError: false });
		parent.addChild(read);
		parent.addChild(bash);
		parent.addChild(grep);
		const group = parent.children[0];
		const lines = group
			.render(100)
			.map(strip)
			.filter((line: string) => line.trim());
		const bashRow = lines.find((line: string) => line.includes("Bash npm test"));
		assert.ok(bashRow);
		assert.match(bashRow, /· 8 lines/);
	} finally {
		config.mode = previousMode;
		config.liveToolPreview = previousFlag;
		clearAllAnimations();
		groupingHooks.shutdown();
		defaultHooks.shutdown();
	}
});

test("pending 标题盲文逐 paint 更新，不冻在宽度缓存里", (t) => {
	// 回归：renderCall 曾把墙钟盲文烤进宽度缓存，标题只随参数块跳动
	//（真机 beat 日志 188/29/63ms）。现在图标逐 render 取新鲜值。
	t.mock.timers.enable({ apis: ["Date"] });
	const previousMode = config.mode;
	config.mode = "on";
	const hooks = installDefaultMode(new WriteExecutionMetadataStore());
	try {
		const bash = startedBash("braille-beat");
		partial(bash, rows(3));
		const first = render(bash).join("\n");
		t.mock.timers.tick(100);
		const second = render(bash).join("\n");
		assert.notEqual(first, second, "同一宽度二次 render，盲文必须推进（跨过 80ms 格必换帧）");
	} finally {
		t.mock.timers.reset();
		config.mode = previousMode;
		clearAllAnimations();
		hooks.shutdown();
	}
});

test("renderCall partial 未 start 也上臂（参数流式阶段不断拍）", (t) => {
	// 回归：门控曾要求 executionStarted，参数流式时（partial 但未 start）
	// 只渲染不上臂，节拍跟着网络块走（beat 日志 187ms 量化）。
	// 用 ui.requestRender 计数观测驱动开火（不依赖诊断槽）。
	t.mock.timers.enable({ apis: ["setInterval", "Date"] });
	const previousMode = config.mode;
	config.mode = "on";
	const hooks = installDefaultMode(new WriteExecutionMetadataStore());
	try {
		// 注意：故意不 markExecutionStarted，模拟参数流式阶段。
		let renderRequests = 0;
		const countingUi = {
			theme: ui.theme,
			requestRender() {
				renderRequests++;
			},
			setStatus() {},
		} as any;
		const bash = new ToolExecutionComponent(
			"bash",
			"pre-start",
			{ command: "npm test" },
			{},
			undefined,
			countingUi,
			process.cwd(),
		) as any;
		partial(bash, rows(3));
		render(bash);
		t.mock.timers.tick(100);
		assert.ok(renderRequests >= 1, "无块时 tick 也要开火到组件（requestRender 计数）");
	} finally {
		t.mock.timers.reset();
		config.mode = previousMode;
		clearAllAnimations();
		hooks.shutdown();
	}
});

const BRAILLE_RE = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g;

function countBraille(text: string): number {
	return text.match(BRAILLE_RE)?.length ?? 0;
}

function streamingWrite(id: string, content: string) {
	const tool = new ToolExecutionComponent(
		"write",
		id,
		{ path: "stream.ts", content },
		{},
		undefined,
		ui,
		process.cwd(),
	) as any;
	tool.markExecutionStarted();
	tool.updateResult({ content: [{ type: "text", text: "partial" }], isError: false }, true);
	return tool;
}

test("write 流式头：参数未齐时 6 行 incoming + 单盲文", () => {
	const previousMode = config.mode;
	config.mode = "on";
	const hooks = installDefaultMode(new WriteExecutionMetadataStore());
	try {
		const content = Array.from({ length: 8 }, (_, i) => `code-${i + 1}`).join("\n");
		const tool = streamingWrite("sw-stream", content);
		const raw = render(tool).join("\n");
		const text = render(tool).map(strip).join("\n");
		assert.match(text, /Writing 8 lines/);
		assert.match(text, /code-1/);
		assert.match(text, /code-6/);
		assert.doesNotMatch(text, /code-7/);
		assert.match(text, /\+2 more lines/);
		assert.equal(countBraille(raw), 1, "标题 1 个盲文，头和行里不许再有");
	} finally {
		config.mode = previousMode;
		clearAllAnimations();
		hooks.shutdown();
	}
});

test("write 预告片头 Preview… 无盲文（单盲文规矩）", () => {
	const previousMode = config.mode;
	config.mode = "on";
	const store = new WriteExecutionMetadataStore();
	const hooks = installDefaultMode(store);
	try {
		store.set("sw-preview", { fileExistedBeforeWrite: false });
		const tool = new ToolExecutionComponent(
			"write",
			"sw-preview",
			{ path: "new.ts", content: "hello\n" },
			{},
			undefined,
			ui,
			process.cwd(),
		) as any;
		tool.markExecutionStarted();
		tool.setArgsComplete();
		tool.updateResult({ content: [{ type: "text", text: "partial" }], isError: false }, true);
		const raw = render(tool).join("\n");
		const headLine =
			render(tool)
				.map(strip)
				.find((line) => line.includes("Preview")) ?? "";
		assert.match(headLine, /↳ Preview/);
		assert.equal(countBraille(headLine), 0, "Preview 头不带转圈");
		assert.equal(countBraille(raw), 1, "全行唯一盲文在标题");
	} finally {
		config.mode = previousMode;
		clearAllAnimations();
		hooks.shutdown();
	}
});
