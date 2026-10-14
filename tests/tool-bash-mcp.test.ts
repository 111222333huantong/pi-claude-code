import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { config } from "../extensions/config/config.ts";
import { installDefaultMode } from "../extensions/renderer/default-mode.ts";
import { WriteExecutionMetadataStore } from "../extensions/renderer/tool/diff/write-execution.ts";
import {
	bashHeadline,
	humanizeMcpToolName,
	isLikelyQuietCommand,
	isMcpToolName,
	mcpCallSummary,
	toolCallSummary,
} from "../extensions/renderer/tool/names.ts";
import { clearAllAnimations } from "../extensions/renderer/tool/tool-state.ts";
import { stripAnsi } from "../extensions/utils/ansi-text.ts";

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

function lines(tool: any, width = 120): string[] {
	return tool
		.render(width)
		.map(stripAnsi)
		.filter((line: string) => line.trim().length > 0);
}

test("isMcpToolName matches name patterns and MCP labels", () => {
	assert.equal(isMcpToolName("mcp"), true);
	assert.equal(isMcpToolName("mcp__filesystem__read_file"), true);
	assert.equal(isMcpToolName("mcp-files-search"), true);
	assert.equal(isMcpToolName("github:search_code"), true);
	assert.equal(isMcpToolName("ctx_lookup"), true);
	assert.equal(isMcpToolName("read_file", "MCP: Files"), true);
	assert.equal(isMcpToolName("read"), false);
	assert.equal(isMcpToolName("bash"), false);
	assert.equal(isMcpToolName("openai_custom_search"), false);
});

test("mcpCallSummary builds MCP verb plus arg count", () => {
	assert.deepEqual(mcpCallSummary("mcp__filesystem__read_file", "Filesystem Read File", {}), {
		main: "MCP Filesystem Read File",
		detail: " (no args)",
	});
	assert.deepEqual(
		mcpCallSummary("mcp__filesystem__read_file", "Filesystem Read File", { path: "a" }),
		{ main: "MCP Filesystem Read File", detail: " (1 arg)" },
	);
	assert.deepEqual(mcpCallSummary("mcp", "mcp", { tool: "read", server: "fs" }), {
		main: "MCP call fs:read",
		detail: " (2 args)",
	});
	assert.deepEqual(mcpCallSummary("mcp", "mcp", { search: "diff" }), {
		main: 'MCP search "diff"',
		detail: " (1 arg)",
	});
	assert.deepEqual(mcpCallSummary("mcp", "mcp", {}), { main: "MCP status", detail: " (no args)" });
	assert.deepEqual(mcpCallSummary("read_file", "MCP: Files", {}), {
		main: "MCP Files",
		detail: " (no args)",
	});
	assert.equal(mcpCallSummary("bash", "Bash", { command: "ls" }), undefined);
	assert.equal(humanizeMcpToolName("mcp__filesystem__read_file"), "Filesystem Read File");
});

test("toolCallSummary routes MCP tools to the MCP line", () => {
	const mcp = toolCallSummary("mcp__filesystem__read_file", {}, { variant: "default" });
	assert.match(mcp.main, /^MCP Filesystem Read File/);
	const grouped = toolCallSummary("mcp__fs__read", { path: "a" }, { variant: "grouping" });
	assert.match(grouped.main, /^MCP /);
	const plain = toolCallSummary("bash", { command: "ls" }, { variant: "default" });
	assert.doesNotMatch(plain.main, /^MCP /);
});

test("bashHeadline skips comments and shell setup lines", () => {
	assert.equal(bashHeadline("npm test"), "npm test");
	assert.equal(bashHeadline(""), undefined);
	assert.equal(bashHeadline("   "), undefined);
	assert.equal(
		bashHeadline("# deploy script\nset -e\ncd /tmp\nexport FOO=1\nnpm run build"),
		"npm run build · 5 lines",
	);
	assert.equal(bashHeadline("FOO=1 BAR=2\nmake all"), "make all · 2 lines");
	assert.equal(bashHeadline("# only comments\n# nothing else"), "# only comments · 2 lines");
	const long = `npm run build --workspace packages/app --define version=1.2.3 --output dist/bundle.js --sourcemap --reporter verbose --coverage enabled`;
	// toolLabelClip=0（默认）不预截断，渲染时按宽度截；正数恢复 head-tail。
	assert.equal(bashHeadline(long), long);
	const previousClip = config.toolLabelClip;
	try {
		config.toolLabelClip = 100;
		const head = bashHeadline(long)!;
		assert.ok(head.includes("…"), "long commands keep head and tail");
		assert.ok(head.startsWith("npm run build"));
		assert.ok(head.endsWith("coverage enabled"));
		assert.ok(head.length < long.length);
	} finally {
		config.toolLabelClip = previousClip;
	}
});

test("isLikelyQuietCommand matches setup-like commands", () => {
	for (const command of [
		"cd /tmp",
		"mkdir -p dist",
		"rm -rf dist",
		"git add -A",
		"npm install",
		"Set-Location foo",
		"cd /tmp && npm test",
	]) {
		assert.equal(isLikelyQuietCommand(command), true, command);
	}
	for (const command of ["", "   ", "npm test", "ls -la", "git status", "node build.js"]) {
		assert.equal(isLikelyQuietCommand(command), false, command || "(empty)");
	}
});

test("toolCallSummary uses headlines for bash in both variants", () => {
	const command = "# comment\ncd /tmp\nnpm run build";
	const single = toolCallSummary("bash", { command }, { variant: "default" });
	assert.match(single.main, /Bash npm run build/);
	assert.doesNotMatch(single.main, /comment/);
	const grouped = toolCallSummary("bash", { command }, { variant: "grouping" });
	assert.match(grouped.main, /Bash npm run build/);
	const empty = toolCallSummary("bash", {}, { variant: "grouping" });
	assert.equal(empty.main, "Bash ...");
});

test("quiet bash with no output converges to completed-without-output", () => {
	const previousMode = config.mode;
	config.mode = "on";
	const hooks = installDefaultMode(new WriteExecutionMetadataStore());
	try {
		const quiet = new ToolExecutionComponent(
			"bash",
			"bash-quiet",
			{ command: "cd /tmp" },
			{},
			undefined,
			ui,
			process.cwd(),
		) as any;
		quiet.markExecutionStarted();
		quiet.updateResult({ content: [{ type: "text", text: "" }], isError: false });
		const quietLine = lines(quiet).find((line) => line.includes("↳")) ?? "";
		assert.match(quietLine, /command completed \(no output\)/);
		const loud = new ToolExecutionComponent(
			"bash",
			"bash-loud",
			{ command: "npm test" },
			{},
			undefined,
			ui,
			process.cwd(),
		) as any;
		loud.markExecutionStarted();
		loud.updateResult({ content: [{ type: "text", text: "" }], isError: false });
		const loudLine = lines(loud).find((line) => line.includes("↳")) ?? "";
		assert.match(loudLine, /Done/);
		assert.doesNotMatch(loudLine, /no output/);
	} finally {
		config.mode = previousMode;
		clearAllAnimations();
		hooks.shutdown();
	}
});

test("running title keeps live count, settled title drops it", () => {
	const previousMode = config.mode;
	config.mode = "on";
	const hooks = installDefaultMode(new WriteExecutionMetadataStore());
	try {
		const bash = new ToolExecutionComponent(
			"bash",
			"bash-tier",
			{ command: "npm test" },
			{},
			undefined,
			ui,
			process.cwd(),
		) as any;
		bash.markExecutionStarted();
		bash.updateResult({ content: [{ type: "text", text: "a\nb\nc" }], isError: false }, true);
		bash.updateDisplay();
		const runningTitle = lines(bash).find((line) => line.includes("Bash")) ?? "";
		assert.match(runningTitle, /· 3 lines/);
		bash.updateResult({ content: [{ type: "text", text: "a\nb\nc" }], isError: false });
		const realNow = Date.now;
		Date.now = () => realNow() + 5000;
		try {
			bash.updateDisplay();
			const settledTitle = lines(bash).find((line) => line.includes("Bash")) ?? "";
			assert.doesNotMatch(settledTitle, /· 3 lines/);
			assert.match(settledTitle, /✓ Bash npm test/);
		} finally {
			Date.now = realNow;
		}
	} finally {
		config.mode = previousMode;
		clearAllAnimations();
		hooks.shutdown();
	}
});
