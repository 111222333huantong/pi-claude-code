import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { config } from "../extensions/config/config.ts";
import { installDefaultMode } from "../extensions/renderer/default-mode.ts";
import { WriteExecutionMetadataStore } from "../extensions/renderer/tool/diff/write-execution.ts";
import {
	classifyToolFailure,
	failureSummaryText,
	normalizeFailureText,
	stripFailureTags,
} from "../extensions/renderer/tool/result.ts";
import { stripAnsi } from "../extensions/utils/ansi-text.ts";
import {
	queuedToolGlyph,
	TOOL_GUTTER_WIDTH,
	toolStatusGlyph,
} from "../extensions/utils/tool-loading-icon.ts";

initTheme("dark");

const BRAILLE = "[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]";

const ui = {
	theme: {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	},
	requestRender() {},
	setStatus() {},
} as any;

function makeBash(id: string, command = "npm test") {
	return new ToolExecutionComponent(
		"bash",
		id,
		{ command },
		{},
		undefined,
		ui,
		process.cwd(),
	) as any;
}

function settled(tool: any, text: string, isError = false) {
	tool.updateResult({ content: [{ type: "text", text }], isError }, false);
}

function nonEmptyLines(tool: any, width = 100): string[] {
	return tool
		.render(width)
		.map(stripAnsi)
		.filter((line: string) => line.trim().length > 0);
}

test("status gutter is fixed width with platform glyphs", () => {
	assert.equal(TOOL_GUTTER_WIDTH, 2);
	assert.equal(toolStatusGlyph("success"), "✓");
	assert.equal(toolStatusGlyph("error"), "✗");
	assert.equal(toolStatusGlyph("queued"), queuedToolGlyph());
	assert.equal(queuedToolGlyph(), process.platform === "darwin" ? "⏺" : "●");
	assert.match(toolStatusGlyph("running", 100), new RegExp(BRAILLE));
});

test("classifyToolFailure splits user halts from real errors", () => {
	assert.equal(classifyToolFailure("This operation was aborted"), "cancelled");
	assert.equal(classifyToolFailure("Request was aborted"), "cancelled");
	assert.equal(classifyToolFailure("aborted by user"), "cancelled");
	assert.equal(classifyToolFailure("Permission denied by policy"), "rejected");
	assert.equal(classifyToolFailure("rejected by user"), "rejected");
	assert.equal(classifyToolFailure("Execution interrupted by user"), "interrupted");
	assert.equal(classifyToolFailure("Error: boom"), "error");
	assert.equal(classifyToolFailure("file busy"), "error");
	assert.equal(classifyToolFailure(""), "error");
});

test("failureSummaryText shortens halts and normalizes errors", () => {
	assert.equal(failureSummaryText("This operation was aborted"), "Operation aborted");
	assert.equal(failureSummaryText("Execution interrupted"), "Operation aborted");
	assert.equal(failureSummaryText("Permission denied"), "Permission rejected");
	assert.equal(failureSummaryText("Error: boom"), "Error: boom");
	assert.equal(failureSummaryText("file busy"), "Error: file busy");
	assert.equal(failureSummaryText("<error>file busy</error>"), "Error: file busy");
	assert.equal(failureSummaryText(""), "Failed");
	assert.equal(stripFailureTags("<error>file busy</error>"), "file busy");
	assert.equal(normalizeFailureText("file busy"), "Error: file busy");
	assert.equal(normalizeFailureText("Error: boom"), "Error: boom");
});

test("title rows keep the same width across queued/running/settled", () => {
	const previousMode = config.mode;
	config.mode = "on";
	const hooks = installDefaultMode(new WriteExecutionMetadataStore());
	try {
		const command = `rg -n "writeMethod|replaceMethod" ${"C:/Users/example/node_modules/".repeat(5)}target.ts`;
		const bash = makeBash("bash-gutter", command);
		const titleWidth = () =>
			visibleWidth(nonEmptyLines(bash, 100).find((line) => line.includes("Bash")) ?? "");
		assert.equal(titleWidth(), 80, "queued truncates to the 80% viewport");
		bash.markExecutionStarted();
		bash.updateDisplay();
		assert.equal(titleWidth(), 80, "running keeps the same width");
		settled(bash, "done");
		const realNow = Date.now;
		Date.now = () => realNow() + 5000;
		try {
			bash.updateDisplay();
			assert.equal(titleWidth(), 80, "settled keeps the same width");
		} finally {
			Date.now = realNow;
		}
	} finally {
		config.mode = previousMode;
		hooks.shutdown();
	}
});

test("collapsed failures shorten halts and normalize errors end to end", () => {
	const previousMode = config.mode;
	config.mode = "on";
	const hooks = installDefaultMode(new WriteExecutionMetadataStore());
	try {
		const halted = makeBash("bash-halted");
		halted.markExecutionStarted();
		settled(halted, "Permission denied by policy", true);
		const haltedLine = nonEmptyLines(halted).find((line) => line.includes("↳")) ?? "";
		assert.match(haltedLine, /Permission rejected/);
		assert.doesNotMatch(haltedLine, /Permission denied by policy/);
		const failed = makeBash("bash-failed");
		failed.markExecutionStarted();
		settled(failed, "connection reset", true);
		const failedLine = nonEmptyLines(failed).find((line) => line.includes("↳")) ?? "";
		assert.match(failedLine, /Error: connection reset/);
	} finally {
		config.mode = previousMode;
		hooks.shutdown();
	}
});
