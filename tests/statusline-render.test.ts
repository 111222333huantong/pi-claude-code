import assert from "node:assert/strict";
import test from "node:test";
import {
	buildLine1,
	buildLine2,
	buildLines,
	ctxBar,
	ctxBarCells,
	ctxColor,
	fitSegments,
	formatCost,
	formatTokens,
	SINGLE_LINE_MAX_WIDTH,
	type StatusSnapshot,
	thinkingColor,
} from "../extensions/feature/statusline/render.ts";

/** paint 透传：断言纯文本布局。 */
const identity = (_color: string, text: string) => text;

const base: StatusSnapshot = {
	model: "opus-4-6",
	thinking: "high",
	cwd: "~/pi-claude-code",
	ctxPct: 23.4,
	ctxTokens: 46000,
	ctxWindow: 200000,
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
	pr: null,
	worktree: null,
	showWorktree: true,
};

test("formatTokens: 与 working-message 同口径", () => {
	assert.equal(formatTokens(18), "18");
	assert.equal(formatTokens(1400), "1.4k");
	assert.equal(formatTokens(12000), "12k");
	assert.equal(formatTokens(46000), "46k");
});

test("formatCost: 两位小数", () => {
	assert.equal(formatCost(1.23), "$1.23");
	assert.equal(formatCost(12.8), "$12.80");
});

test("ctxColor: 70/90 两档阈值", () => {
	assert.equal(ctxColor(null), "dim");
	assert.equal(ctxColor(23), "dim");
	assert.equal(ctxColor(70), "warning");
	assert.equal(ctxColor(90), "error");
});

test("thinkingColor: 未知等级回 dim", () => {
	assert.equal(thinkingColor("high"), "thinkingHigh");
	assert.equal(thinkingColor("max"), "thinkingMax");
	assert.equal(thinkingColor("turbo"), "dim");
});

test("buildLine1: 宽屏全段", () => {
	assert.equal(
		buildLine1(base, 140, identity),
		"opus-4-6 (high) │ ctx ██░░░░░░ 23% · 46k/200k │ $1.23 │ mcp 3 enabled │ ext 7 on",
	);
});

test("buildLine1: cost 为 0 整段隐藏", () => {
	const line = buildLine1({ ...base, cost: 0 }, 120, identity);
	assert.equal(line.includes("$"), false);
	assert.equal(line.includes("mcp 3 enabled"), true);
});

test("buildLine1: ctx 90+ 加 !! 标记", () => {
	const line = buildLine1({ ...base, ctxPct: 91.2, ctxTokens: 182000 }, 140, identity);
	assert.equal(line.includes("!! ctx ███████░ 91% · 182k/200k !!"), true);
});

test("buildLine1: ctx 未知显示空条 + ctx —", () => {
	const line = buildLine1({ ...base, ctxPct: null, ctxTokens: null }, 120, identity);
	assert.equal(line.includes("ctx ░░░░░░░░ —"), true);
});

test("buildLine1: 窄屏按优先级砍 ext→mcp→cost，ctx 永存", () => {
	const line = buildLine1(base, 40, identity);
	assert.match(line, /ctx .*23%/);
	assert.equal(line.includes("ext"), false);
	assert.equal(line.includes("mcp"), false);
});

test("buildLine2: 脏仓库 diffstat（无 !! 标记）", () => {
	assert.equal(buildLine2(base, 120, identity), "~/pi-claude-code │ feat/statusline ↑2 +18 -5");
});

test("buildLine2: 干净仓库 ok", () => {
	const line = buildLine2(
		{ ...base, changedFiles: 0, ahead: 0, behind: 0, insertions: 0, deletions: 0 },
		120,
		identity,
	);
	assert.equal(line, "~/pi-claude-code │ feat/statusline ok");
});

test("buildLine2: 非仓库只有 cwd", () => {
	const line = buildLine2({ ...base, branch: null }, 120, identity);
	assert.equal(line, "~/pi-claude-code");
});
test("buildLine2: worktree 段与开关", () => {
	const on = buildLine2({ ...base, worktree: "pi-cc-refs" }, 120, identity);
	assert.equal(on.includes("wt pi-cc-refs"), true);
	const off = buildLine2({ ...base, worktree: "pi-cc-refs", showWorktree: false }, 120, identity);
	assert.equal(off.includes("wt"), false);
});

test("buildLine2: 冲突文件显式 ⚠N，无冲突不显示", () => {
	const conflicted = buildLine2({ ...base, hasConflicts: true, conflictFiles: 2 }, 120, identity);
	assert.equal(conflicted.includes("⚠2"), true);
	const clean = buildLine2(base, 120, identity);
	assert.equal(clean.includes("⚠"), false);
});

test("buildLine2: 有 PR 显示 PR #N，无则省略", () => {
	const withPr = buildLine2({ ...base, pr: 12 }, 120, identity);
	assert.equal(withPr.includes("PR #12"), true);
	const withoutPr = buildLine2(base, 120, identity);
	assert.equal(withoutPr.includes("PR #"), false);
});

test("fitSegments: 空段过滤，超宽逐个剔最低", () => {
	assert.equal(
		fitSegments(
			[
				{ plain: "a", painted: "a", priority: 10 },
				{ plain: "", painted: "", priority: 99 },
				{ plain: "b", painted: "b", priority: 5 },
			],
			1,
		),
		"a",
	);
});

test("fitSegments: short 变体先于剔除，shrinkPriority 小的先降级", () => {
	const segments = [
		{
			plain: "hello world",
			painted: "hello world",
			priority: 10,
			shortPlain: "hi",
			shortPainted: "hi",
			shrinkPriority: 20,
		},
		{
			plain: "abcdef",
			painted: "abcdef",
			priority: 5,
			shortPlain: "ab",
			shortPainted: "ab",
			shrinkPriority: 10,
		},
	];
	// 全形 20 列超 8 → 先降 shrinkPriority 小的 abcdef→ab（16 仍超）→
	// 再降 hello world→hi：`hi │ ab` = 7 ≤ 8。
	assert.equal(fitSegments(segments, 8), "hi │ ab");
	// 短形仍超才进剔除阶段：先丢低优先级的 ab。
	assert.equal(fitSegments(segments, 6), "hi");
	assert.equal(fitSegments(segments, 1), "");
	// 短形为空串的段在降级时直接消失（不再占分隔列）。
	const vanish = [
		{
			plain: "keep",
			painted: "keep",
			priority: 9,
			shortPlain: "k",
			shortPainted: "k",
			shrinkPriority: 20,
		},
		{
			plain: "gone",
			painted: "gone",
			priority: 1,
			shortPlain: "",
			shortPainted: "",
			shrinkPriority: 5,
		},
	];
	assert.equal(fitSegments(vanish, 6), "keep");
	assert.equal(fitSegments(vanish, 3), "k");
});

test("ctxBar: 8 格填充，边界钳制", () => {
	assert.equal(ctxBar(0), "░░░░░░░░");
	assert.equal(ctxBar(100), "████████");
	assert.equal(ctxBar(25), "██░░░░░░");
	assert.equal(ctxBar(null), "░░░░░░░░");
	assert.equal(ctxBar(150), "████████");
	assert.equal(ctxBar(-5), "░░░░░░░░");
});

test("ctxBarCells: 填充/空槽格数供分 tone 着色", () => {
	assert.deepEqual(ctxBarCells(75), { filled: 6, empty: 2 });
	assert.deepEqual(ctxBarCells(null), { filled: 0, empty: 8 });
});

/** 记录每次 paint 的 (color, text) 对，供断言着色分布。 */
function recordingPaint(log: Array<[string, string]>) {
	return (color: string, text: string): string => {
		log.push([color, text]);
		return text;
	};
}

test("buildLine1: 进度条填充段分 tone，空槽恒 dim", () => {
	const log: Array<[string, string]> = [];
	buildLine1({ ...base, ctxPct: 75 }, 140, recordingPaint(log));
	const filled = log.filter(([_color, text]) => text.includes("█"));
	const empty = log.filter(([_color, text]) => text.includes("░"));
	assert.ok(
		filled.length > 0 && filled.every(([color]) => color === "warning"),
		"75%% 填充 warning",
	);
	assert.ok(empty.length > 0 && empty.every(([color]) => color === "dim"), "空槽 dim");

	const dangerLog: Array<[string, string]> = [];
	buildLine1({ ...base, ctxPct: 95 }, 140, recordingPaint(dangerLog));
	assert.ok(
		dangerLog.filter(([_color, text]) => text.includes("█")).every(([color]) => color === "error"),
		"95%% 填充 error",
	);
	assert.ok(
		dangerLog.some(([color, text]) => color === "error" && text === "!! "),
		"危险标记独立 error 色",
	);
});

test("buildLine1: 宽度不够时先降级为短形再剔除（两级降级）", () => {
	// 全形 81 列放不下 → 逐段 shrink 后 51 列：模型丢 thinking、ctx 丢 used/window，
	// 但 mcp/ext/cost 全部保留（旧逻辑在此宽度会整段剔掉它们）。
	const line = buildLine1(base, 55, identity);
	assert.ok(line.includes("opus-4-6"), `model kept, got: ${line}`);
	assert.ok(!line.includes("(high)"), `thinking shrunk away, got: ${line}`);
	assert.ok(line.includes("mcp 3"), `mcp short kept, got: ${line}`);
	assert.ok(line.includes("ext 7"), `ext short kept, got: ${line}`);
	assert.ok(line.includes("23%"), `ctx short kept, got: ${line}`);

	// 短形仍放不下 → 进入剔除阶段（先丢 ext、mcp），ctx 永存。
	const narrow = buildLine1(base, 40, identity);
	assert.ok(/ctx .*23%/.test(narrow), `ctx survives, got: ${narrow}`);
	assert.ok(!narrow.includes("ext"), `ext dropped last-resort, got: ${narrow}`);
	assert.ok(!narrow.includes("mcp"), `mcp dropped last-resort, got: ${narrow}`);
});

test("buildLine2: 窄屏先丢 diffstat 短形，再考虑剔除", () => {
	const line = buildLine2(base, 40, identity);
	assert.ok(line.includes("~/pi-claude-code"), `cwd kept, got: ${line}`);
	assert.ok(line.includes("feat/statusline"), `branch kept, got: ${line}`);
	assert.ok(!line.includes("+18"), `diffstat shrunk first, got: ${line}`);
});

test("buildLine2: cwd 超 3 段时短形保末两段", () => {
	const deep = buildLine2({ ...base, cwd: "/a/b/c/d/e" }, 46, identity);
	assert.ok(deep.includes("…/d/e") || deep.includes("/a/b/c/d/e"), `got: ${deep}`);
});

test("buildLines: 宽屏两行，窄屏塌单行", () => {
	assert.equal(SINGLE_LINE_MAX_WIDTH, 60);
	assert.equal(buildLines(base, 120, identity).length, 2);
	const narrow = buildLines(base, 50, identity);
	assert.equal(narrow.length, 1);
	assert.ok(narrow[0]?.includes("opus-4-6"), `keep model, got: ${narrow[0]}`);
	assert.ok(narrow[0]?.includes("ctx"), `keep ctx, got: ${narrow[0]}`);
	assert.ok(
		(narrow[0] ? [...narrow[0]].length : 0) <= 60,
		`single line must fit, got ${narrow[0]?.length} cols`,
	);
});
