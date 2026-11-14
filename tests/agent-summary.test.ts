import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
	AgentRunSummary,
	type AgentSummaryData,
	bindAgentSummary,
	classifyTool,
	summaryMarkdown,
	summarySegments,
} from "../extensions/feature/agent-summary/core.ts";
import agentSummaryFeature, {
	AGENT_SUMMARY_ENTRY_TYPE,
} from "../extensions/feature/agent-summary/index.ts";
import { formatClockTime } from "../extensions/utils/format.ts";

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

test("classifyTool：bash/read/edit/other；write 并入 edit", () => {
	assert.equal(classifyTool("bash"), "bash");
	assert.equal(classifyTool("powershell"), "bash");
	assert.equal(classifyTool("read"), "read");
	assert.equal(classifyTool("edit"), "edit");
	assert.equal(classifyTool("write"), "edit");
	assert.equal(classifyTool("grep"), "other");
	// MCP 风格名不是精确工具名：归 other
	assert.equal(classifyTool("mcp__server__read"), "other");
});

test("AgentRunSummary：bash/powershell 计数；read/edit（含 write）按路径去重；other 计数", () => {
	const summary = new AgentRunSummary(1_000);
	summary.recordToolStart("bash", { command: "npm test" });
	summary.recordToolStart("powershell", { command: "Get-ChildItem" });
	summary.recordToolStart("bash", { command: "ls" });
	summary.recordToolStart("read", { path: "a.ts" });
	summary.recordToolStart("read", { path: "a.ts" }); // 去重
	summary.recordToolStart("read", { path: "b.ts" });
	summary.recordToolStart("edit", { file_path: "c.ts" }); // file_path 别名
	summary.recordToolStart("write", { path: "c.ts" }); // 与 edit 合并去重
	summary.recordToolStart("write", { path: "d.ts" });
	summary.recordToolStart("write", { path: "d.ts" }); // 去重
	summary.recordToolStart("grep", { pattern: "x" });
	summary.recordToolResult(true);
	summary.recordToolResult(false);

	assert.equal(summary.toolCount, 11);
	const data = summary.snapshot(61_000);
	assert.deepEqual(data, {
		commands: 3,
		reads: 2,
		edits: 2,
		others: 1,
		failed: 1,
		durationMs: 60_000,
		endedAt: 61_000,
		outputTokens: 0,
	} satisfies AgentSummaryData);
});

test("formatClockTime：h:mm AM/PM，非法值返回空串", () => {
	assert.equal(formatClockTime(new Date(2025, 0, 2, 18, 51).getTime()), "6:51 PM");
	assert.equal(formatClockTime(new Date(2025, 0, 2, 0, 5).getTime()), "12:05 AM");
	assert.equal(formatClockTime(new Date(2025, 0, 2, 12, 0).getTime()), "12:00 PM");
	assert.equal(formatClockTime(Number.NaN), "");
	assert.equal(formatClockTime(0), "");
});

test("summarySegments：bash→read→edit→other→failed，首段大写", () => {
	const data: AgentSummaryData = {
		commands: 3,
		reads: 2,
		edits: 2,
		others: 1,
		failed: 1,
		durationMs: 42_000,
		endedAt: 43_000,
	};
	assert.deepEqual(summarySegments(data), [
		{ text: "Ran 3 commands", tone: "success" },
		{ text: "read 2 files", tone: "success" },
		{ text: "edited 2 files", tone: "success" },
		{ text: "1 other tool", tone: "success" },
		{ text: "1 failed", tone: "failed" },
	]);
	assert.deepEqual(
		summarySegments({ ...data, commands: 0, reads: 0, edits: 0, others: 0, failed: 0 }),
		[],
	);
	// 无 outputTokens（旧 entry / usage 缺失）→ 整数秒旧格式。
	assert.equal(
		summaryMarkdown(data),
		`> *Ran 3 commands, read 2 files, edited 2 files, 1 other tool, 1 failed · 42s · done ${formatClockTime(43_000)}*`,
	);
	// 有 outputTokens → 精确时长 + tok/s（整回合平均口径）。
	assert.equal(
		summaryMarkdown({ ...data, durationMs: 52_500, outputTokens: 1_596 }),
		`> *Ran 3 commands, read 2 files, edited 2 files, 1 other tool, 1 failed · 52.5s · 30.4 tok/s · done ${formatClockTime(43_000)}*`,
	);
	// tokens=0 → 省略速率段，退回整数秒。
	assert.equal(
		summaryMarkdown({ ...data, outputTokens: 0 }),
		`> *Ran 3 commands, read 2 files, edited 2 files, 1 other tool, 1 failed · 42s · done ${formatClockTime(43_000)}*`,
	);
	// 时长 <1s → 省略速率段。
	assert.equal(
		summaryMarkdown({ ...data, durationMs: 400, outputTokens: 1_596 }),
		`> *Ran 3 commands, read 2 files, edited 2 files, 1 other tool, 1 failed · done ${formatClockTime(43_000)}*`,
	);
	// 有 ttftMs → 追加 TTFT 段；无/零 → 省略。
	assert.equal(
		summaryMarkdown({ ...data, durationMs: 52_500, outputTokens: 1_596, ttftMs: 812 }),
		`> *Ran 3 commands, read 2 files, edited 2 files, 1 other tool, 1 failed · 52.5s · 30.4 tok/s · TTFT 812ms · done ${formatClockTime(43_000)}*`,
	);
	assert.equal(
		summaryMarkdown({ ...data, ttftMs: 0 }),
		`> *Ran 3 commands, read 2 files, edited 2 files, 1 other tool, 1 failed · 42s · done ${formatClockTime(43_000)}*`,
	);
	assert.equal(
		summaryMarkdown({ ...data, commands: 0, reads: 0, edits: 0, others: 0, failed: 0 }),
		"",
	);
});

test("bindAgentSummary 事件绑定：before_agent_start 重置、agent_end 记 usage、agent_settled 回调", async () => {
	const handlers = new Map<string, Function>();
	const fakePi = {
		on: (event: string, handler: Function) => handlers.set(event, handler),
	} as any;

	const calls: AgentSummaryData[] = [];
	bindAgentSummary(fakePi, (data) => calls.push(data));

	await handlers.get("before_agent_start")!();
	await handlers.get("tool_execution_start")!({ toolName: "read", args: { path: "a.ts" } });
	await handlers.get("tool_execution_end")!({ isError: false });
	await handlers.get("agent_end")!();
	await handlers.get("agent_settled")!();
	assert.equal(calls.length, 0); // toolCount < 2

	await handlers.get("tool_execution_start")!({ toolName: "bash", args: { command: "ls" } });
	await handlers.get("tool_execution_end")!({ isError: true });
	await handlers.get("agent_end")!();
	await handlers.get("agent_settled")!();
	assert.equal(calls.length, 1);
	assert.equal(calls[0].commands, 1);
	assert.equal(calls[0].failed, 1);
	assert.equal(calls[0].reads, 1);

	await handlers.get("before_agent_start")!();
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
	await handlers.get("agent_settled")!();
	assert.equal(calls.length, 2);
	assert.deepEqual(calls[1], {
		commands: 1,
		reads: 0,
		edits: 0,
		others: 1,
		failed: 0,
		durationMs: calls[1].durationMs,
		endedAt: calls[1].endedAt,
		outputTokens: 1_596,
	});
	assert.ok(Number.isFinite(calls[1].endedAt));
});

test("bindAgentSummary：自动重试的多个 agent_end 累加，settled 只回调一次", async () => {
	const handlers = new Map<string, Function>();
	const fakePi = {
		on: (event: string, handler: Function) => handlers.set(event, handler),
	} as any;
	const calls: AgentSummaryData[] = [];
	bindAgentSummary(fakePi, (data) => calls.push(data));

	await handlers.get("before_agent_start")!();
	await handlers.get("tool_execution_start")!({ toolName: "read", args: { path: "a.ts" } });
	await handlers.get("tool_execution_end")!({ isError: false });
	await handlers.get("tool_execution_start")!({ toolName: "bash", args: {} });
	await handlers.get("tool_execution_end")!({ isError: true });
	await handlers.get("agent_end")!({
		messages: [{ role: "assistant", usage: { output: 100 } }],
	});

	// 重试：before_agent_start 不会重复；统计不清零。
	await handlers.get("tool_execution_start")!({ toolName: "read", args: { path: "b.ts" } });
	await handlers.get("tool_execution_end")!({ isError: false });
	await handlers.get("agent_end")!({
		messages: [{ role: "assistant", usage: { output: 150 } }],
	});
	assert.equal(calls.length, 0, "settled 之前不能提前出摘要");

	await handlers.get("agent_settled")!();
	assert.equal(calls.length, 1);
	assert.equal(calls[0].reads, 2);
	assert.equal(calls[0].commands, 1);
	assert.equal(calls[0].failed, 1);
	assert.equal(calls[0].outputTokens, 250);
});

test("agent-summary 注册 renderer，agent_settled 输出引用块", async () => {
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

	await events.get("before_agent_start")!();
	await events.get("tool_execution_start")!({ toolName: "read", args: { path: "a.ts" } });
	await events.get("tool_execution_end")!({ isError: false });
	await events.get("tool_execution_start")!({ toolName: "bash", args: { command: "ls" } });
	await events.get("tool_execution_end")!({ isError: false });
	await events.get("agent_end")!();
	await events.get("agent_settled")!();

	assert.equal(appended.length, 1);
	const renderer = renderers.get(AGENT_SUMMARY_ENTRY_TYPE)!;
	const theme = {
		getFgAnsi: (color: string) => (color === "success" ? "\x1b[32m" : "\x1b[31m"),
		fg: (_color: string, text: string) => text,
		italic: (text: string) => text,
	};
	const component = renderer({ data: (appended[0] as any).data }, { expanded: false }, theme);
	const raw = (component as any).render(120).map(String).join("\n");
	// 数字必须自己带语义色：Markdown 会剥掉终端序列，这里不能再依赖它。
	assert.match(raw, /\x1b\[32m1\x1b\[0m command/);
	assert.match(raw, /│/);
	const plain = stripAnsi(raw);
	assert.match(plain, /Ran 1 command, read 1 file/);
	// 末尾追加完成时刻：耗时 + done h:mm AM/PM
	assert.match(plain, /· done (?:1[0-2]|[1-9]):[0-5]\d (?:AM|PM)/);

	// 固定时刻下整行形状；不足 1 秒不报耗时，只留完成时刻，不出双分隔。
	const fixed = renderer(
		{
			data: {
				commands: 1,
				reads: 0,
				edits: 0,
				others: 0,
				failed: 0,
				durationMs: 500,
				endedAt: new Date(2025, 0, 2, 18, 51).getTime(),
			},
		},
		{ expanded: false },
		theme,
	);
	assert.equal(
		stripAnsi((fixed as any).render(120).map(String).join("\n")).trim(),
		"│ Ran 1 command · done 6:51 PM",
	);

	// 旧版本写的 entry 没有 endedAt：只显示耗时，不显示完成时刻。
	const legacy = renderer(
		{
			data: {
				commands: 1,
				reads: 0,
				edits: 0,
				others: 0,
				failed: 0,
				durationMs: 15_000,
			},
		},
		{ expanded: false },
		theme,
	);
	assert.equal(
		stripAnsi((legacy as any).render(120).map(String).join("\n")).trim(),
		"│ Ran 1 command · 15s",
	);

	assert.equal(
		renderer(
			{
				data: {
					commands: 0,
					reads: 0,
					edits: 0,
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
