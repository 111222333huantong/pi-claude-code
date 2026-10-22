import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
	generateDiffString,
	initTheme,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { config, normalizeConfig } from "../extensions/config/config.ts";
import { installDefaultMode } from "../extensions/renderer/default-mode.ts";
import { shouldRenderRichDiff } from "../extensions/renderer/index.ts";
import { highlightDiffLine } from "../extensions/renderer/tool/diff/diff-highlight.ts";
import {
	CLAUDE_DIFF_PALETTE,
	resolveDiffPalette,
} from "../extensions/renderer/tool/diff/diff-palette.ts";
import {
	renderEditDiffResult,
	renderWriteDiffResult,
} from "../extensions/renderer/tool/diff/diff-renderer.ts";
import {
	buildStreamingWritePreview,
	STREAMING_WRITE_PREVIEW_LINES,
} from "../extensions/renderer/tool/diff/diff-write-render.ts";
import { isAbortedResultText } from "../extensions/renderer/tool/result.ts";

initTheme("dark");

import {
	DEFAULT_TOOL_DISPLAY_CONFIG,
	installWriteOverride,
	ownsWriteTool,
	renderRichToolResult,
	type ToolDisplayConfig,
	WriteExecutionMetadataStore,
} from "../extensions/renderer/tool/diff/index.ts";
import {
	executeWriteWithMetadata,
	MAX_COMPARABLE_WRITE_BYTES,
	MAX_WRITE_METADATA_ENTRIES,
} from "../extensions/renderer/tool/diff/write-execution.ts";
import { insetComponent } from "../extensions/renderer/tool/result.ts";

const theme = {
	fg(_color: string, text: string) {
		return text;
	},
	bg(_color: string, text: string) {
		return text;
	},
	bold(text: string) {
		return text;
	},
} as any;

function output(component: any, width = 100): string[] {
	return component.render(width);
}

test("rich diff routes only successful edit/write results in on mode", () => {
	for (const mode of ["on", "off"] as const) {
		assert.equal(shouldRenderRichDiff(mode, "edit", false), mode === "on");
		assert.equal(shouldRenderRichDiff(mode, "write", false), mode === "on");
		assert.equal(shouldRenderRichDiff(mode, "read", false), false);
		assert.equal(shouldRenderRichDiff(mode, "edit", true), false);
	}
});

test("edit rich diff is width-safe and honors collapsed/expanded limits", () => {
	const diff = ["@@ -1,40 +1,40 @@"];
	for (let index = 1; index <= 40; index++) {
		diff.push(`-${index}|old value ${index}`, `+${index}|new value ${index}`);
	}
	const store = new WriteExecutionMetadataStore();
	const collapsed = renderRichToolResult(
		"edit",
		{ details: { diff: diff.join("\n") }, content: [] },
		{ expanded: false },
		theme,
		{ args: { path: "sample.ts" } },
		store,
	);
	const collapsedLines = output(collapsed, 32);
	assert.ok(collapsedLines.some((line) => line.includes("more")));
	assert.ok(collapsedLines.every((line) => visibleWidth(line) <= 32));

	const expanded = renderRichToolResult(
		"edit",
		{ details: { diff: diff.join("\n") }, content: [] },
		{ expanded: true },
		theme,
		{ args: { path: "sample.ts" } },
		store,
	);
	assert.ok(output(expanded, 32).length > collapsedLines.length);
});

test("expanded long edit diff shows every line instead of a remainder hint", () => {
	const diff = ["@@ -1,80 +1,80 @@"];
	for (let index = 1; index <= 80; index++) {
		diff.push(`-${index}|old value ${index}`, `+${index}|new value ${index}`);
	}
	const render = (expanded: boolean) =>
		output(
			renderRichToolResult(
				"edit",
				{ details: { diff: diff.join("\n") }, content: [] },
				{ expanded },
				theme,
				{ args: { path: "sample.ts" } },
				new WriteExecutionMetadataStore(),
			),
			80,
		).map(stripVTControlCharacters);

	const collapsed = render(false);
	assert.ok(
		collapsed.some((line) => line.includes("more diff lines")),
		"collapsed body caps and keeps the remainder hint",
	);

	const expanded = render(true);
	assert.ok(
		expanded.some((line) => line.includes("old value 80")),
		"expanded body renders the whole diff",
	);
	assert.ok(
		!expanded.some((line) => line.includes("click to show more")),
		"expanded body has no remainder hint",
	);
});

test("collapsed diff declares only its remainder row as the expand entry", () => {
	const diff = ["@@ -1,30 +1,30 @@"];
	// 正文里出现与 remainder 同款的文案，不能变成展开入口。
	diff.push("+   ↳ 2 lines returned · click to show more");
	for (let index = 2; index <= 30; index++) diff.push(`+code line ${index}`);

	const collapsed: any = renderEditDiffResult(
		{ diff: diff.join("\n") },
		{ expanded: false },
		DEFAULT_TOOL_DISPLAY_CONFIG,
		theme,
		"",
	);
	const rows = (collapsed.render(90) as string[]).map(stripVTControlCharacters);
	const body = rows.find((line) => line.includes("2 lines returned"));
	const hint = rows.find((line) => line.includes("more diff lines"));
	assert.ok(body && hint, "collapsed body renders both rows");
	assert.equal(collapsed.isCollapsedHintLine(body), false, "body text is not the entry");
	assert.equal(collapsed.isCollapsedHintLine(hint), true, "remainder row is the entry");

	const expanded: any = renderEditDiffResult(
		{ diff: diff.join("\n") },
		{ expanded: true },
		DEFAULT_TOOL_DISPLAY_CONFIG,
		theme,
		"",
	);
	expanded.render(90);
	assert.equal(expanded.isCollapsedHintLine(hint), false, "expanded diff has no entry");
});

test("pi omissions use split number gutters and omit the terminal marker", () => {
	const diff = [
		"     ...",
		"  67           src = ./.;",
		"  68           # Non-vendored: go.mod/go.sum are the source of truth; a single",
		"  69           # vendorHash covers the whole fetched dependency set. It changes only",
		"  70           # when dependencies change.",
		"- 71           vendorHash = pkgs.lib.fakeHash;",
		'+ 71           vendorHash = "sha256-hf+aCbbDjGOHABCEvj2F7MbsZullpbdSqmkedd7sfIA=";',
		"  72 ",
		"  73           # CGO off -> a truly static binary on Linux. On Darwin, Go always links",
		"  74           # libSystem (Apple ships no fully-static binaries), so the aarch64-darwin",
		'  75           # artifact is self-contained except for libSystem. The "single static',
		"     ...",
	].join("\n");
	const component = renderEditDiffResult(
		{ diff },
		{ expanded: true, filePath: "flake.nix" },
		{ ...DEFAULT_TOOL_DISPLAY_CONFIG, diffViewMode: "split", diffIndicatorMode: "bars" },
		theme,
		"",
	);
	const rows = output(component, 180).map(stripVTControlCharacters);
	const omissionRows = rows.filter((row) => row.includes("⋮"));

	assert.equal(omissionRows.length, 1, "only the leading omission is useful");
	assert.equal(omissionRows[0]?.match(/⋮/g)?.length, 2, "both number gutters show the omission");
	assert.match(omissionRows[0] ?? "", /^\s*⋮\s*│\s*│\s*⋮\s*│/);
	assert.ok(
		rows.every((row) => !row.includes("...")),
		"raw omission text is not source content",
	);
	assert.equal(
		rows.findIndex((row) => /\b75\s*│/.test(row)),
		rows.length - 1,
		"the diff ends on the final real context row",
	);
	assert.ok(rows.every((row) => visibleWidth(row) <= 180));
});

test("pi omissions use the unified number gutter", () => {
	const before = Array.from({ length: 30 }, (_, index) => `line-${index + 1}`);
	const after = before.map((line, index) => (index === 10 ? `${line} changed` : line));
	const { diff } = generateDiffString(before.join("\n"), after.join("\n"));
	const component = renderEditDiffResult(
		{ diff },
		{ expanded: true, filePath: "sample.txt" },
		{ ...DEFAULT_TOOL_DISPLAY_CONFIG, diffViewMode: "unified", diffIndicatorMode: "bars" },
		theme,
		"",
	);
	const rows = output(component, 80).map(stripVTControlCharacters);
	const omissionRows = rows.filter((row) => row.includes("⋮"));

	assert.equal(omissionRows.length, 1, "the terminal omission is hidden");
	assert.match(omissionRows[0] ?? "", /^\s*⋮\s*│/);
	assert.ok(
		rows.every((row) => !row.includes("...")),
		"raw omission text is not rendered",
	);
});

test("pi intermediate omissions retain split number gutters", () => {
	const before = Array.from({ length: 40 }, (_, index) => `line-${index + 1}`);
	const after = before.map((line, index) =>
		index === 10 || index === 29 ? `${line} changed` : line,
	);
	const { diff } = generateDiffString(before.join("\n"), after.join("\n"));
	const component = renderEditDiffResult(
		{ diff },
		{ expanded: true, filePath: "sample.txt" },
		{ ...DEFAULT_TOOL_DISPLAY_CONFIG, diffViewMode: "split", diffIndicatorMode: "bars" },
		theme,
		"",
	);
	const rows = output(component, 140).map(stripVTControlCharacters);
	const omissionRows = rows.filter((row) => row.includes("⋮"));

	assert.equal(omissionRows.length, 2, "the leading and intermediate omissions remain visible");
	assert.ok(
		omissionRows.every((row) => row.match(/⋮/g)?.length === 2 && /^\s*⋮\s*│\s*│\s*⋮\s*│/.test(row)),
		"each omission stays inside both line-number gutters",
	);
	assert.ok(
		rows.every((row) => !row.includes("...")),
		"the terminal raw marker is omitted",
	);
});

test("edit/write collapsed diff hints switch from dim to white text on hover", () => {
	let hovered = false;
	const hoverTheme = {
		...theme,
		fg(color: string, text: string) {
			const code =
				color === "muted"
					? "\x1b[90m"
					: color === "dim"
						? "\x1b[94m"
						: color === "text"
							? "\x1b[97m"
							: "\x1b[37m";
			return `${code}${text}\x1b[39m`;
		},
	};
	const diff = [
		"@@ -1,40 +1,40 @@",
		...Array.from({ length: 40 }, (_, index) => ` ${index + 1}|const value${index} = ${index}`),
		"-41|const oldValue = 1",
		"+41|const oldValue = 2",
	].join("\n");
	const component = renderEditDiffResult(
		{ diff },
		{ expanded: false, filePath: "sample.ts", isHovered: () => hovered },
		{ ...DEFAULT_TOOL_DISPLAY_CONFIG, editDiffCollapsedLines: 2 },
		hoverTheme,
		"",
	);
	const hint = () => output(component).find((line) => line.includes("click to show more")) ?? "";
	assert.match(hint(), /\x1b\[94m/, "resting edit hint uses dim color");
	hovered = true;
	assert.match(hint(), /\x1b\[90m[^\n]*· [^\n]*\x1b\[39m\x1b\[97mclick to show more/);
	assert.doesNotMatch(hint(), /\x1b\[97m[^\n]*·/, "edit separator dot stays muted");

	hovered = false;
	const writeComponent = renderWriteDiffResult(
		Array.from({ length: 40 }, (_, index) => `const value${index} = ${index}`).join("\n"),
		{
			expanded: false,
			filePath: "sample.ts",
			fileExistedBeforeWrite: false,
			isHovered: () => hovered,
		},
		{ ...DEFAULT_TOOL_DISPLAY_CONFIG, editDiffCollapsedLines: 2, writeDiffCollapsedLines: 2 },
		hoverTheme,
		"",
	);
	const writeHint = () =>
		output(writeComponent).find((line) => line.includes("click to show more")) ?? "";
	assert.match(writeHint(), /\x1b\[94m/, "resting write hint uses dim color");
	hovered = true;
	assert.match(writeHint(), /\x1b\[90m[^\n]*· [^\n]*\x1b\[39m\x1b\[97mclick to show more/);
	assert.doesNotMatch(writeHint(), /\x1b\[97m[^\n]*·/, "write separator dot stays muted");
});

test("diff indicator mode live-updates on the same component via config getter", () => {
	// Panel changes must repaint existing tool rows without re-running the tool.
	let display: ToolDisplayConfig = {
		...DEFAULT_TOOL_DISPLAY_CONFIG,
		diffViewMode: "unified",
		diffIndicatorMode: "classic",
		editDiffCollapsedLines: 80,
	};
	const component = renderRichToolResult(
		"edit",
		{
			details: { diff: "@@ -1,1 +1,2 @@\n 1|same line\n+2|added line" },
			content: [],
		},
		{ expanded: true },
		theme,
		{ args: { path: "sample.ts" } },
		new WriteExecutionMetadataStore(),
		() => display,
	);
	assert.ok(component, "edit rich diff should render");

	const classicText = output(component, 80).join("\n");
	assert.match(classicText, /\+.*added line/, "classic mode uses +/- content markers");
	assert.doesNotMatch(
		classicText,
		/· \d+ hunks? · \d+ files?/,
		"unified headers omit redundant hunk and file counts",
	);

	display = { ...display, diffIndicatorMode: "bars" };
	const barsText = output(component, 80).join("\n");
	assert.match(barsText, /▌/, "bars mode uses vertical bar markers");
	assert.notEqual(barsText, classicText, "cache must miss when indicator mode changes");

	display = { ...display, diffIndicatorMode: "none" };
	const noneText = output(component, 80).join("\n");
	assert.doesNotMatch(noneText, /▌/);
	// none: no classic + before added content either (still may contain + in header stats).
	const bodyLines = noneText.split("\n").filter((line) => line.includes("added line"));
	assert.ok(bodyLines.length > 0);
	assert.ok(
		bodyLines.every((line) => !/^\s*\+/.test(line.replace(/^\s*\d+\s*/, ""))),
		"none mode should not prefix added body lines with +",
	);
});

test("split diff keeps the panel transparent while highlighting changed rows", () => {
	const panelBackground = "\x1b[48;2;1;2;3m";
	const ansiTheme = {
		...theme,
		getBgAnsi(color: string) {
			return color === "toolSuccessBg" ? panelBackground : undefined;
		},
	} as any;
	const rendered = renderRichToolResult(
		"edit",
		{
			details: { diff: "@@ -1,2 +1,2 @@\n 1|same\n-2|old\n+2|new" },
			content: [],
		},
		{ expanded: true },
		ansiTheme,
		{ args: { path: "sample.ts" } },
		new WriteExecutionMetadataStore(),
	);
	const text = output(rendered, 140).join("\n");
	assert.equal(text.includes(panelBackground), false);
	assert.match(text, /\x1b\[48;2;/);
});

test("final edit/write diff output removes terminal command injection", () => {
	const osc = "\x1b]52;c;OSC_PAYLOAD\x07";
	const dcs = "\x1bP1;2|DCS_PAYLOAD\x9c";
	const csi = "\x1b[2J";
	const edit = renderEditDiffResult(
		{
			diff: [
				`diff --git a/safe.ts b/safe${osc}.ts`,
				`--- a/safe.ts${dcs}`,
				"+++ b/safe.ts",
				`@@ -1 +1 @@${osc}`,
				`meta${dcs}`,
				`+1|const safe = 1;${csi}`,
			].join("\n"),
		},
		{ expanded: true, filePath: "safe.ts" },
		DEFAULT_TOOL_DISPLAY_CONFIG,
		theme,
		"",
	);
	const write = renderWriteDiffResult(
		`const safe = 1;${osc}${dcs}${csi}`,
		{ expanded: true, filePath: "safe.ts" },
		DEFAULT_TOOL_DISPLAY_CONFIG,
		theme,
		"",
	);
	const editFallback = renderEditDiffResult(
		{},
		{ expanded: true },
		DEFAULT_TOOL_DISPLAY_CONFIG,
		theme,
		`fallback${osc}${dcs}${csi}`,
	);
	const writeFallback = renderWriteDiffResult(
		undefined,
		{ expanded: true },
		DEFAULT_TOOL_DISPLAY_CONFIG,
		theme,
		`fallback${osc}${dcs}${csi}`,
	);

	for (const rendered of [edit, write, editFallback, writeFallback]) {
		const text = output(rendered).join("\n");
		assert.doesNotMatch(text, /OSC_PAYLOAD|DCS_PAYLOAD|\x1b\[2J|\x1b\]|\x1bP|[\x90\x9c\x9d]/);
	}
});

test("write create and overwrite render distinct rich diffs", () => {
	const store = new WriteExecutionMetadataStore();
	store.set("create", { fileExistedBeforeWrite: false });
	store.set("overwrite", { fileExistedBeforeWrite: true, previousContent: "old\n" });
	const create = renderRichToolResult(
		"write",
		{ content: [{ type: "text", text: "ok" }] },
		{ expanded: false },
		theme,
		{ toolCallId: "create", args: { path: "new.ts", content: "new\n" } },
		store,
	);
	const overwrite = renderRichToolResult(
		"write",
		{ content: [{ type: "text", text: "ok" }] },
		{ expanded: false },
		theme,
		{ toolCallId: "overwrite", args: { path: "old.ts", content: "new\n" } },
		store,
	);
	assert.match(output(create).join("\n"), /created/);
	assert.match(output(create).join("\n"), /more/);
	assert.doesNotMatch(
		output(create).join("\n"),
		/\n[^\n]*new[^\n]*$/,
		"collapsed create has no body",
	);
	const overwriteCollapsed = output(overwrite).join("\n");
	assert.match(overwriteCollapsed, /overwritten/);
	assert.match(overwriteCollapsed, /more/);
	assert.doesNotMatch(overwriteCollapsed, /\bold\b/, "collapsed overwrite has no body");

	const overwriteExpanded = renderRichToolResult(
		"write",
		{ content: [{ type: "text", text: "ok" }] },
		{ expanded: true },
		theme,
		{ toolCallId: "overwrite", args: { path: "old.ts", content: "new\n" } },
		store,
	);
	const overwriteText = output(overwriteExpanded).join("\n");
	assert.match(overwriteText, /overwritten/);
	assert.match(overwriteText, /old/);
	assert.match(overwriteText, /new/);
});

test("missing and unavailable write metadata never masquerade as create", () => {
	const store = new WriteExecutionMetadataStore();
	store.set("large", {
		fileExistedBeforeWrite: true,
		diffUnavailableReason: `previous file exceeds ${MAX_COMPARABLE_WRITE_BYTES} bytes`,
	});
	for (const toolCallId of ["missing", "large"]) {
		const rendered = renderRichToolResult(
			"write",
			{ content: [{ type: "text", text: "ok" }] },
			{},
			theme,
			{ toolCallId, args: { path: "file.ts", content: "new" } },
			store,
		);
		assert.match(output(rendered, 28).join("\n"), /diff unavailable/);
		assert.ok(output(rendered, 28).every((line) => visibleWidth(line) <= 28));
	}
});

test("write execution captures the 512000-byte boundary and degrades above it", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ccstyle-diff-"));
	const path = join(directory, "target.txt");
	const store = new WriteExecutionMetadataStore();
	try {
		await writeFile(path, "a".repeat(MAX_COMPARABLE_WRITE_BYTES));
		const result = await executeWriteWithMetadata(
			store,
			"boundary",
			{ path, content: "boundary replacement" },
			undefined,
			directory,
		);
		assert.equal(store.get("boundary")?.previousContent?.length, MAX_COMPARABLE_WRITE_BYTES);
		assert.equal(result.details, undefined);

		await writeFile(path, "b".repeat(MAX_COMPARABLE_WRITE_BYTES + 1));
		await executeWriteWithMetadata(
			store,
			"large",
			{ path, content: "large replacement" },
			undefined,
			directory,
		);
		assert.equal(store.get("large")?.fileExistedBeforeWrite, true);
		assert.match(store.get("large")?.diffUnavailableReason ?? "", /exceeds/);
		assert.equal(await readFile(path, "utf8"), "large replacement");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("write metadata is bounded, clearable, and failures do not retain entries", async () => {
	const store = new WriteExecutionMetadataStore();
	for (let index = 0; index <= MAX_WRITE_METADATA_ENTRIES; index++) {
		store.set(String(index), { fileExistedBeforeWrite: false });
	}
	assert.equal(store.entries.size, MAX_WRITE_METADATA_ENTRIES);
	assert.equal(store.get("0"), undefined);
	store.clear();
	assert.equal(store.entries.size, 0);

	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		executeWriteWithMetadata(
			store,
			"failed",
			{ path: join(tmpdir(), "never-written.txt"), content: "x" },
			controller.signal,
			tmpdir(),
		),
		/aborted/,
	);
	assert.equal(store.get("failed"), undefined);
});

test("a completed write reports UTF-8 bytes and keeps metadata after abort", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ccstyle-write-abort-"));
	const path = join(directory, "target.txt");
	const store = new WriteExecutionMetadataStore();
	let abortReads = 0;
	const signal = {
		get aborted() {
			abortReads++;
			return abortReads >= 4;
		},
	} as AbortSignal;
	try {
		await writeFile(path, "before");
		const result = await executeWriteWithMetadata(
			store,
			"completed",
			{ path, content: "你好" },
			signal,
			directory,
		);
		assert.equal(await readFile(path, "utf8"), "你好");
		assert.equal(store.get("completed")?.previousContent, "before");
		assert.match(result.content[0]?.text ?? "", /6 bytes/);
		assert.equal(abortReads, 3);

		const empty = await executeWriteWithMetadata(
			store,
			"empty",
			{ path, content: "" },
			undefined,
			directory,
		);
		const ascii = await executeWriteWithMetadata(
			store,
			"ascii",
			{ path, content: "ab" },
			undefined,
			directory,
		);
		assert.match(empty.content[0]?.text ?? "", /0 bytes/);
		assert.match(ascii.content[0]?.text ?? "", /2 bytes/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("writeDiffCollapsedLines 0 shows stats only until expanded", () => {
	const lines = Array.from({ length: 40 }, (_, index) => `const value${index} = ${index}`).join(
		"\n",
	);
	const store = new WriteExecutionMetadataStore();
	store.set("write", { fileExistedBeforeWrite: false });
	const display: ToolDisplayConfig = {
		...DEFAULT_TOOL_DISPLAY_CONFIG,
		writeDiffCollapsedLines: 0,
	};
	const collapsed = renderRichToolResult(
		"write",
		{ content: [{ type: "text", text: "ok" }] },
		{ expanded: false },
		theme,
		{ toolCallId: "write", args: { path: "new.ts", content: lines } },
		store,
		() => display,
	);
	const collapsedText = stripVTControlCharacters(output(collapsed).join("\n"));
	assert.match(collapsedText, /created/);
	assert.match(collapsedText, /more/);
	assert.doesNotMatch(collapsedText, /const value/);
	assert.match(collapsedText, /\+40 -0/, "0 行折叠时计数由正文行显示（上游 1.0 口径）");

	const expanded = renderRichToolResult(
		"write",
		{ content: [{ type: "text", text: "ok" }] },
		{ expanded: true },
		theme,
		{ toolCallId: "write", args: { path: "new.ts", content: lines } },
		store,
		() => display,
	);
	const expandedText = stripVTControlCharacters(output(expanded).join("\n"));
	assert.match(expandedText, /const value0 = 0/);
	assert.match(expandedText, /const value1 = 1/);
});

test("default-mode write collapsed uses title stats and created hint", () => {
	const previousMode = config.mode;
	const store = new WriteExecutionMetadataStore();
	config.mode = "on";
	const hooks = installDefaultMode(store);
	try {
		const write = new ToolExecutionComponent(
			"write",
			"w-default",
			{ path: "out.ts", content: "hi\n" },
			{},
			undefined,
			{ theme, requestRender() {}, setStatus() {} } as any,
			process.cwd(),
		) as any;
		store.set("w-default", { fileExistedBeforeWrite: false });
		write.updateResult({ content: [{ type: "text", text: "ok" }], isError: false });
		const text = output(write, 120)
			.join("\n")
			.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
		// 折叠 0 行预览时计数在正文那行，标题不重复。
		assert.doesNotMatch(text, /Write out\.ts \(\+\d+ -\d+\)/);
		assert.match(text, /↳ diff \+1 -0 · created · click to show more/);
		assert.doesNotMatch(text, /▌/);
	} finally {
		config.mode = previousMode;
		hooks.shutdown();
	}
});

test("normalizeConfig defaults writeDiffCollapsedLines to 0 and allows explicit values", () => {
	assert.equal(normalizeConfig({}).writeDiffCollapsedLines, 0);
	assert.equal(normalizeConfig({ writeDiffCollapsedLines: 0 }).writeDiffCollapsedLines, 0);
	assert.equal(normalizeConfig({ writeDiffCollapsedLines: 12 }).writeDiffCollapsedLines, 12);
	assert.equal(normalizeConfig({ editDiffCollapsedLines: 48 }).writeDiffCollapsedLines, 0);
	assert.equal(normalizeConfig({ writeDiffCollapsedLines: -3 }).writeDiffCollapsedLines, 0);
});

test("third-party write ownership prevents registration", () => {
	const registered: unknown[] = [];
	installWriteOverride({
		getAllTools() {
			return [{ name: "write", sourceInfo: { source: "extension", path: "other.ts" } }];
		},
		registerTool(tool: unknown) {
			registered.push(tool);
		},
	} as any);
	assert.deepEqual(registered, []);
});

test("isAbortedResultText 只认运行时中断文案", () => {
	assert.equal(isAbortedResultText("This operation was aborted"), true);
	assert.equal(isAbortedResultText("Request was aborted"), true);
	assert.equal(isAbortedResultText("aborted by user"), true);
	assert.equal(isAbortedResultText("Error: boom"), false);
	assert.equal(isAbortedResultText(""), false);
});

test("default-mode 中断的工具结果收敛为 dim 的 Operation aborted", () => {
	const previousMode = config.mode;
	const store = new WriteExecutionMetadataStore();
	config.mode = "on";
	const hooks = installDefaultMode(store);
	const renderAborted = () => {
		const tool = new ToolExecutionComponent(
			"get_subagent_result",
			"g-abort",
			{ agent_id: "5d44e2c1-f01c-406" },
			{},
			undefined,
			{ theme, requestRender() {}, setStatus() {} } as any,
			process.cwd(),
		) as any;
		tool.updateResult({
			content: [{ type: "text", text: "This operation was aborted" }],
			isError: true,
		});
		return output(tool, 120).join("\n");
	};
	const renderFailed = () => {
		const tool = new ToolExecutionComponent(
			"read",
			"g-failed",
			{ path: "a.ts" },
			{},
			undefined,
			{ theme, requestRender() {}, setStatus() {} } as any,
			process.cwd(),
		) as any;
		tool.updateResult({
			content: [{ type: "text", text: "Error: boom" }],
			isError: true,
		});
		return output(tool, 120).join("\n");
	};
	try {
		const strip = (s: string) => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
		const aborted = renderAborted();
		assert.match(strip(aborted), /↳ Operation aborted/);
		assert.doesNotMatch(strip(aborted), /This operation was aborted/);
		// 中断行不再走 error 红：与普通失败行的着色必须不同。
		const failed = renderFailed();
		const abortedDetail = aborted.split("\n").find((line) => strip(line).includes("↳")) ?? "";
		const failedDetail = failed.split("\n").find((line) => strip(line).includes("↳")) ?? "";
		const sgr = (line: string) => line.match(/^\x1b\[[0-9;]+m/)?.[0] ?? "";
		assert.ok(failedDetail.includes("Error: boom"));
		assert.notEqual(sgr(abortedDetail), sgr(failedDetail));
	} finally {
		config.mode = previousMode;
		hooks.shutdown();
	}
});

test("流式头预览：头部钉死 6 行 + more 计数 + 空回落", () => {
	const content = Array.from({ length: 8 }, (_, i) => `l${i + 1}`).join("\n");
	const preview = buildStreamingWritePreview(content, 100, theme, "", "   ↳");
	assert.ok(preview);
	assert.equal(preview.head, "   ↳ Writing 8 lines…");
	// 头部钉死：前 6 行 + more 尾，只往下长不重写。
	assert.equal(preview.rows.length, STREAMING_WRITE_PREVIEW_LINES + 1);
	assert.equal(preview.rows[0], "▌  1 │ l1");
	assert.ok(preview.rows[5]?.includes("l6"));
	assert.ok(preview.rows[6]?.includes("+2 more lines"));
	assert.ok(!preview.rows.some((row) => row.includes("l7")));
	for (const row of [preview.head, ...preview.rows]) {
		assert.ok(visibleWidth(row) <= 100);
	}
	// timing 透传。
	const timed = buildStreamingWritePreview(content, 100, theme, " · 2s", "↳ ");
	assert.ok(timed?.head.endsWith("lines… · 2s"));
	// 空内容/零宽回落 Pending（返回 undefined）。
	assert.equal(buildStreamingWritePreview("", 100, theme, "", "   ↳"), undefined);
	assert.equal(buildStreamingWritePreview("   \n  ", 100, theme, "", "   ↳"), undefined);
	assert.equal(buildStreamingWritePreview(content, 0, theme, "", "   ↳"), undefined);
	// 短内容无 more 尾。
	const short = buildStreamingWritePreview("a\nb", 100, theme, "", "   ↳");
	assert.ok(short && short.rows.length === 2);
});

test("insetComponent strictly clamps lines within given width even with arrow markers", () => {
	const warningTheme = {
		fg(_color: string, text: string) {
			return `\x1b[33m${text}\x1b[39m`;
		},
	};
	const dummyComponent = {
		render(width: number) {
			return [
				truncateToWidth(
					warningTheme.fg("warning", "↳ diff unavailable: execution metadata is unavailable"),
					Math.max(0, width),
					"",
				),
				"x".repeat(width),
			];
		},
	};

	const wrapped = insetComponent(dummyComponent);

	for (const width of [10, 20, 41, 60, 80]) {
		const lines = wrapped.render(width);
		for (const line of lines) {
			assert.ok(
				visibleWidth(line) <= width,
				`Rendered line exceeds terminal width: ${visibleWidth(line)} > ${width} (line: "${line}")`,
			);
		}
		assert.equal(visibleWidth(lines[1]), width, "non-arrow body keeps the full width after indent");
	}
});

/** 内置 write 归还所有权，避免影响后续用例。 */
function restoreBuiltinWriteOwnership(): void {
	installWriteOverride({
		getAllTools: () => [
			{ name: "write", sourceInfo: { source: "builtin", path: "<builtin:write>" } },
		],
		registerTool: () => {},
	} as any);
}

test("external write owner disables rich diff instead of degrading every card", () => {
	const registered: unknown[] = [];
	const notices: string[] = [];
	const store = new WriteExecutionMetadataStore();
	try {
		installWriteOverride(
			{
				getAllTools: () => [
					{ name: "write", sourceInfo: { source: "extension", path: "sol-pi/action-fusion" } },
				],
				registerTool: (tool: unknown) => registered.push(tool),
			} as any,
			store,
			(owner) => notices.push(owner.path),
		);

		assert.deepEqual(registered, [], "让位后不再注册 write");
		assert.equal(ownsWriteTool(), false);
		assert.equal(
			renderRichToolResult(
				"write",
				{ content: [] },
				{},
				theme,
				{ args: { path: "a.ts" }, toolCallId: "w-external" },
				store,
			),
			undefined,
			"让位后交回普通结果行，不再输出 unavailable 卡片",
		);
		assert.deepEqual(notices, ["sol-pi/action-fusion"], "提示冲突来源");
	} finally {
		restoreBuiltinWriteOwnership();
	}

	assert.equal(ownsWriteTool(), true, "内置 write 恢复后继续提供富 diff");
	// 恢复后缺元数据仍是 ccstyle 自己的降级提示（真异常，不是冲突）。
	assert.notEqual(
		renderRichToolResult(
			"write",
			{ content: [] },
			{},
			theme,
			{ args: { path: "a.ts" }, toolCallId: "w-restored" },
			store,
		),
		undefined,
	);
});

test("claude palette returns exact CC backgrounds and skips removed-line highlight", () => {
	const previous = config.diffPalette;
	const theme: any = { fg: (_c: string, t: string) => t };
	const removeEntry: any = { lineKind: "remove", content: "const x = 1;" };
	const addEntry: any = { lineKind: "add", content: "const x = 1;" };
	const fakeHighlighter = (code: string) => `SHIKI${code}`;
	try {
		config.diffPalette = "claude";
		assert.equal(CLAUDE_DIFF_PALETTE.removeRowBgAnsi, "\x1b[48;2;61;1;0m");
		assert.equal(CLAUDE_DIFF_PALETTE.removeEmphasisBgAnsi, "\x1b[48;2;92;2;0m");
		assert.equal(CLAUDE_DIFF_PALETTE.addRowBgAnsi, "\x1b[48;2;2;40;0m");
		assert.equal(CLAUDE_DIFF_PALETTE.addEmphasisBgAnsi, "\x1b[48;2;4;71;0m");
		assert.deepEqual(resolveDiffPalette(theme), CLAUDE_DIFF_PALETTE);
		// 删行跳过 shiki，只留原文 + 行底色。
		const out = highlightDiffLine(
			"const x = 1;",
			removeEntry,
			new WeakMap(),
			CLAUDE_DIFF_PALETTE,
			fakeHighlighter,
			undefined,
		);
		assert.ok(!out.highlighted.includes("SHIKI"), "删行无语法高亮");
		assert.ok(out.highlighted.includes("const x = 1;"));
		const added = highlightDiffLine(
			"const x = 1;",
			addEntry,
			new WeakMap(),
			CLAUDE_DIFF_PALETTE,
			fakeHighlighter,
			undefined,
		);
		assert.ok(added.highlighted.includes("SHIKI"), "加行仍高亮");
		// theme 档不受影响。
		config.diffPalette = "theme";
		assert.notDeepEqual(resolveDiffPalette(theme), CLAUDE_DIFF_PALETTE);
	} finally {
		config.diffPalette = previous;
	}
});
