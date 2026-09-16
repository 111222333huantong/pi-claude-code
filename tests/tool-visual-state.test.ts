import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { config } from "../extensions/config/config.ts";
import { installDefaultMode } from "../extensions/renderer/default-mode.ts";
import { WriteExecutionMetadataStore } from "../extensions/renderer/tool/diff/write-execution.ts";
import {
	classifyToolFailure,
	clearAllAnimations,
	failureSummaryText,
	isInMinDisplayWindow,
	MAX_ERROR_PREVIEW_LINES,
	MIN_TOOL_DISPLAY_MS,
	normalizeFailureText,
	QUEUED_HINT_AFTER_MS,
	queuedHintVisible,
	resolveToolActivityPhase,
	stripFailureTags,
	toolIconColor,
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

function withNow<T>(now: number, fn: () => T): T {
	const realNow = Date.now;
	Date.now = () => now;
	try {
		return fn();
	} finally {
		Date.now = realNow;
	}
}

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

function partial(tool: any, text: string) {
	tool.updateResult({ content: [{ type: "text", text }], isError: false }, true);
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

test("resolveToolActivityPhase derives queued/running/success/error", () => {
	assert.equal(
		resolveToolActivityPhase({ isPartial: true, executionStarted: false, state: {} }),
		"queued",
	);
	assert.equal(
		resolveToolActivityPhase({ isPartial: true, executionStarted: true, state: {} }),
		"running",
	);
	assert.equal(
		resolveToolActivityPhase({ isPartial: false, isError: false, state: {} }),
		"success",
	);
	assert.equal(resolveToolActivityPhase({ isPartial: false, isError: true, state: {} }), "error");
	assert.equal(
		resolveToolActivityPhase({ state: { ccstyleToolVisualState: "success" } }),
		"success",
	);
	assert.equal(resolveToolActivityPhase({ state: { ccstyleToolVisualState: "error" } }), "error");
});

test("status gutter is fixed width with platform glyphs", () => {
	assert.equal(TOOL_GUTTER_WIDTH, 2);
	assert.equal(toolStatusGlyph("success"), "✓");
	assert.equal(toolStatusGlyph("error"), "✗");
	assert.equal(toolStatusGlyph("queued"), queuedToolGlyph());
	assert.equal(queuedToolGlyph(), process.platform === "darwin" ? "⏺" : "●");
	assert.match(toolStatusGlyph("running", 100), new RegExp(BRAILLE));
});

test("queued icon color is static dim, running breathes", () => {
	const queued: any = { isPartial: true, executionStarted: false, state: {} };
	assert.equal(
		withNow(100, () => toolIconColor(queued)),
		"dim",
	);
	assert.equal(
		withNow(900, () => toolIconColor(queued)),
		"dim",
	);
	const running: any = { isPartial: true, executionStarted: true, state: {} };
	assert.equal(
		withNow(100, () => toolIconColor(running)),
		"accent",
	);
	assert.equal(
		withNow(900, () => toolIconColor(running)),
		"dim",
	);
});

test("settled icon keeps breathing inside the min-display window", () => {
	assert.equal(MIN_TOOL_DISPLAY_MS, 700);
	const now = 10_000;
	const inWindow = { ccstyleToolVisualState: "success", ccstyleMinDisplayUntil: now + 699 };
	const pastWindow = { ccstyleToolVisualState: "success", ccstyleMinDisplayUntil: now - 1 };
	assert.equal(isInMinDisplayWindow(inWindow, now), true);
	assert.equal(isInMinDisplayWindow(pastWindow, now), false);
	assert.equal(isInMinDisplayWindow({}, now), false);
	assert.equal(
		withNow(now, () => toolIconColor({ state: inWindow })),
		"accent",
	);
	assert.equal(
		withNow(now, () => toolIconColor({ state: pastWindow })),
		"success",
	);
});

test("fast tools keep spinning for 700ms after settling", () => {
	const previousMode = config.mode;
	config.mode = "on";
	const hooks = installDefaultMode(new WriteExecutionMetadataStore());
	try {
		const bash = makeBash("bash-min-display");
		bash.markExecutionStarted();
		partial(bash, "row-01");
		const titleOf = () => nonEmptyLines(bash).find((line) => line.includes("Bash")) ?? "";
		assert.match(titleOf(), new RegExp(`${BRAILLE} Bash`), "running shows the loader");
		settled(bash, "row-01");
		assert.match(
			titleOf(),
			new RegExp(`${BRAILLE} Bash`),
			"settle inside 700ms keeps spinning instead of flashing settled",
		);
		assert.doesNotMatch(titleOf(), /✓ Bash /);
		const realNow = Date.now;
		Date.now = () => realNow() + 5000;
		try {
			assert.match(titleOf(), /✓ Bash /, "window expiry flips to settled");
		} finally {
			Date.now = realNow;
		}
	} finally {
		config.mode = previousMode;
		clearAllAnimations();
		hooks.shutdown();
	}
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

test("queuedHintVisible gates Waiting on 2s", () => {
	assert.equal(QUEUED_HINT_AFTER_MS, 2000);
	const now = 50_000;
	assert.equal(queuedHintVisible({ ccstyleQueuedSince: now }, now), false);
	assert.equal(queuedHintVisible({ ccstyleQueuedSince: now - 1999 }, now), false);
	assert.equal(queuedHintVisible({ ccstyleQueuedSince: now - 2000 }, now), true);
	assert.equal(queuedHintVisible({}, now), false);
});

test("queued rows gain a Waiting line after 2s", () => {
	const previousMode = config.mode;
	config.mode = "on";
	const hooks = installDefaultMode(new WriteExecutionMetadataStore());
	try {
		const bash = makeBash("bash-queued-hint");
		const fresh = nonEmptyLines(bash);
		assert.equal(fresh.length, 1);
		assert.match(fresh[0]!, /[●⏺] Bash /);
		assert.doesNotMatch(fresh.join("\n"), /Waiting/);
		const realNow = Date.now;
		Date.now = () => realNow() + 5000;
		try {
			bash.updateDisplay();
			const waited = nonEmptyLines(bash);
			assert.equal(waited.length, 2);
			assert.match(waited[1]!, /Waiting/);
		} finally {
			Date.now = realNow;
		}
	} finally {
		config.mode = previousMode;
		clearAllAnimations();
		hooks.shutdown();
	}
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
		clearAllAnimations();
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
		clearAllAnimations();
		hooks.shutdown();
	}
});

test("expanded errors clamp to 10 lines with a more hint", () => {
	assert.equal(MAX_ERROR_PREVIEW_LINES, 10);
	const previousMode = config.mode;
	const previousLimit = config.expandedOutputMaxLines;
	config.mode = "on";
	config.expandedOutputMaxLines = 80;
	const hooks = installDefaultMode(new WriteExecutionMetadataStore());
	try {
		const rows = Array.from({ length: 20 }, (_, i) => `row-${i + 1}`).join("\n");
		const failed = makeBash("bash-err-clamp");
		failed.markExecutionStarted();
		settled(failed, rows, true);
		failed.setExpanded(true);
		const failedText = failed.render(100).map(stripAnsi).join("\n");
		assert.match(failedText, /row-10/);
		assert.doesNotMatch(failedText, /row-11/);
		assert.match(failedText, /\+10 more lines/);
		const ok = makeBash("bash-ok-full");
		ok.markExecutionStarted();
		settled(ok, rows, false);
		ok.setExpanded(true);
		const okText = ok.render(100).map(stripAnsi).join("\n");
		assert.match(okText, /row-20/);
		assert.doesNotMatch(okText, /more lines/);
	} finally {
		config.expandedOutputMaxLines = previousLimit;
		config.mode = previousMode;
		clearAllAnimations();
		hooks.shutdown();
	}
});
