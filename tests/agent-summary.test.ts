import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
	AgentRunSummary,
	type AgentSummaryData,
	bindAgentSummary,
	classifyTool,
	summaryMarkdown,
} from "../extensions/feature/agent-summary/core.ts";
import agentSummaryFeature, {
	AGENT_SUMMARY_ENTRY_TYPE,
} from "../extensions/feature/agent-summary/index.ts";

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

test("classifyTool：bash/read/edit/write/other", () => {
	assert.equal(classifyTool("bash"), "bash");
	assert.equal(classifyTool("powershell"), "bash");
	assert.equal(classifyTool("read"), "read");
	assert.equal(classifyTool("edit"), "edit");
	assert.equal(classifyTool("write"), "write");
	assert.equal(classifyTool("grep"), "other");
	// MCP 风格名不是精确工具名：归 other
	assert.equal(classifyTool("mcp__server__read"), "other");
});

test("AgentRunSummary：bash/powershell 计数；read/edit/write 按路径去重；other 计数", () => {
	const summary = new AgentRunSummary(1_000);
	summary.recordToolStart("bash", { command: "npm test" });
	summary.recordToolStart("powershell", { command: "Get-ChildItem" });
	summary.recordToolStart("bash", { command: "ls" });
	summary.recordToolStart("read", { path: "a.ts" });
	summary.recordToolStart("read", { path: "a.ts" }); // 去重
	summary.recordToolStart("read", { path: "b.ts" });
	summary.recordToolStart("edit", { file_path: "c.ts" }); // file_path 别名
	summary.recordToolStart("write", { path: "d.ts" });
	summary.recordToolStart("write", { path: "d.ts" }); // 去重
	summary.recordToolStart("grep", { pattern: "x" });
	summary.recordToolResult(true);
	summary.recordToolResult(false);

	assert.equal(summary.toolCount, 10);
	const data = summary.snapshot(61_000);
	assert.deepEqual(data, {
		commands: 3,
		reads: 2,
		edits: 1,
		writes: 1,
		others: 1,
		failed: 1,
		durationMs: 60_000,
		outputTokens: 0,
	} satisfies AgentSummaryData);
});

test("summaryMarkdown renders the agent summary entry", () => {
	const data: AgentSummaryData = {
		commands: 3,
		reads: 2,
		edits: 1,
		writes: 1,
		others: 0,
		failed: 0,
		durationMs: 42_000,
	};
	// 无 outputTokens（旧 entry / usage 缺失）→ 整数秒旧格式。
	assert.equal(
		summaryMarkdown(data),
		"> *Ran 3 commands, read 2 files, edited 1 file, wrote 1 file · 42s*",
	);
	// 有 outputTokens → 精确时长 + tok/s（整回合平均口径）。
	assert.equal(
		summaryMarkdown({ ...data, durationMs: 52_500, outputTokens: 1_596 }),
		"> *Ran 3 commands, read 2 files, edited 1 file, wrote 1 file · 52.5s · 30.4 tok/s*",
	);
	// tokens=0 → 省略速率段，退回整数秒。
	assert.equal(
		summaryMarkdown({ ...data, outputTokens: 0 }),
		"> *Ran 3 commands, read 2 files, edited 1 file, wrote 1 file · 42s*",
	);
	// 时长 <1s → 省略速率段。
	assert.equal(
		summaryMarkdown({ ...data, durationMs: 400, outputTokens: 1_596 }),
		"> *Ran 3 commands, read 2 files, edited 1 file, wrote 1 file*",
	);
	// 有 ttftMs → 追加 TTFT 段；无/零 → 省略。
	assert.equal(
		summaryMarkdown({ ...data, durationMs: 52_500, outputTokens: 1_596, ttftMs: 812 }),
		"> *Ran 3 commands, read 2 files, edited 1 file, wrote 1 file · 52.5s · 30.4 tok/s · TTFT 812ms*",
	);
	assert.equal(
		summaryMarkdown({ ...data, ttftMs: 0 }),
		"> *Ran 3 commands, read 2 files, edited 1 file, wrote 1 file · 42s*",
	);
	assert.equal(summaryMarkdown({ ...data, commands: 0, reads: 0, edits: 0, writes: 0 }), "");
});

test("bindAgentSummary 事件绑定：agent_start 重置、agent_end 回调", async () => {
	const handlers = new Map<string, Function>();
	const fakePi = {
		on: (event: string, handler: Function) => handlers.set(event, handler),
	} as any;

	const calls: AgentSummaryData[] = [];
	bindAgentSummary(fakePi, (data) => calls.push(data));

	await handlers.get("agent_start")!();
	await handlers.get("tool_execution_start")!({ toolName: "read", args: { path: "a.ts" } });
	await handlers.get("tool_execution_end")!({ isError: false });
	await handlers.get("agent_end")!();
	assert.equal(calls.length, 0); // toolCount < 2

	await handlers.get("tool_execution_start")!({ toolName: "bash", args: { command: "ls" } });
	await handlers.get("tool_execution_end")!({ isError: true });
	await handlers.get("agent_end")!();
	assert.equal(calls.length, 1);
	assert.equal(calls[0].commands, 1);
	assert.equal(calls[0].failed, 1);
	assert.equal(calls[0].reads, 1);

	await handlers.get("agent_start")!();
	await handlers.get("tool_execution_start")!({ toolName: "bash", args: {} });
	await handlers.get("tool_execution_end")!({ isError: false });
	await handlers.get("tool_execution_start")!({ toolName: "grep", args: {} });
	await handlers.get("tool_execution_end")!({ isError: false });
	// agent_end.messages = 本 run 消息；只累加 assistant 的 usage.output。
	await handlers.get("agent_end")!({
		messages: [
			{ role: "user", content: [] },
			{ role: "assistant", usage: { input: 120, output: 600 } },
			{ role: "toolResult", toolCallId: "1" },
			{ role: "assistant", usage: { output: 996 } },
			{ role: "assistant" }, // usage 缺失 → 跳过
		],
	});
	assert.equal(calls.length, 2);
	assert.deepEqual(calls[1], {
		commands: 1,
		reads: 0,
		edits: 0,
		writes: 0,
		others: 1,
		failed: 0,
		durationMs: calls[1].durationMs,
		outputTokens: 1_596,
	});
});

test("agent-summary 注册 renderer，agent_end 输出引用块", async () => {
	initTheme("dark");
	const renderers = new Map<string, Function>();
	const appended: unknown[] = [];
	const events = new Map<string, Function>();
	const fakePi = {
		on: (event: string, handler: Function) => events.set(event, handler),
		registerEntryRenderer: (type: string, renderer: Function) => renderers.set(type, renderer),
		appendEntry: (type: string, data: unknown) => appended.push({ type, data }),
	} as any;

	agentSummaryFeature(fakePi);
	assert.ok(renderers.has(AGENT_SUMMARY_ENTRY_TYPE));

	await events.get("agent_start")!();
	await events.get("tool_execution_start")!({ toolName: "read", args: { path: "a.ts" } });
	await events.get("tool_execution_end")!({ isError: false });
	await events.get("tool_execution_start")!({ toolName: "bash", args: { command: "ls" } });
	await events.get("tool_execution_end")!({ isError: false });
	await events.get("agent_end")!();

	assert.equal(appended.length, 1);
	const renderer = renderers.get(AGENT_SUMMARY_ENTRY_TYPE)!;
	const component = renderer(
		{ data: (appended[0] as any).data },
		{ expanded: false },
		{ getFgAnsi: (color: string) => (color === "success" ? "\x1b[32m" : "\x1b[31m") },
	);
	const plain = stripAnsi((component as any).render(120).map(String).join("\n"));
	assert.doesNotMatch(plain, /[┌├└]/);
	assert.doesNotMatch(plain, /TIP/);
	assert.match(plain, /Ran 1 command, read 1 file/);
	assert.equal(
		renderer(
			{
				data: {
					commands: 0,
					reads: 0,
					edits: 0,
					writes: 0,
					others: 0,
					failed: 0,
					durationMs: 0,
				},
			},
			{ expanded: false },
			{ getFgAnsi: () => "" },
		),
		undefined,
	);
});
