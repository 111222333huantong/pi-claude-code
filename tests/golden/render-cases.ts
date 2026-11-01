/**
 * Golden 场景的渲染夹具。
 *
 * 原则：输入全部是固定常量（时间、diff、工具结果、宽度），渲染结果只由
 * renderer 决定；本地 settings 与真实主题不参与，否则快照会随开发机漂移。
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { config, normalizeConfig, setConfig } from "../../extensions/config/config.ts";
import {
	buildLines as buildStatusLines,
	type StatusSnapshot,
} from "../../extensions/feature/statusline/render.ts";
import claudeCodeStyle from "../../extensions/renderer/index.ts";
import { renderEditDiffResult } from "../../extensions/renderer/tool/diff/diff-renderer.ts";
import {
	DEFAULT_TOOL_DISPLAY_CONFIG,
	renderRichToolResult,
} from "../../extensions/renderer/tool/diff/index.ts";
import { WriteExecutionMetadataStore } from "../../extensions/renderer/tool/diff/write-execution.ts";
import {
	installToolGrouping,
	ToolGroupComponent,
} from "../../extensions/renderer/tool/grouping.ts";
import { setMessageDisplayTheme } from "../../extensions/renderer/tool/message-display.ts";
import { setToolTuiFullscreen } from "../../extensions/renderer/tool/names.ts";
import { normalizeLines } from "./harness.ts";

export type GoldenCase = { name: string; lines: string[] };

/** 固定时钟：耗时、动画帧都由挂钟推导，不动就会每跑一次变一个值。 */
const SNAPSHOT_NOW = 1_700_000_000_000;

function withSnapshotClock<T>(fn: () => T): T {
	const realNow = Date.now;
	Date.now = () => SNAPSHOT_NOW;
	try {
		return fn();
	} finally {
		Date.now = realNow;
	}
}

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	getFgAnsi: () => "",
	getBgAnsi: () => "",
};

const ui = {
	theme: plainTheme,
	setStatus() {},
	requestRender() {},
	getToolsExpanded: () => false,
};

function renderLines(component: any, width: number): string[] {
	return withSnapshotClock(() => normalizeLines(component.render(width)));
}

const DIFF = [
	"@@ -1,6 +1,8 @@",
	' 1|import { run } from "./runner";',
	"-2|const threshold = 41;",
	"+2|const threshold = 42;",
	" 3|export default run;",
	'+4|export const version = "1.5.0";',
	" 5|// keep context",
	' 6|export type Mode = "on" | "compact";',
	"@@ -40,4 +40,5 @@",
	" 40|function helper() {",
	"-41|  return threshold;",
	"+41|  return threshold + 1;",
	"+42|  // new note",
	" 43|}",
].join("\n");

const DIFF_LONG = [
	"@@ -1,30 +1,30 @@",
	...Array.from({ length: 30 }, (_, index) => {
		const line = index + 1;
		if (line === 3) return `-3|old value ${line}`;
		if (line === 4) return `+3|new value ${line}`;
		return ` ${line}|row ${line}`;
	}),
].join("\n");

async function bootDefaultMode(): Promise<() => Promise<void>> {
	const events = new Map<string, Array<(...args: any[]) => any>>();
	const pi = {
		registerCommand() {},
		registerShortcut() {},
		registerTool() {},
		on(name: string, handler: (...args: any[]) => any) {
			const list = events.get(name) ?? [];
			list.push(handler);
			events.set(name, list);
		},
	};
	const previousMode = config.mode;
	claudeCodeStyle(pi as any, { mode: "on" });
	const ctx = { mode: "tui", hasUI: true, ui, isIdle: () => true };
	for (const handler of events.get("session_start") ?? []) await handler({}, ctx);
	setMessageDisplayTheme(plainTheme as any);
	return async () => {
		for (const handler of events.get("session_shutdown") ?? []) await handler({}, ctx);
		config.mode = previousMode;
	};
}

/** 固定虚拟 cwd：保证 write 的「文件不存在」判定与开发机目录无关。 */
const GOLDEN_CWD = join(tmpdir(), "pi-cc-golden-cwd");

function tool(name: string, id: string, args: Record<string, unknown> = {}) {
	return new ToolExecutionComponent(
		name,
		id,
		args,
		{},
		{ name } as any,
		ui as any,
		GOLDEN_CWD,
	) as any;
}

function succeed(component: any, text?: string, details?: unknown) {
	withSnapshotClock(() => {
		component.updateResult({
			content: text == null ? [] : [{ type: "text", text }],
			details,
			isError: false,
		});
	});
	return component;
}

function fail(component: any, text: string) {
	withSnapshotClock(() => {
		component.updateResult({ content: [{ type: "text", text }], isError: true });
	});
	return component;
}

function diffComponent(
	diff: string,
	options: { expanded: boolean; width: number; split?: boolean; collapsedLines?: number },
) {
	const displayConfig = {
		...DEFAULT_TOOL_DISPLAY_CONFIG,
		diffViewMode: options.split ? ("split" as const) : ("unified" as const),
		diffWordWrap: false,
		...(options.collapsedLines === undefined
			? {}
			: { editDiffCollapsedLines: options.collapsedLines }),
	};
	const component = renderEditDiffResult(
		{ diff },
		{ expanded: options.expanded, filePath: "src/sample.ts" },
		displayConfig,
		plainTheme as any,
		"",
	);
	return renderLines(component, options.width);
}

export async function renderGoldenCases(): Promise<GoldenCase[]> {
	initTheme("dark");
	setToolTuiFullscreen(true);
	// 本机 /ccstyle 设置不能漏进快照。
	setConfig(normalizeConfig({ ...config, ...DEFAULT_TOOL_DISPLAY_CONFIG }));

	const cases: GoldenCase[] = [];

	// --- diff：宽度是布局最容易漂移的维度 --------------------------------
	for (const width of [40, 80, 120]) {
		cases.push({
			name: `diff/unified-${width}`,
			lines: diffComponent(DIFF, { expanded: true, width }),
		});
	}
	cases.push({
		name: "diff/split-100",
		lines: diffComponent(DIFF, { expanded: true, width: 100, split: true }),
	});
	cases.push({
		name: "diff/collapsed-80",
		lines: diffComponent(DIFF_LONG, { expanded: false, width: 80, collapsedLines: 2 }),
	});

	// --- 工具卡：状态 + 参数 + 富 diff ------------------------------------
	const shutdown = await bootDefaultMode();
	try {
		const read = succeed(
			tool("read", "g-read", { path: "src/sample.ts", offset: 10, limit: 20 }),
			Array.from({ length: 20 }, (_, index) => `line ${index + 10}`).join("\n"),
		);
		cases.push({ name: "tool-card/read-80", lines: renderLines(read, 80) });

		const readError = fail(
			tool("read", "g-read-error", { path: "src/missing.ts" }),
			"ENOENT: no such file or directory",
		);
		cases.push({ name: "tool-card/read-error-80", lines: renderLines(readError, 80) });

		const bash = tool("bash", "g-bash", { command: "npm test" });
		bash.markExecutionStarted();
		succeed(bash, "pass 832\nfail 0");
		withSnapshotClock(() => {
			bash.updateResult({
				content: [{ type: "text", text: "pass 832\nfail 0" }],
				isError: false,
				durationMs: 12_400,
			});
		});
		cases.push({ name: "tool-card/bash-80", lines: renderLines(bash, 80) });

		const bashExpanded = tool("bash", "g-bash-expanded", { command: "npm test" });
		bashExpanded.markExecutionStarted();
		bashExpanded.setExpanded(true);
		withSnapshotClock(() => {
			bashExpanded.updateResult({
				content: [{ type: "text", text: "pass 832\nfail 0" }],
				isError: false,
				durationMs: 12_400,
			});
		});
		cases.push({ name: "tool-card/bash-expanded-80", lines: renderLines(bashExpanded, 80) });

		const editCollapsed = succeed(tool("edit", "g-edit", { path: "src/sample.ts" }), undefined, {
			diff: DIFF,
		});
		cases.push({ name: "tool-card/edit-collapsed-80", lines: renderLines(editCollapsed, 80) });

		const editExpanded = succeed(
			tool("edit", "g-edit-open", { path: "src/sample.ts" }),
			undefined,
			{
				diff: DIFF,
			},
		);
		editExpanded.setExpanded(true);
		cases.push({ name: "tool-card/edit-expanded-80", lines: renderLines(editExpanded, 80) });

		const write = tool("write", "g-write", { path: "src/new.ts", content: "const x = 1\n" });
		write.setExpanded(true);
		succeed(write, "wrote src/new.ts");
		cases.push({ name: "tool-card/write-expanded-80", lines: renderLines(write, 80) });

		// write 富 diff 需要执行前元数据（新建 vs 覆盖），单独用受控 store 渲染。
		const store = new WriteExecutionMetadataStore();
		store.set("golden-write", { fileExistedBeforeWrite: false });
		const writeDiff = renderRichToolResult(
			"write",
			{ content: [{ type: "text", text: "wrote src/new.ts" }], details: {} },
			{ expanded: true },
			plainTheme as any,
			{
				toolCallId: "golden-write",
				args: { path: "src/new.ts", content: "const x = 1\n" },
			},
			store,
		);
		cases.push({ name: "diff/write-create-80", lines: renderLines(writeDiff, 80) });

		const editNarrow = succeed(
			tool("edit", "g-edit-narrow", { path: "src/sample.ts" }),
			undefined,
			{
				diff: DIFF,
			},
		);
		editNarrow.setExpanded(true);
		cases.push({ name: "tool-card/edit-expanded-40", lines: renderLines(editNarrow, 40) });
	} finally {
		await shutdown();
	}

	// --- 状态栏：L1/L2 组装与窄屏降级 --------------------------------------
	const statusBase: StatusSnapshot = {
		model: "opus-4-6",
		thinking: "high",
		cwd: "~/pi-claude-code",
		ctxPct: 23.4,
		ctxTokens: 46_000,
		ctxWindow: 200_000,
		cost: 1.23,
		mcp: "mcp 3 enabled",
		extTotal: 7,
		branch: "feat/statusline",
		changedFiles: 3,
		hasConflicts: false,
		conflictFiles: 0,
		ahead: 2,
		behind: 0,
		insertions: 18,
		deletions: 5,
		pr: 42,
		worktree: "golden-wt",
		showWorktree: true,
		turnElapsedMs: null,
	};
	const paint = (_color: string, text: string) => text;
	for (const width of [60, 120]) {
		cases.push({
			name: `statusline/full-${width}`,
			lines: buildStatusLines(statusBase as StatusSnapshot, width, paint as any),
		});
	}
	cases.push({
		name: "statusline/running-100",
		lines: buildStatusLines(
			{
				...statusBase,
				ctxPct: 87.5,
				ctxTokens: 175_000,
				changedFiles: 9,
				insertions: 320,
				deletions: 87,
				turnElapsedMs: 92_000,
			},
			100,
			paint as any,
		),
	});

	// --- 工具分组：组头 + 折叠行 + 展开 -----------------------------------
	const grouping = installToolGrouping(() => true);
	try {
		grouping.setTheme(plainTheme);
		const parent = new Container() as any;
		const read = tool("read", "gr-read", { path: "extensions/index.ts" });
		const bash = tool("bash", "gr-bash", { command: "npm test" });
		const grep = tool("ffgrep", "gr-grep", { path: "extensions/", pattern: "renderCall" });
		parent.addChild(read);
		parent.addChild(bash);
		parent.addChild(grep);
		const group = parent.children[0];
		if (!(group instanceof ToolGroupComponent)) {
			throw new Error(`expected tool group, got ${group?.constructor?.name ?? typeof group}`);
		}
		succeed(read, Array.from({ length: 40 }, (_, index) => `L${index}`).join("\n"));
		withSnapshotClock(() => {
			bash.updateResult({
				content: [{ type: "text", text: "pass 832" }],
				isError: false,
				durationMs: 12_400,
			});
		});
		fail(grep, "no match");
		cases.push({ name: "tool-group/collapsed-120", lines: renderLines(group, 120) });
		group.setExpanded(true);
		cases.push({ name: "tool-group/expanded-120", lines: renderLines(group, 120) });
	} finally {
		grouping.shutdown();
	}

	return cases;
}
