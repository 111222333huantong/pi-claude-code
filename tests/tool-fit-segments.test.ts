import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { config } from "../extensions/config/config.ts";
import { installDefaultMode } from "../extensions/renderer/default-mode.ts";
import { WriteExecutionMetadataStore } from "../extensions/renderer/tool/diff/write-execution.ts";
import { clearAllAnimations } from "../extensions/renderer/tool/tool-state.ts";
import { stripAnsi } from "../extensions/utils/ansi-text.ts";
import { fitSegmentsByPriority, truncateSegmentEnd } from "../extensions/utils/fit-segments.ts";

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

test("truncateSegmentEnd keeps the head with CJK widths", () => {
	assert.equal(truncateSegmentEnd("hello world", 20), "hello world");
	assert.equal(truncateSegmentEnd("hello world", 5), "hell…");
	assert.equal(truncateSegmentEnd("中文测试文本", 5), "中文…");
	assert.equal(truncateSegmentEnd("abc", 0), "");
});

test("fitSegmentsByPriority keeps everything when it fits", () => {
	assert.deepEqual(
		fitSegmentsByPriority(
			[
				{ text: "Bash npm test", priority: 2 },
				{ text: " (2 args)", priority: 1 },
			],
			100,
			"…",
			0,
		),
		["Bash npm test", " (2 args)"],
	);
});

test("fitSegmentsByPriority compacts low priority first", () => {
	assert.deepEqual(
		fitSegmentsByPriority(
			[
				{ text: "Bash npm test", priority: 2 },
				{ text: " (2 args)", priority: 1, compactText: "" },
			],
			13,
			"…",
			0,
		),
		["Bash npm test"],
	);
});

test("fitSegmentsByPriority truncates the lowest survivor with custom rules", () => {
	const seen: string[] = [];
	assert.deepEqual(
		fitSegmentsByPriority(
			[
				{
					text: "averylongcommandname",
					priority: 2,
					truncate: (text, budget) => {
						seen.push(`${text}:${budget}`);
						return truncateSegmentEnd(text, budget);
					},
				},
			],
			10,
			"…",
			0,
		),
		["averylong…"],
	);
	assert.deepEqual(seen, ["averylongcommandname:10"]);
});

test("fitSegmentsByPriority drops everything at zero width", () => {
	assert.deepEqual(fitSegmentsByPriority([{ text: "abc", priority: 1 }], 0, "…", 0), []);
});

test("fitSegmentsByPriority honors separator width", () => {
	// space-joined: "ab cd" is 5 wide, fits 5 but not 4.
	assert.deepEqual(
		fitSegmentsByPriority(
			[
				{ text: "ab", priority: 2 },
				{ text: "cd", priority: 1, compactText: "" },
			],
			5,
		),
		["ab", "cd"],
	);
	assert.deepEqual(
		fitSegmentsByPriority(
			[
				{ text: "ab", priority: 2 },
				{ text: "cd", priority: 1, compactText: "" },
			],
			4,
		),
		["ab"],
	);
});

function titleOf(tool: any, width: number): string {
	const line =
		tool
			.render(width)
			.map(stripAnsi)
			.find((line: string) => line.includes("Read") || line.includes("Bash")) ?? "";
	return line;
}

test("title degrades in three tiers: full, detail dropped, main truncated", () => {
	const previousMode = config.mode;
	config.mode = "on";
	const hooks = installDefaultMode(new WriteExecutionMetadataStore());
	try {
		const read = new ToolExecutionComponent(
			"read",
			"p3-read",
			{ path: "src/components/App.ts", offset: 10, limit: 50 },
			{},
			undefined,
			ui,
			process.cwd(),
		) as any;
		const wide = titleOf(read, 160);
		assert.match(wide, /offset=10/);
		const narrow = titleOf(read, 60);
		// detail 让路：offset 后缀消失，路径主体保留。
		assert.doesNotMatch(narrow, /offset=10/);
		assert.match(narrow, /App\.ts/);
		assert.ok(visibleWidth(narrow) <= 48, `narrow title fits 80% viewport: ${narrow}`);
		const extreme = titleOf(read, 30);
		assert.match(extreme, /App\.ts|…/);
		assert.ok(visibleWidth(extreme) <= 24, `extreme title fits 80% viewport: ${extreme}`);
	} finally {
		config.mode = previousMode;
		clearAllAnimations();
		hooks.shutdown();
	}
});

test("running title keeps the command over the live suffix when narrow", () => {
	const previousMode = config.mode;
	config.mode = "on";
	const hooks = installDefaultMode(new WriteExecutionMetadataStore());
	try {
		const bash = new ToolExecutionComponent(
			"bash",
			"p3-bash",
			{ command: "npm run build --workspace app" },
			{},
			undefined,
			ui,
			process.cwd(),
		) as any;
		bash.markExecutionStarted();
		bash.updateResult({ content: [{ type: "text", text: "a\nb\nc" }], isError: false }, true);
		bash.updateDisplay();
		const wide = titleOf(bash, 160);
		assert.match(wide, /npm run build/);
		assert.match(wide, /3 lines/);
		const narrow = titleOf(bash, 56);
		assert.match(narrow, /npm run build/, "command survives narrowing");
		assert.ok(visibleWidth(narrow) <= 45, `narrow running title fits: ${narrow}`);
	} finally {
		config.mode = previousMode;
		clearAllAnimations();
		hooks.shutdown();
	}
});
