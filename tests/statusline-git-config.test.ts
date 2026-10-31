import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	readStatuslineConfig,
	writeStatuslineConfig,
} from "../extensions/feature/statusline/config.ts";
import {
	collectGitStatus,
	type GitSnapshot,
	parsePorcelainFiles,
	parsePorcelainHead,
	parseShortstat,
	parseWorktree,
	startGitPoller,
} from "../extensions/feature/statusline/git.ts";
import { normalizeMcpStatus } from "../extensions/feature/statusline/index.ts";
import { _resetPrCache, getPrNumber, parsePrNumber } from "../extensions/feature/statusline/pr.ts";

test("parsePorcelainHead: 分支与上下游", () => {
	assert.deepEqual(parsePorcelainHead("## main...origin/main"), {
		branch: "main",
		ahead: null,
		behind: null,
	});
	assert.deepEqual(parsePorcelainHead("## feat/x...origin/feat/x [ahead 2, behind 1]"), {
		branch: "feat/x",
		ahead: 2,
		behind: 1,
	});
});

test("parsePorcelainHead: detached 与无提交", () => {
	assert.equal(parsePorcelainHead("## HEAD (no branch)").branch, "HEAD (no branch)");
	assert.equal(parsePorcelainHead("## No commits yet on main").branch, "main");
});

test("parsePorcelainFiles: 计数 ?? 与冲突", () => {
	assert.deepEqual(parsePorcelainFiles([" M a.ts", "A  b.ts", "?? c.ts", "", "UU d.ts"]), {
		changedFiles: 4,
		hasConflicts: true,
		conflictFiles: 1,
	});
	assert.deepEqual(parsePorcelainFiles([]), {
		changedFiles: 0,
		hasConflicts: false,
		conflictFiles: 0,
	});
});

test("parseShortstat: 插入删除", () => {
	assert.deepEqual(parseShortstat(" 2 files changed, 18 insertions(+), 5 deletions(-)"), {
		insertions: 18,
		deletions: 5,
	});
	assert.deepEqual(parseShortstat(" 1 file changed, 1 insertion(+)"), {
		insertions: 1,
		deletions: 0,
	});
	assert.deepEqual(parseShortstat(""), { insertions: 0, deletions: 0 });
});

test("collectGitStatus: staged 改动计入 diffstat", async () => {
	const dir = mkdtempSync(join(tmpdir(), "statusline-staged-"));
	execFileSync("git", ["init", "-b", "main"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "test@test"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
	writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
	execFileSync("git", ["add", "."], { cwd: dir });
	execFileSync("git", ["commit", "-m", "init", "--quiet"], { cwd: dir });
	// staged 未提交：必须计入，否则 add 后数字归零误导。
	writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n");
	execFileSync("git", ["add", "."], { cwd: dir });
	const snapshot = await collectGitStatus(dir);
	assert.ok(snapshot.insertions >= 1, `staged insertions counted, got ${snapshot.insertions}`);
});

test("parseWorktree: 仅 linked worktree 具名", () => {
	assert.equal(parseWorktree("C:/repo/.git/worktrees/pi-cc-refs\n"), "pi-cc-refs");
	assert.equal(parseWorktree("C:/repo/.git"), null);
	assert.equal(parseWorktree(""), null);
});

test("statusline config: 缺失回默认，坏文件回默认不抛", () => {
	const dir = mkdtempSync(join(tmpdir(), "statusline-cfg-"));
	const missing = join(dir, "nope", "statusline.json");
	assert.deepEqual(readStatuslineConfig(missing), { enabled: true, showWorktree: true });
	const bad = join(dir, "bad.json");
	writeFileSync(bad, "{oops");
	assert.deepEqual(readStatuslineConfig(bad), { enabled: true, showWorktree: true });
});

test("statusline config: 写合并保留其他键", () => {
	const dir = mkdtempSync(join(tmpdir(), "statusline-cfg-"));
	const file = join(dir, "statusline.json");
	writeFileSync(file, JSON.stringify({ enabled: false, extra: 1 }));
	writeStatuslineConfig({ showWorktree: false }, file);
	assert.deepEqual(readStatuslineConfig(file), { enabled: false, showWorktree: false });
});

test("statusline config: 原子写不留下临时文件", () => {
	const dir = mkdtempSync(join(tmpdir(), "statusline-cfg-"));
	const file = join(dir, "statusline.json");
	writeStatuslineConfig({ enabled: false }, file);
	writeStatuslineConfig({ showWorktree: false }, file);
	assert.deepEqual(readStatuslineConfig(file), { enabled: false, showWorktree: false });
	assert.deepEqual(readdirSync(dir), ["statusline.json"], "tmp 文件已 rename 或清理");
});

test("normalizeMcpStatus: adapter 状态（ANSI+图标）收敛为 mcp N enabled", () => {
	assert.equal(normalizeMcpStatus(undefined), null);
	assert.equal(normalizeMcpStatus(""), null);
	// 真机抓到的脏字符串：主题 truecolor ANSI + ♆ 图标 + `MCP: 3 enabled`。
	assert.equal(normalizeMcpStatus("[38;2;177;185;249m♆ MCP: 3 enabled"), "mcp 3 enabled");
	assert.equal(normalizeMcpStatus("🔌 MCP: 3 servers"), "mcp 3 enabled");
	assert.equal(normalizeMcpStatus("MCP: 1 enabled"), "mcp 1 enabled");
	assert.equal(normalizeMcpStatus("MCP"), "mcp");
});

test("git poller: 变化即推、无变化退避不扰", async () => {
	const dir = mkdtempSync(join(tmpdir(), "statusline-git-"));
	execFileSync("git", ["init", "-b", "main"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "test@test"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
	writeFileSync(join(dir, "a.txt"), "hi\n");
	execFileSync("git", ["add", "."], { cwd: dir });
	execFileSync("git", ["commit", "-m", "init", "--quiet"], { cwd: dir });

	const seen: GitSnapshot[] = [];
	const stop = startGitPoller(
		dir,
		(snapshot) => {
			seen.push(snapshot);
		},
		50,
	);
	try {
		await new Promise((resolve) => setTimeout(resolve, 400));
		assert.ok(seen.length >= 1, "first snapshot must be pushed");
		assert.equal(seen[0]?.branch, "main");
		const count = seen.length;
		// 无变化：退避期间不再推送（400ms 内若按 50ms 轮询应远多于 count+1 次）。
		await new Promise((resolve) => setTimeout(resolve, 400));
		assert.ok(seen.length <= count + 1, `no spam while unchanged, got ${seen.length} vs ${count}`);
		// 有变化：改文件后下次轮询推送（退避已到 800ms，留足两拍余量）。
		writeFileSync(join(dir, "b.txt"), "yo\n");
		await new Promise((resolve) => setTimeout(resolve, 1800));
		assert.ok(seen.length > count, "change must be pushed");
		assert.ok((seen.at(-1)?.changedFiles ?? 0) > 0);
	} finally {
		stop();
	}
});

test("git poller: ctx 失效（嵌入式会话 dispose）后安静停表", async () => {
	const dir = mkdtempSync(join(tmpdir(), "statusline-git-stale-"));
	execFileSync("git", ["init", "-b", "main"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "test@test"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
	writeFileSync(join(dir, "a.txt"), "hi\n");
	execFileSync("git", ["add", "."], { cwd: dir });
	execFileSync("git", ["commit", "-m", "init", "--quiet"], { cwd: dir });

	let alive = true;
	let pushed = 0;
	const stop = startGitPoller(
		dir,
		() => {
			pushed++;
		},
		20,
		() => {
			if (!alive) throw new Error("stale ctx");
			return true;
		},
	);
	try {
		await new Promise((resolve) => setTimeout(resolve, 80));
		assert.ok(pushed >= 1, "live ctx keeps polling");
		alive = false;
		const before = pushed;
		await new Promise((resolve) => setTimeout(resolve, 160));
		assert.equal(pushed, before, "stale ctx stops polling without pushing");
	} finally {
		stop();
	}
});

test("parsePrNumber: gh 输出转 PR 号", () => {
	assert.equal(parsePrNumber("12\n"), 12);
	assert.equal(parsePrNumber(" 7 "), 7);
	assert.equal(parsePrNumber(""), null);
	assert.equal(parsePrNumber("abc"), null);
	assert.equal(parsePrNumber("0"), null);
});

test("getPrNumber: 60s 缓存 + 单飞行 + 失败记 null", async () => {
	_resetPrCache();
	let calls = 0;
	const run = async (_cwd: string) => {
		calls++;
		return "12\n";
	};
	assert.equal(getPrNumber("D:/repo", true, run, 0), null);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(getPrNumber("D:/repo", true, run, 1000), 12);
	assert.equal(calls, 1);
	// TTL 内不重刷。
	assert.equal(getPrNumber("D:/repo", true, run, 59_000), 12);
	assert.equal(calls, 1);
	// 过期重刷。
	assert.equal(getPrNumber("D:/repo", true, run, 61_000), 12);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(calls, 2);
	// 未启用 / 无 cwd 直接 null，不跑命令。
	assert.equal(getPrNumber("D:/repo", false, run, 0), null);
	assert.equal(getPrNumber("", true, run, 0), null);
	assert.equal(calls, 2);
	_resetPrCache();
	const failing = async (_cwd: string): Promise<string> => {
		throw new Error("no gh");
	};
	assert.equal(getPrNumber("D:/repo", true, failing, 0), null);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(getPrNumber("D:/repo", true, failing, 1000), null);
});
