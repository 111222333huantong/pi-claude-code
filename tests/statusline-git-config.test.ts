import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	collectGitStatus,
	parsePorcelainFiles,
	parsePorcelainHead,
	parseShortstat,
	parseWorktree,
	startGitPoller,
	type GitSnapshot,
} from "../extensions/feature/statusline/git.ts";
import {
	readStatuslineConfig,
	writeStatuslineConfig,
} from "../extensions/feature/statusline/config.ts";

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
	});
	assert.deepEqual(parsePorcelainFiles([]), { changedFiles: 0, hasConflicts: false });
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
		// 有变化：改文件后下次轮询推送。
		writeFileSync(join(dir, "b.txt"), "yo\n");
		await new Promise((resolve) => setTimeout(resolve, 800));
		assert.ok(seen.length > count, "change must be pushed");
		assert.ok((seen.at(-1)?.changedFiles ?? 0) > 0);
	} finally {
		stop();
	}
});
