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
