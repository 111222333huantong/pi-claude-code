import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { config } from "../extensions/config/config.ts";
import { installDefaultMode } from "../extensions/renderer/default-mode.ts";
import { bashLivePreview } from "../extensions/renderer/tool/bash-preview.ts";
import { WriteExecutionMetadataStore } from "../extensions/renderer/tool/diff/write-execution.ts";
import { installToolGrouping } from "../extensions/renderer/tool/grouping.ts";
import {
	outputTotalLines,
	tailTextFromResult,
	textFromResult,
} from "../extensions/renderer/tool/result.ts";
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

function partialWithDetails(tool: any, text: string, details: any) {
	tool.updateResult({ content: [{ type: "text", text }], details, isError: false }, true);
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

test("bashLivePreview normalizes CRLF and keeps the last line for limit=1", () => {
	const preview = bashLivePreview("a\r\nb\r\nc\r\n", 1);
	assert.equal(preview.total, 3);
	assert.equal(preview.header, "… (2 earlier lines)");
	assert.deepEqual(preview.tail, ["c"]);
	// 缓存不能把上一次输入的结果串给下一次。
	const next = bashLivePreview("fresh", 1);
	assert.equal(next.total, 1);
	assert.deepEqual(next.tail, ["fresh"]);
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
	const realNow = Date.now;
	try {
		const bash = startedBash("bash-settled");
		partial(bash, rows(8));
		render(bash);
		bash.updateDisplay();
		settled(bash, rows(8));
		render(bash);
		bash.updateDisplay();
		// 最小可读窗口（700ms）内仍呈 running 态：拨过窗口并重建闭包再断言落定摘要。
		Date.now = () => realNow() + 5000;
		bash.updateDisplay();
		const text = render(bash).map(strip).join("\n");
		// 落定：单行摘要，无尾块，无计数（只执行时才有）。
		assert.match(text, /8 lines returned/);
		assert.doesNotMatch(text, /earlier lines/);
		assert.doesNotMatch(text, /· 8 lines/);
	} finally {
		Date.now = realNow;
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

test("renderCall queued 未 start 不上臂，起跑后上臂", (t) => {
	// P0 四态：queued 排队行静态 dim 点，不蹭共享 tick（省拍）；
	// 起跑（markExecutionStarted）后才 braille + tick 开火。
	// 用 ui.requestRender 计数观测驱动开火（不依赖诊断槽）。
	t.mock.timers.enable({ apis: ["setInterval", "Date"] });
	const previousMode = config.mode;
	config.mode = "on";
	const hooks = installDefaultMode(new WriteExecutionMetadataStore());
	try {
		// 注意：故意不 markExecutionStarted，模拟排队阶段。
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
		const queuedText = render(bash).map(strip).join("\n");
		assert.doesNotMatch(queuedText, BRAILLE_RE, "queued 标题静态，无盲文");
		const before = renderRequests;
		t.mock.timers.tick(500);
		assert.equal(renderRequests, before, "queued 时 tick 不开火到组件");
		bash.markExecutionStarted();
		bash.updateDisplay();
		const runningText = render(bash).map(strip).join("\n");
		assert.match(runningText, BRAILLE_RE, "起跑后标题转圈");
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

test("bashLivePreview: 流式追加走增量路径，结果与全量重算一致", () => {
	// 先落一段基准，再逐行追加；每步都与“冷启动重算”对比。
	bashLivePreview("inc-base\nline-1", 5);
	for (let step = 2; step <= 40; step++) {
		const incremental = bashLivePreview(`inc-base\nline-1\nline-${step}`, 5);
		// 换一个不以旧文本为前缀的输入，强制冷路径重算同一份文本。
		bashLivePreview(`cold-${step}`, 5);
		const cold = bashLivePreview(`inc-base\nline-1\nline-${step}`, 5);
		assert.equal(incremental.total, cold.total, `step ${step}`);
		assert.deepEqual(incremental.tail, cold.tail, `step ${step}`);
		assert.equal(incremental.header, cold.header, `step ${step}`);
	}
});

test("bashLivePreview: 非前缀替换、CRLF、limit 变化都不复用旧结果", () => {
	bashLivePreview("aaaa\nbbbb\ncccc", 3);
	assert.deepEqual(bashLivePreview("xxxx\nyyyy", 3).tail, ["xxxx", "yyyy"]);
	bashLivePreview("crlf\r\none\r\ntwo", 2);
	assert.deepEqual(bashLivePreview("crlf\r\none\r\ntwo\r\nthree", 2).tail, ["two", "three"]);
	bashLivePreview("limit\none\ntwo\nthree", 2);
	assert.deepEqual(bashLivePreview("limit\none\ntwo\nthree", 3).tail, ["one", "two", "three"]);
});

test("bashLivePreview: 尾部空行追加不改变 total/header", () => {
	bashLivePreview("tail-a\ntail-b", 5);
	assert.equal(bashLivePreview("tail-a\ntail-b\n\n\n", 5).total, 2);
	assert.equal(bashLivePreview("tail-a\ntail-b\n\n\n", 5).header, null);
});

test("tailTextFromResult 保留尾部而不是头部", () => {
	const text = ["HEAD-ONLY", ...Array.from({ length: 3_000 }, (_, i) => `row-${i}`)].join("\n");
	const tail = tailTextFromResult({ content: [{ type: "text", text }] });
	assert.ok(!tail.startsWith("HEAD-ONLY"), "头部行不应出现");
	assert.ok(tail.endsWith("row-2999"), "最后一行必须保留");
	// 切窗口时不留下半行：首字符必须是一行开头。
	assert.match(tail.split("\n")[0]!, /^row-\d+$/);
	// 短输出与 textFromResult 完全一致。
	const short = { content: [{ type: "text", text: "a\nb" }] };
	assert.equal(tailTextFromResult(short), textFromResult(short));
});

test("outputTotalLines 读取 Pi 截断详情里的真实总行数", () => {
	assert.equal(outputTotalLines({ details: { truncation: { totalLines: 5000 } } }), 5000);
	assert.equal(outputTotalLines({ details: { truncation: { totalLines: 0 } } }), 0);
	assert.equal(outputTotalLines({ details: undefined }), undefined);
	assert.equal(outputTotalLines({ details: { truncation: { totalLines: "x" } } }), undefined);
});

test("settled bash: 超过 16KB 的展开输出保留末尾", () => {
	const previousMode = config.mode;
	const previousLimit = config.expandedOutputMaxLines;
	config.mode = "on";
	// 放大行数上限，让断言只看「尾部是否进入可见正文」，不受 10 行预览影响。
	config.expandedOutputMaxLines = 10_000;
	const hooks = installDefaultMode(new WriteExecutionMetadataStore());
	try {
		const bash = startedBash("bash-settled-long");
		// 约 60KB：超过 textFromResult 的 16KB 头部上限，旧实现会裁掉末尾。
		const text = [
			...Array.from({ length: 6_000 }, (_, i) => `log-${String(i).padStart(4, "0")}`),
			"FATAL: tail error",
		].join("\n");
		bash.updateResult({ content: [{ type: "text", text }], isError: false }, false);
		bash.setExpanded(true);
		const out = render(bash).map(strip).join("\n");
		assert.match(out, /FATAL: tail error/, "展开输出必须包含末尾");
	} finally {
		config.mode = previousMode;
		config.expandedOutputMaxLines = previousLimit;
		clearAllAnimations();
		hooks.shutdown();
	}
});

test("running bash: 输出超过 16KB 仍跟随尾部，并用真实总行数", () => {
	const previousMode = config.mode;
	const previousFlag = config.liveToolPreview;
	config.mode = "on";
	config.liveToolPreview = true;
	const hooks = installDefaultMode(new WriteExecutionMetadataStore());
	try {
		const bash = startedBash("bash-live-long");
		// 3000 行约 24KB：超过 textFromResult 的 16KB 头部上限。
		partialWithDetails(
			bash,
			Array.from({ length: 3_000 }, (_, i) => `row-${String(i + 1).padStart(4, "0")}`).join("\n"),
			{ truncation: { totalLines: 5_000 } },
		);
		render(bash);
		bash.updateDisplay();
		const text = render(bash).map(strip).join("\n");
		assert.match(text, /row-3000/, "显示最后一行");
		assert.match(text, /· 5000 lines/, "标题用真实总行数");
		assert.match(text, /… \(4995 earlier lines\)/, "头部按真实总数计算");
	} finally {
		config.mode = previousMode;
		config.liveToolPreview = previousFlag;
		clearAllAnimations();
		hooks.shutdown();
	}
});
