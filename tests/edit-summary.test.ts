import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
	createEditToolDefinition,
	initTheme,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import {
	config,
	DEFAULT_TOOL_DISPLAY_CONFIG,
	DIFF_COLLAPSED_LINES_VALUES,
	normalizeConfig,
	type ToolDisplayConfig,
} from "../extensions/config/config.ts";
import { buildMessageSummary, installCompactMode } from "../extensions/renderer/compact-mode.ts";
import { installDefaultMode } from "../extensions/renderer/default-mode.ts";
import { isToolCallHovered } from "../extensions/renderer/mouse/hover.ts";
import { installToolMouseInteraction } from "../extensions/renderer/mouse/interaction.ts";
import {
	isRichDiffComponent,
	renderEditDiffResult,
} from "../extensions/renderer/tool/diff/diff-renderer.ts";
import {
	renderRichToolResult,
	WriteExecutionMetadataStore,
} from "../extensions/renderer/tool/diff/index.ts";
import {
	getMessageDisplayTheme,
	setMessageDisplayTheme,
} from "../extensions/renderer/tool/message-display.ts";
import {
	isToolTuiFullscreen,
	setToolTuiFullscreen,
	showMoreHintText,
} from "../extensions/renderer/tool/names.ts";
import { insetComponent } from "../extensions/renderer/tool/result.ts";

initTheme("dark");

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	getFgAnsi: () => "",
	getBgAnsi: () => "",
};
const diff = "-1|OLD_CONTENT\n+1|NEW_CONTENT\n 2|unchanged";
const summaryConfig: ToolDisplayConfig = {
	...DEFAULT_TOOL_DISPLAY_CONFIG,
	editDiffCollapsedLines: 0,
	// 这些用例只验证“摘要行”本身；预览行由单独用例覆盖。
	diffCollapsedPreviewLines: 0,
};
type HintComponent = Component & { isCollapsedHintLine(line: string): boolean };

function plainLines(component: Component, width = 100): string[] {
	return component
		.render(width)
		.map(stripVTControlCharacters)
		.map((line) => line.trim());
}

test("edit collapsed lines accepts auto/zero without changing the write setting", () => {
	assert.equal(normalizeConfig({}).editDiffCollapsedLines, "auto");
	assert.equal(normalizeConfig({ editDiffCollapsedLines: "auto" }).editDiffCollapsedLines, "auto");
	assert.equal(normalizeConfig({ editDiffCollapsedLines: 0 }).editDiffCollapsedLines, 0);
	assert.equal(normalizeConfig({ editDiffCollapsedLines: "0" }).editDiffCollapsedLines, 0);
	assert.equal(normalizeConfig({ editDiffCollapsedLines: -3 }).editDiffCollapsedLines, 0);
	assert.equal(normalizeConfig({ editDiffCollapsedLines: 1 }).editDiffCollapsedLines, 1);
	assert.equal(normalizeConfig({ editDiffCollapsedLines: 999 }).editDiffCollapsedLines, 500);
	assert.equal(
		normalizeConfig({ editDiffCollapsedLines: "invalid" }).editDiffCollapsedLines,
		"auto",
	);
	assert.equal(normalizeConfig({ editDiffCollapsedLines: 0 }).writeDiffCollapsedLines, 0);
	assert.ok(DIFF_COLLAPSED_LINES_VALUES.includes("auto"), "the settings panel offers auto");
	assert.ok(DIFF_COLLAPSED_LINES_VALUES.includes("0"), "the settings panel offers summary-only");
});

test("auto edit preview expands small diffs and summarizes large ones", () => {
	const auto = {
		...DEFAULT_TOOL_DISPLAY_CONFIG,
		editDiffCollapsedLines: "auto" as const,
		diffCollapsedPreviewLines: 0,
	};
	const render = (diffText: string, expanded = false) =>
		plainLines(
			renderEditDiffResult({ diff: diffText }, { expanded }, auto, theme, "") as Component,
		).join("\n");
	const makeDiff = (added: number, removed: number) => {
		const rows = ["@@ -1,40 +1,40 @@"];
		for (let index = 0; index < removed; index++) rows.push(`-${index + 1}|old ${index}`);
		for (let index = 0; index < added; index++) rows.push(`+${index + 1}|new ${index}`);
		return rows.join("\n");
	};

	// 2 行改动：完整正文照常显示。
	const small = render(diff);
	assert.match(small, /OLD_CONTENT/);
	assert.match(small, /NEW_CONTENT/);

	// 边界：增删合计 16 行仍算小改。
	const boundary = render(makeDiff(8, 8));
	assert.match(boundary, /old 0/);
	assert.match(boundary, /new 0/);
	assert.doesNotMatch(boundary, /more diff lines/);

	// 17 行起收成一行摘要，正文不渲染。
	const large = render(makeDiff(9, 8));
	assert.match(large, /↳ \+9 -8 · .*to show more/);
	assert.doesNotMatch(large, /old 0|new 0/);

	// 展开后仍然全量，不因为 auto 被卡住。
	const expanded = render(makeDiff(9, 8), true);
	assert.match(expanded, /old 0/);
	assert.match(expanded, /new 0/);
});

test("折叠大 diff 先露 3 行改动，展开入口仍是摘要行", () => {
	const rows = ["@@ -1,20 +1,20 @@", " 1|same"];
	for (let index = 0; index < 9; index++) rows.push(`-${index + 2}|old ${index}`);
	for (let index = 0; index < 9; index++) rows.push(`+${index + 2}|new ${index}`);
	const component = renderEditDiffResult(
		{ diff: rows.join("\n") },
		{ expanded: false },
		{ ...DEFAULT_TOOL_DISPLAY_CONFIG, editDiffCollapsedLines: "auto" },
		theme,
		"",
	) as HintComponent;
	const plain = plainLines(component);
	assert.equal(plain.length, 4, "摘要 + 3 行预览");
	assert.match(plain[0]!, /↳ \+9 -9 · .*to show more/);
	assert.match(plain.slice(1).join("\n"), /old 0/);
	assert.match(plain.slice(1).join("\n"), /new 0/);
	assert.doesNotMatch(plain.join("\n"), /old 8/);
	assert.equal(component.isCollapsedHintLine(plain[0]!), true);
	assert.equal(component.isCollapsedHintLine(plain[1]!), false, "预览正文不抢摘要行的展开入口");
	assert.equal(component.isCollapsedHintLine("不存在的行"), false);
});

test("折叠预览固定行数：超长代码行不靠换行撑高卡片", () => {
	const long = `const value = "${"x".repeat(300)}";`;
	const rows = ["@@ -1,20 +1,20 @@", " 1|same", `-2|${long}`, `+2|${long}y`];
	for (let index = 0; index < 9; index++) rows.push(`-${index + 3}|old ${index}`);
	for (let index = 0; index < 9; index++) rows.push(`+${index + 3}|new ${index}`);
	for (const width of [40, 80]) {
		const component = renderEditDiffResult(
			{ diff: rows.join("\n") },
			{ expanded: false },
			{ ...DEFAULT_TOOL_DISPLAY_CONFIG, editDiffCollapsedLines: "auto", diffWordWrap: true },
			theme,
			"",
		) as HintComponent;
		const rendered = component.render(width);
		assert.equal(rendered.length, 4, `width ${width}: 摘要 + 3 行预览，不随换行膨胀`);
		assert.ok(rendered.every((line) => visibleWidth(line) <= width));
	}
});

test("zero edit preview is one width-safe summary row in every diff layout", () => {
	for (const diffViewMode of ["auto", "unified", "split"] as const) {
		for (const diffWordWrap of [false, true]) {
			const component = renderEditDiffResult(
				{ diff },
				{ expanded: false },
				{ ...summaryConfig, diffViewMode, diffWordWrap },
				theme,
				"",
			) as HintComponent;
			assert.equal(isRichDiffComponent(component), true);
			for (const width of [0, 1, 7, 12, 18, 24, 48, 80, 140]) {
				const rows = component.render(width);
				assert.equal(rows.length, 1, `${diffViewMode} at width ${width}`);
				assert.ok(rows.every((line) => visibleWidth(line) <= width));
				const text = rows.map(stripVTControlCharacters).join("\n");
				assert.doesNotMatch(text, /OLD_CONTENT|NEW_CONTENT|unchanged|[─│▌]/);
				if (width >= 80) {
					assert.match(text, /↳ \+1 -1 · .*to show more/);
					assert.equal(component.isCollapsedHintLine(text), true);
					assert.equal(component.isCollapsedHintLine("OLD_CONTENT"), false);
				}
			}
		}
	}
});

test("edit summary live-updates on the same rich component and refreshes its hint identity", () => {
	let display = { ...summaryConfig, diffViewMode: "unified" as const };
	const component = renderEditDiffResult(
		{ diff },
		{ expanded: false },
		() => display,
		theme,
		"",
	) as HintComponent;
	const summary = plainLines(component);
	assert.equal(summary.length, 1);
	assert.equal(component.isCollapsedHintLine(summary[0]!), true);

	display = { ...display, editDiffCollapsedLines: 24 };
	const preview = plainLines(component).join("\n");
	assert.match(preview, /OLD_CONTENT/);
	assert.match(preview, /NEW_CONTENT/);
	assert.equal(component.isCollapsedHintLine(summary[0]!), false);

	display = { ...display, editDiffCollapsedLines: 0 };
	assert.deepEqual(plainLines(component), summary);
	assert.equal(component.isCollapsedHintLine(summary[0]!), true);
});

test("expanding a zero-line edit preview still renders the entire long diff", () => {
	const lines = ["@@ -1,80 +1,80 @@"];
	for (let index = 1; index <= 80; index++) {
		lines.push(`-${index}|old value ${index}`, `+${index}|new value ${index}`);
	}
	for (const diffViewMode of ["unified", "split"] as const) {
		const component = renderEditDiffResult(
			{ diff: lines.join("\n") },
			{ expanded: true },
			{ ...summaryConfig, diffViewMode },
			theme,
			"",
		) as HintComponent;
		const rows = plainLines(component, 160);
		assert.match(rows.join("\n"), /old value 80/);
		assert.match(rows.join("\n"), /new value 80/);
		assert.doesNotMatch(rows.join("\n"), /to show more/);
		assert.ok(rows.every((line) => !component.isCollapsedHintLine(line)));
	}
});

test("edit summary hints preserve keyboard/fullscreen labels and hover only the action", () => {
	const previousFullscreen = isToolTuiFullscreen();
	const hoverTheme = {
		...theme,
		fg(color: string, text: string) {
			return `${color === "text" ? "\x1b[97m" : "\x1b[90m"}${text}\x1b[39m`;
		},
	};
	try {
		for (const fullscreen of [false, true]) {
			setToolTuiFullscreen(fullscreen);
			let hovered = false;
			const component = renderEditDiffResult(
				{ diff },
				{ expanded: false, isHovered: () => hovered },
				summaryConfig,
				hoverTheme,
				"",
			);
			const label = fullscreen ? "click to show more" : "ctrl+o to show more";
			const resting = component.render(100)[0]!;
			assert.ok(resting.includes(label));
			assert.doesNotMatch(resting, /\x1b\[97m/);
			hovered = true;
			const active = component.render(100)[0]!;
			assert.ok(active.includes(`\x1b[97m${label}\x1b[39m`));
			assert.doesNotMatch(active, /\x1b\[97m[^\n]*·/);
		}
	} finally {
		setToolTuiFullscreen(previousFullscreen);
	}
});

test("edit summary keeps errors, pending results, and missing diff on their fallback paths", () => {
	for (const options of [{ isError: true }, { isPartial: true }]) {
		assert.equal(
			renderRichToolResult(
				"edit",
				{ details: { diff }, content: [] },
				options,
				theme,
				{ args: { path: "sample.txt" } },
				new WriteExecutionMetadataStore(),
				summaryConfig,
			),
			undefined,
		);
	}
	for (const details of [undefined, {}, { diff: "" }]) {
		const component = renderEditDiffResult(
			details,
			{ expanded: false },
			summaryConfig,
			theme,
			"fallback output",
		);
		assert.equal(isRichDiffComponent(component), false);
		assert.equal(plainLines(component).join("\n"), "fallback output");
	}
});

for (const mode of ["on", "compact"] as const) {
	test(`${mode} edit summary keeps the file row and supports config changes and expansion`, () => {
		const previousConfig = { ...config };
		const previousTheme = getMessageDisplayTheme();
		Object.assign(config, {
			mode,
			editDiffCollapsedLines: 0,
			diffCollapsedPreviewLines: 0,
			diffViewMode: "unified",
		});
		setMessageDisplayTheme(theme);
		const store = new WriteExecutionMetadataStore();
		const defaultHooks = installDefaultMode(store);
		const compactHooks =
			mode === "compact" ? installCompactMode({ writeMetadata: store }) : undefined;
		try {
			const cwd = process.cwd();
			const tool = new ToolExecutionComponent(
				"edit",
				`summary-${mode}`,
				{ path: "sample.txt" },
				{},
				createEditToolDefinition(cwd),
				{ theme, requestRender() {}, setStatus() {} } as any,
				cwd,
			) as any;
			tool.updateResult({ content: [], details: { diff }, isError: false });
			const summary = plainLines(tool).filter(Boolean);
			assert.equal(summary.length, 2, "one title plus one result summary");
			assert.match(summary[0]!, /[Ee]dit sample\.txt/);
			assert.match(summary[1]!, /↳ \+1 -1 · .*to show more/);
			assert.doesNotMatch(summary.join("\n"), /OLD_CONTENT|NEW_CONTENT|Input|Output/);

			config.editDiffCollapsedLines = 24;
			compactHooks?.refresh();
			tool.invalidate();
			assert.match(plainLines(tool).join("\n"), /OLD_CONTENT/);
			config.editDiffCollapsedLines = 0;
			compactHooks?.refresh();
			tool.invalidate();
			assert.deepEqual(plainLines(tool).filter(Boolean), summary);

			tool.setExpanded(true);
			assert.match(plainLines(tool).join("\n"), /OLD_CONTENT/);
			assert.match(plainLines(tool).join("\n"), /NEW_CONTENT/);
			tool.setExpanded(false);
			assert.deepEqual(plainLines(tool).filter(Boolean), summary);

			assert.equal(
				buildMessageSummary({
					content: [
						{ type: "toolCall", name: "edit", arguments: { path: "sample.txt" } },
						{ type: "toolCall", name: "write", arguments: { path: "out.txt" } },
						{ type: "toolCall", name: "read", arguments: { path: "sample.txt" } },
					],
				}),
				"read×1",
				"edit/write remain outside the compact tool counts",
			);
			tool.updateResult({ content: [{ type: "text", text: "edit failed" }], isError: true });
			tool.invalidate();
			assert.match(plainLines(tool).join("\n"), /✗/);
			assert.doesNotMatch(plainLines(tool).join("\n"), /\+1 -1/);
		} finally {
			compactHooks?.shutdown();
			defaultHooks.shutdown();
			Object.assign(config, previousConfig);
			setMessageDisplayTheme(previousTheme);
		}
	});
}

test("the real edit summary remains an expandable mouse target through its inset wrapper", () => {
	let inputHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
	const toolCallId = "edit-summary-mouse";
	const result = insetComponent(
		renderEditDiffResult(
			{ diff },
			{ expanded: false, isHovered: () => isToolCallHovered(toolCallId) },
			summaryConfig,
			theme,
			"",
		),
	);
	const tool = {
		toolCallId,
		expanded: false,
		resultRendererComponent: result,
		setExpanded(value: boolean) {
			this.expanded = value;
		},
		invalidate() {
			result.invalidate();
		},
		render() {
			return ["✓ Edit sample.txt", ...result.render(100)];
		},
	};
	const tui = {
		terminal: { columns: 100, write() {} },
		children: [tool],
		previousLines: [] as string[],
		previousViewportTop: 0,
		handleInput() {},
		requestRender() {},
		doRender() {
			this.previousLines = tool.render();
		},
	};
	try {
		installToolMouseInteraction({
			mode: "tui",
			hasUI: true,
			ui: {
				setWidget(_key: string, factory: any) {
					if (typeof factory === "function") factory(tui, theme);
				},
				onTerminalInput(handler: typeof inputHandler) {
					inputHandler = handler;
					return () => undefined;
				},
			},
		});
		tui.doRender();
		assert.equal(tui.previousLines.length, 2);
		const row = tui.previousLines.findIndex((line) => line.includes(showMoreHintText()));
		assert.equal(row, 1);
		const column = tui.previousLines[row]!.indexOf("to show more") + 1;
		assert.ok(column > 0);
		inputHandler?.(`\x1b[<0;2;${row + 1}M`);
		assert.equal(tool.expanded, false, "the stats text is not the expand action");
		assert.deepEqual(inputHandler?.(`\x1b[<0;${column};${row + 1}M`), { consume: true });
		assert.equal(tool.expanded, true);
	} finally {
		installToolMouseInteraction({});
	}
});
