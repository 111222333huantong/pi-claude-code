import assert from "node:assert/strict";
import test from "node:test";
import {
	CustomMessageComponent,
	ToolExecutionComponent,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, visibleWidth } from "@earendil-works/pi-tui";
import { installToolGrouping, ToolGroupComponent } from "../extensions/renderer/tool/grouping.ts";
import { renderSubagentNotification } from "../extensions/renderer/tool/subagent-notification.ts";

initTheme("dark");

const stripAnsi = (line: string) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

function plain(lines: string[]): string[] {
	return lines.map(stripAnsi).filter((line) => line.trim());
}

function finishedAgent(overrides: Record<string, unknown> = {}) {
	return {
		id: "6dae0e11-9341-43b",
		description: "Locate completion text owner",
		status: "completed",
		toolUses: 35,
		turnCount: 0,
		totalTokens: 57_100,
		totalCost: 0.8207,
		durationMs: 34_800,
		outputFile: "/tmp/pi-subagents-1000/session/tasks/6dae0e11-9341-43b.output",
		resultPreview: "The displayed block is owned by pi-subagents.\nSecond line…",
		...overrides,
	};
}

function notification(details: unknown) {
	return {
		role: "custom" as const,
		customType: "subagent-notification",
		content: "<task-notification>…</task-notification>",
		display: true,
		details,
		timestamp: 1,
	};
}

function standalone(details: unknown, expanded = false) {
	const component = new CustomMessageComponent(
		notification(details) as any,
		renderSubagentNotification as any,
	);
	component.setExpanded(expanded);
	return component;
}

test("a standalone finished-subagent row summarizes the agent id and usage", () => {
	const rows = plain(standalone(finishedAgent()).render(160));
	assert.deepEqual(rows, [
		" ✓ Subagent Finished 6dae0e11-9341-43b · 35 tool uses · 57.1k token · ~$0.8207 · 34.8s · click to show more",
	]);
});

test("unavailable statistics are omitted rather than shown as zero", () => {
	const rows = plain(
		standalone(
			finishedAgent({
				toolUses: 0,
				turnCount: 0,
				totalTokens: 0,
				totalCost: undefined,
				durationMs: 0,
			}),
		).render(160),
	);
	assert.deepEqual(rows, [" ✓ Subagent Finished 6dae0e11-9341-43b · click to show more"]);
	const measuredTurns = plain(standalone(finishedAgent({ turnCount: 3, toolUses: 1 })).render(160));
	assert.match(measuredTurns[0]!, /6dae0e11-9341-43b · 3 turns · 1 tool use · 57\.1k token/);
});

test("missing, null, and malformed details still render one finished-subagent row", () => {
	for (const details of [
		undefined,
		null,
		"oops",
		{ others: null },
		{ id: 42, others: [null, 7] },
	]) {
		const rows = plain(standalone(details).render(160));
		assert.deepEqual(rows, [" ✓ Subagent Finished · click to show more"], JSON.stringify(details));
	}
});

test("each agent in a group notification gets its own row with its own status", () => {
	const details = {
		...finishedAgent({ id: "first", status: "error", error: "upstream stream failed" }),
		others: [
			finishedAgent({ id: "second", status: "steered" }),
			finishedAgent({ id: "third", status: "aborted" }),
			finishedAgent({ id: "fourth", status: undefined, error: "crashed" }),
		],
	};
	const rows = plain(standalone(details).render(200));
	assert.equal(rows.length, 4);
	assert.match(rows[0]!, /^ ✗ Subagent Finished first · error · 35 tool uses/);
	assert.match(rows[1]!, /^ ✓ Subagent Finished second · completed \(steered\) · 35 tool uses/);
	assert.match(rows[2]!, /^ ✗ Subagent Finished third · aborted · 35 tool uses/);
	assert.match(rows[3]!, /^ ✗ Subagent Finished fourth · 35 tool uses/, "no status, no outcome");
	assert.equal(rows.filter((row) => row.includes("click to show more")).length, 1);
	assert.match(rows[3]!, /· click to show more$/);
});

test("the row names the outcome unless the agent simply completed", () => {
	const outcome = (status: string) => plain(standalone(finishedAgent({ status })).render(200))[0]!;
	assert.match(outcome("completed"), /^ ✓ Subagent Finished 6dae0e11-9341-43b · 35 tool uses/);
	assert.match(
		outcome("steered"),
		/^ ✓ Subagent Finished 6dae0e11-9341-43b · completed \(steered\) · 35 tool uses/,
	);
	assert.match(
		outcome("stopped"),
		/^ ✗ Subagent Finished 6dae0e11-9341-43b · stopped · 35 tool uses/,
	);
	assert.match(
		outcome("queued"),
		/^ ✓ Subagent Finished 6dae0e11-9341-43b · queued · 35 tool uses/,
	);
	const expanded = card(standalone(finishedAgent({ status: "steered" }), true).render(120));
	assert.equal(expanded[0], " ✓ Subagent Finished 6dae0e11-9341-43b");
	assert.equal(expanded[2], "   Status: completed (steered)");
});

function card(lines: string[]): string[] {
	const rows = lines.map((line) => stripAnsi(line).trimEnd());
	while (rows.length && !rows[0]) rows.shift();
	while (rows.length && !rows.at(-1)) rows.pop();
	return rows;
}

test("the expanded view shows description, status, stats, saved preview, and transcript", () => {
	const rows = card(standalone(finishedAgent(), true).render(120));
	assert.deepEqual(rows, [
		" ✓ Subagent Finished 6dae0e11-9341-43b",
		"   Locate completion text owner",
		"   Status: completed",
		"   35 tool uses · 57.1k token · ~$0.8207 · 34.8s",
		"",
		"   Saved result preview",
		"   The displayed block is owned by pi-subagents.",
		"   Second line…",
		"",
		"   Transcript",
		"   /tmp/pi-subagents-1000/session/tasks/6dae0e11-9341-43b.output",
	]);
});

test("the expanded view adds the error and omits whatever the payload lacks", () => {
	const failed = card(
		standalone(
			finishedAgent({
				status: "error",
				error: "Error Code null: upstream stream failed",
				resultPreview: "No output.",
				outputFile: undefined,
				totalCost: undefined,
			}),
			true,
		).render(120),
	);
	assert.deepEqual(failed, [
		" ✗ Subagent Finished 6dae0e11-9341-43b",
		"   Locate completion text owner",
		"   Status: error",
		"   35 tool uses · 57.1k token · 34.8s",
		"",
		"   Saved result preview",
		"   No output.",
		"",
		"   Error",
		"   Error Code null: upstream stream failed",
	]);
	assert.deepEqual(card(standalone(null, true).render(120)), [" ✓ Subagent Finished"]);
});

test("expanded preview wraps to the card width and agents are separated", () => {
	const long = "word ".repeat(30).trim();
	const details = {
		...finishedAgent({ id: "first", resultPreview: long, outputFile: undefined }),
		others: [finishedAgent({ id: "second", description: undefined, outputFile: undefined })],
	};
	const rows = card(standalone(details, true).render(60));
	for (const row of rows) assert.ok(row.length <= 60, row);
	const preview = rows.slice(rows.indexOf("   Saved result preview") + 1);
	assert.ok(preview[0]!.startsWith("   word word"));
	assert.ok(preview[1]!.startsWith("   word word"), "long preview wraps instead of truncating");
	const second = rows.indexOf(" ✓ Subagent Finished second");
	assert.ok(second > 0);
	assert.equal(rows[second - 1], "", "agents are separated by a blank row");
	assert.equal(rows[second + 1], "   Status: completed");
});

test("narrow standalone rows stay within the width and expanded text survives wrapping", () => {
	const details = {
		...finishedAgent({ id: "first", status: "error", error: "upstream stream failed" }),
		others: [
			finishedAgent({ id: "second", status: "steered" }),
			finishedAgent({ id: "third", status: "aborted" }),
			finishedAgent({ id: "fourth" }),
		],
	};
	const squash = (rows: string[]) => rows.join("").replace(/\s+/g, "");
	const wide = squash(card(standalone(details, true).render(200)));
	for (const width of [20, 30, 40, 120]) {
		for (const expanded of [false, true]) {
			for (const line of standalone(details, expanded).render(width)) {
				assert.ok(
					visibleWidth(line) <= width,
					`width ${width}, expanded ${expanded}: ${stripAnsi(line)}`,
				);
			}
		}
		assert.equal(squash(card(standalone(details, true).render(width))), wide, `width ${width}`);
	}
});

test("the expanded card background follows the worst agent status", () => {
	const tagTheme = {
		fg: (_color: string, text: string) => text,
		bg: (slot: string, text: string) => `<${slot}>${text}</${slot}>`,
	};
	const paint = (details: unknown) =>
		(renderSubagentNotification as any)(
			notification(details),
			{ expanded: true, outputPad: 1 },
			tagTheme,
		)
			.render(80)
			.join("\n");
	assert.match(paint(finishedAgent()), /<toolSuccessBg>/);
	assert.doesNotMatch(paint(finishedAgent()), /<toolErrorBg>/);
	const mixed = paint({ ...finishedAgent(), others: [finishedAgent({ status: "aborted" })] });
	assert.match(mixed, /<toolErrorBg>/);
	assert.doesNotMatch(mixed, /<toolSuccessBg>/);
});

const ui = { theme: { fg: (_color: string, text: string) => text }, requestRender() {} } as any;

function settledTool(name: string, id: string, args: any = {}, isError = false) {
	const component = new ToolExecutionComponent(
		name,
		id,
		args,
		{},
		undefined,
		ui,
		process.cwd(),
	) as any;
	component.markExecutionStarted();
	component.updateResult({ content: [{ type: "text", text: "ok" }], isError });
	return component;
}

function withGrouping(run: (hooks: ReturnType<typeof installToolGrouping>) => void) {
	const hooks = installToolGrouping(() => true);
	try {
		run(hooks);
	} finally {
		hooks.shutdown();
	}
}

test("a finished subagent joins the adjacent tools as one more grouped item", () => {
	withGrouping(() => {
		const parent = new Container() as any;
		const note = standalone(finishedAgent());
		parent.addChild(note);
		parent.addChild(
			settledTool("get_subagent_result", "result", { agent_id: "6dae0e11-9341-43b" }),
		);
		parent.addChild(
			settledTool("read", "read", {
				path: "/home/ning/github/pi-subagents/src/index.ts",
				offset: 280,
				limit: 92,
			}),
		);
		assert.equal(parent.children.length, 1);
		const group = parent.children[0] as ToolGroupComponent;
		assert.ok(group instanceof ToolGroupComponent);
		assert.equal(group.children[0], note, "the notification keeps its place in the order");
		assert.deepEqual(plain(group.render(240)), [
			" ● Multiple Tools: 3 done · Subagent Finished×1, Get Subagent Result×1, Read×1 · click to show more",
			" ├ ✓ Subagent Finished 6dae0e11-9341-43b · 35 tool uses · 57.1k token · ~$0.8207 · 34.8s",
			" ├ ✓ Get Subagent Result 6dae0e11-9341-43b",
			" └ ✓ Read /home/ning/github/pi-subagents/src/index.ts (offset=280, limit=92)",
		]);
	});
});

function groupOf(...members: any[]): ToolGroupComponent {
	const parent = new Container() as any;
	for (const member of members) parent.addChild(member);
	assert.equal(parent.children.length, 1, "members collapse into one group");
	return parent.children[0] as ToolGroupComponent;
}

test("an expanded group nests agent details in the tree and keeps tool views", () => {
	withGrouping(() => {
		const tools = () => [
			settledTool("get_subagent_result", "result", { agent_id: "6dae0e11-9341-43b" }),
			settledTool("read", "read", { path: "src/index.ts" }),
		];
		const baseline = groupOf(...tools());
		baseline.setExpanded(true);
		const toolRows = card(baseline.render(120)).slice(1);

		const note = standalone(finishedAgent());
		const group = groupOf(note, ...tools());
		group.setExpanded(true);
		const rows = card(group.render(120));
		assert.match(rows[0]!, /^ ● Multiple Tools: 3 done · .* · ↑ Collapse$/);
		assert.deepEqual(rows.slice(1, 13), [
			" ├ ✓ Subagent Finished 6dae0e11-9341-43b",
			" │   Locate completion text owner",
			" │   Status: completed",
			" │   35 tool uses · 57.1k token · ~$0.8207 · 34.8s",
			" │",
			" │   Saved result preview",
			" │   The displayed block is owned by pi-subagents.",
			" │   Second line…",
			" │",
			" │   Transcript",
			" │   /tmp/pi-subagents-1000/session/tasks/6dae0e11-9341-43b.output",
			" │",
		]);
		assert.deepEqual(rows.slice(13), toolRows, "tool rows are unchanged by the notification");

		// 展开状态转发给通知本身：拆组后它仍是展开卡。
		assert.match(card(note.render(120)).join("\n"), /Saved result preview/);
		group.setExpanded(false);
		assert.doesNotMatch(card(note.render(120)).join("\n"), /Saved result preview/);
	});
});

test("clicks on expanded notification rows belong to the group, tool rows to the tool", () => {
	withGrouping(() => {
		const result = settledTool("get_subagent_result", "result", { agent_id: "x" });
		const group = groupOf(standalone(finishedAgent()), result);
		group.setExpanded(true);
		const lines = group.render(120).map(stripAnsi);
		const statusRow = lines.findIndex((line) => line.includes("Status: completed"));
		const resultRow = lines.findIndex((line) => /[├└] ✓ .*get_subagent_result/i.test(line));
		assert.ok(resultRow > statusRow);
		assert.equal(group.childAtRow(statusRow, 120), null);
		assert.equal(group.childAtRow(resultRow, 120)?.component, result);
	});
});

test("notifications group only with adjacent tools and never across visible content", async () => {
	const { AssistantMessageComponent } = await import("@earendil-works/pi-coding-agent");
	withGrouping(() => {
		const alone = new Container() as any;
		const first = standalone(finishedAgent({ id: "first" }));
		const second = standalone(finishedAgent({ id: "second" }));
		alone.addChild(first);
		alone.addChild(second);
		assert.deepEqual(
			alone.children,
			[first, second],
			"notifications without a tool stay standalone",
		);

		// 等到工具出现，前面紧挨的完成通知按原顺序一起入组。
		const tool = settledTool("get_subagent_result", "joined", { agent_id: "second" });
		alone.addChild(tool);
		assert.equal(alone.children.length, 1);
		assert.deepEqual(alone.children[0].children, [first, second, tool]);

		const text = new Container() as any;
		text.addChild(standalone(finishedAgent()));
		text.addChild(
			new AssistantMessageComponent(
				{ role: "assistant", content: [{ type: "text", text: "visible" }] } as any,
				true,
			),
		);
		text.addChild(settledTool("read", "after-text", { path: "a.ts" }));
		assert.equal(
			text.children.some((child: any) => child instanceof ToolGroupComponent),
			false,
			"visible assistant text is a boundary",
		);

		const other = new Container() as any;
		other.addChild(settledTool("read", "before-other", { path: "a.ts" }));
		other.addChild(
			new CustomMessageComponent(
				{ ...notification(finishedAgent()), customType: "other-notification" } as any,
				undefined,
			),
		);
		other.addChild(settledTool("read", "after-other", { path: "b.ts" }));
		assert.equal(
			other.children.some((child: any) => child instanceof ToolGroupComponent),
			false,
			"other custom message types are not groupable",
		);
	});
});

test("multi-agent notifications count one item per agent in the group", () => {
	withGrouping(() => {
		const details = {
			...finishedAgent({ id: "a" }),
			others: [finishedAgent({ id: "b", status: "error" }), finishedAgent({ id: "c" })],
		};
		const group = groupOf(standalone(details), settledTool("read", "read", { path: "a.ts" }));
		const rows = plain(group.render(200));
		assert.match(
			rows[0]!,
			/^ ● Multiple Tools: 3 done · 1 failed · Subagent Finished×3, Read×1 · /,
		);
		assert.equal(rows.length, 5);
		assert.match(rows[1]!, /^ ├ ✓ Subagent Finished a · 35 tool uses/);
		assert.match(rows[2]!, /^ ├ ✗ Subagent Finished b · error · 35 tool uses/);
		assert.match(rows[3]!, /^ ├ ✓ Subagent Finished c · 35 tool uses/);
		assert.equal(rows[4], " └ ✓ Read a.ts");
	});
});

test("a group left with only notifications dissolves back to standalone rows", () => {
	withGrouping((hooks) => {
		const parent = new Container() as any;
		const first = standalone(finishedAgent({ id: "first" }));
		const second = standalone(finishedAgent({ id: "second" }));
		const tool = settledTool("read", "read", { path: "a.ts" });
		parent.addChild(first);
		parent.addChild(second);
		parent.addChild(tool);
		parent.removeChild(tool);
		assert.deepEqual(parent.children, [first, second]);

		const reloaded = new Container() as any;
		const note = standalone(finishedAgent());
		const read = settledTool("read", "reload", { path: "a.ts" });
		reloaded.addChild(note);
		reloaded.addChild(read);
		hooks.shutdown();
		assert.deepEqual(reloaded.children, [note, read], "shutdown releases the notification");
		const again = installToolGrouping(() => true);
		try {
			again.refresh({ getMountedRoots: () => [reloaded] });
			assert.deepEqual(reloaded.children[0].children, [note, read], "reload regroups it");
		} finally {
			again.shutdown();
		}
	});
});

test("a steered agent keeps its outcome inside the tool group", () => {
	withGrouping(() => {
		const parent = new Container() as any;
		parent.addChild(settledTool("Agent", "agent-1", { subagent_type: "general-purpose" }));
		parent.addChild(settledTool("Agent", "agent-2", { subagent_type: "general-purpose" }));
		parent.addChild(settledTool("steer_subagent", "steer", { agent_id: "a43b4a9d-fcf9-4b9" }));
		parent.addChild(
			standalone({
				id: "a43b4a9d-fcf9-4b9",
				description: "Complete no-op coordination test",
				status: "steered",
				toolUses: 0,
				turnCount: 0,
				totalTokens: 85,
				totalCost: 0.008,
				durationMs: 3_000,
				resultPreview: "Done.",
			}),
		);
		parent.addChild(
			settledTool("bash", "bash", { command: "printf 'Bash ran after subagent completion.\\n'" }),
		);
		assert.equal(parent.children.length, 1);
		const rows = plain(parent.children[0].render(240));
		assert.match(
			rows[0]!,
			/^ ● Multiple Tools: 5 done · Agent×2, Steer Subagent×1, Subagent Finished×1, Bash×1 · /,
		);
		assert.equal(
			rows[4],
			" ├ ✓ Subagent Finished a43b4a9d-fcf9-4b9 · completed (steered) · 85 token · ~$0.008 · 3.0s",
		);
	});
});
