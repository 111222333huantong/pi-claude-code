import assert from "node:assert/strict";
import test from "node:test";
import {
	drainCompatIssues,
	getAssistantMessagePrototype,
	getContainerPrototype,
	getMarkdownPrototype,
	getMethodPrototype,
	getToolExecutionPrototype,
	peekCompatIssues,
	reportCompatIssue,
	toolDefinitions,
	tuiPreviousLines,
	tuiTerminalSize,
	tuiViewportTop,
} from "../extensions/compat/pi-internals.ts";

test("compat: 当前 Pi 版本的原型全部可解析", () => {
	const prototypes = [
		["tool-execution", getToolExecutionPrototype()],
		["assistant-message", getAssistantMessagePrototype()],
		["markdown", getMarkdownPrototype()],
		["container", getContainerPrototype()],
	] as const;
	for (const [feature, prototype] of prototypes) {
		assert.ok(prototype, `${feature} prototype missing`);
		assert.equal(typeof prototype, "object");
	}
});

test("compat: reportCompatIssue 去重，drain 后清空", () => {
	drainCompatIssues();
	reportCompatIssue("tool-execution", "prototype.render");
	reportCompatIssue("tool-execution", "prototype.render");
	reportCompatIssue("markdown", "prototype.render");
	assert.deepEqual(
		peekCompatIssues().map((issue) => `${issue.feature}:${issue.missing}`),
		["tool-execution:prototype.render", "markdown:prototype.render"],
	);
	assert.equal(drainCompatIssues().length, 2);
	assert.equal(drainCompatIssues().length, 0);
	// drain 之后同一问题可以再次上报（下次会话还会提示）。
	reportCompatIssue("markdown", "prototype.render");
	assert.equal(peekCompatIssues().length, 1);
	drainCompatIssues();
});

test("compat: getMethodPrototype 缺失方法时记录 issue 并放弃", () => {
	drainCompatIssues();
	assert.equal(getMethodPrototype({ prototype: {} }, "updateDisplay", "fake"), undefined);
	assert.deepEqual(
		drainCompatIssues().map((issue) => `${issue.feature}:${issue.missing}`),
		["fake:prototype.updateDisplay"],
	);
	assert.equal(getMethodPrototype(undefined, "x", "fake2"), undefined);
	assert.equal(drainCompatIssues().length, 1);
	// 方法存在时返回原型本身。
	const prototype = { updateDisplay() {} };
	assert.equal(getMethodPrototype({ prototype }, "updateDisplay", "fake3"), prototype);
	assert.equal(drainCompatIssues().length, 0);
});

test("compat: toolDefinitions 兼容扩展定义与内置定义", () => {
	const extension = { name: "my_tool" };
	const builtIn = { name: "bash" };
	assert.deepEqual(toolDefinitions({ toolDefinition: extension, builtInToolDefinition: builtIn }), {
		extension,
		builtIn,
	});
	assert.deepEqual(toolDefinitions({ builtInToolDefinition: builtIn }), {
		extension: undefined,
		builtIn,
	});
	assert.deepEqual(toolDefinitions(null), { extension: undefined, builtIn: undefined });
});

test("compat: TUI 内部字段缺失时给出安全默认值", () => {
	assert.equal(tuiViewportTop(undefined), 0);
	assert.equal(tuiViewportTop({ previousViewportTop: 4.2 }), 4.2);
	assert.equal(tuiPreviousLines({ previousLines: ["a"] })?.length, 1);
	assert.equal(tuiPreviousLines({}), undefined);
	assert.deepEqual(tuiTerminalSize({}), { columns: 80, rows: Number.POSITIVE_INFINITY });
	assert.deepEqual(tuiTerminalSize({ terminal: { columns: 120, rows: 40 } }), {
		columns: 120,
		rows: 40,
	});
});
