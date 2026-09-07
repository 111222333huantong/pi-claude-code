import assert from "node:assert/strict";
import test from "node:test";
import {
	buildLine1,
	buildLine2,
	ctxColor,
	fitSegments,
	formatCost,
	formatTokens,
	thinkingColor,
	type StatusSnapshot,
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
	ahead: 2,
	behind: 0,
	insertions: 18,
	deletions: 5,
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
		buildLine1(base, 120, identity),
		"opus-4-6 (high) │ ctx 23% · 46k/200k │ $1.23 │ mcp 3 enabled │ ext 7 on",
	);
});

test("buildLine1: cost 为 0 整段隐藏", () => {
	const line = buildLine1({ ...base, cost: 0 }, 120, identity);
	assert.equal(line.includes("$"), false);
	assert.equal(line.includes("mcp 3 enabled"), true);
});

test("buildLine1: ctx 90+ 加 !! 标记", () => {
	const line = buildLine1({ ...base, ctxPct: 91.2, ctxTokens: 182000 }, 120, identity);
	assert.equal(line.includes("!! ctx 91% · 182k/200k !!"), true);
});

test("buildLine1: ctx 未知显示 ctx —", () => {
	const line = buildLine1({ ...base, ctxPct: null, ctxTokens: null }, 120, identity);
	assert.equal(line.includes("ctx —"), true);
});

test("buildLine1: 窄屏按优先级砍 ext→mcp→cost，ctx 永存", () => {
	const line = buildLine1(base, 40, identity);
	assert.equal(line.includes("ctx 23%"), true);
	assert.equal(line.includes("ext"), false);
	assert.equal(line.includes("mcp"), false);
});

test("buildLine2: 脏仓库 !! + diffstat", () => {
	assert.equal(
		buildLine2(base, 120, identity),
		"~/pi-claude-code │ feat/statusline !! ↑2 +18 -5",
	);
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
