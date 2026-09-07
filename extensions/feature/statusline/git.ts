/**
 * Git 状态快照：分支 + 脏文件数 + 上下游同步 + 行级 diffstat + worktree。
 *
 * 约定（kreeger/pi-statusbar 范式）：
 * - render 路径只读内存快照，永不阻塞；
 * - 后台轮询单飞行，失败静默保留旧快照；
 * - 所有解析函数纯函数，可单测；exec 永不抛。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitSnapshot {
	/** null = 非 git 仓库（此时整个 git 段省略）。 */
	branch: string | null;
	changedFiles: number;
	hasConflicts: boolean;
	ahead: number | null;
	behind: number | null;
	insertions: number;
	deletions: number;
	/** linked worktree 名；主 worktree / 非仓库为 null。 */
	worktree: string | null;
}

export const EMPTY_GIT_SNAPSHOT: GitSnapshot = {
	branch: null,
	changedFiles: 0,
	hasConflicts: false,
	ahead: null,
	behind: null,
	insertions: 0,
	deletions: 0,
	worktree: null,
};

/** 解析 `## main...origin/main [ahead 2, behind 1]` 首行；纯函数。 */
export function parsePorcelainHead(line: string): {
	branch: string | null;
	ahead: number | null;
	behind: number | null;
} {
	const head = line.startsWith("## ") ? line.slice(3) : line;
	const branchPart = head.split("...")[0] ?? "";
	let branch: string | null = branchPart.trim() || null;
	if (branch === "HEAD" || branch === "No commits yet on") branch = "detached";
	if (branch?.startsWith("No commits yet on ")) branch = branch.slice("No commits yet on ".length);
	let ahead: number | null = null;
	let behind: number | null = null;
	const aheadMatch = head.match(/ahead (\d+)/);
	const behindMatch = head.match(/behind (\d+)/);
	if (aheadMatch) ahead = Number(aheadMatch[1]);
	if (behindMatch) behind = Number(behindMatch[1]);
	return { branch, ahead, behind };
}

const CONFLICT_CODES = new Set(["UU", "AA", "DD", "AU", "UA", "DU", "UD"]);

/** 解析 porcelain 文件行；纯函数。 */
export function parsePorcelainFiles(lines: readonly string[]): {
	changedFiles: number;
	hasConflicts: boolean;
} {
	let changedFiles = 0;
	let hasConflicts = false;
	for (const line of lines) {
		if (line.length < 2) continue;
		const code = line.slice(0, 2);
		if (code === "??") {
			changedFiles++;
			continue;
		}
		if (code.trim() === "") continue;
		changedFiles++;
		if (CONFLICT_CODES.has(code)) hasConflicts = true;
	}
	return { changedFiles, hasConflicts };
}

/** 解析 `2 files changed, 18 insertions(+), 5 deletions(-)`；纯函数。 */
export function parseShortstat(output: string): { insertions: number; deletions: number } {
	const ins = output.match(/(\d+) insertions?\(\+\)/);
	const del = output.match(/(\d+) deletions?\(-\)/);
	return {
		insertions: ins ? Number(ins[1]) : 0,
		deletions: del ? Number(del[1]) : 0,
	};
}

/** `git rev-parse --git-dir` → linked worktree 名；主库 / 非仓库返回 null。纯函数。 */
export function parseWorktree(gitDir: string): string | null {
	const normalized = gitDir.trim().replace(/\\/g, "/").replace(/\/$/, "");
	const marker = "/worktrees/";
	const index = normalized.lastIndexOf(marker);
	if (index === -1) return null;
	const name = normalized.slice(index + marker.length);
	return name || null;
}

async function runGit(cwd: string, args: string[]): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync("git", args, { cwd, timeout: 3000 });
		return stdout;
	} catch {
		return null;
	}
}

/** 全量采集一次；任何失败返回空快照（非仓库），永不抛。 */
export async function collectGitStatus(cwd: string): Promise<GitSnapshot> {
	const [porcelain, shortstat, gitDir] = await Promise.all([
		runGit(cwd, ["status", "--porcelain=v1", "--branch", "--untracked-files=all"]),
		runGit(cwd, ["diff", "--shortstat"]),
		runGit(cwd, ["rev-parse", "--git-dir"]),
	]);
	if (porcelain === null) return { ...EMPTY_GIT_SNAPSHOT };
	const lines = porcelain.split("\n");
	const { branch, ahead, behind } = parsePorcelainHead(lines[0] ?? "");
	if (branch === null) return { ...EMPTY_GIT_SNAPSHOT };
	const { changedFiles, hasConflicts } = parsePorcelainFiles(lines.slice(1));
	const { insertions, deletions } = parseShortstat(shortstat ?? "");
	return {
		branch,
		changedFiles,
		hasConflicts,
		ahead,
		behind,
		insertions,
		deletions,
		worktree: gitDir ? parseWorktree(gitDir) : null,
	};
}

/**
 * 启动后台轮询：立即采一次 + 每 intervalMs 刷新（单飞行，忙则跳过）。
 * 返回停表函数；回调异常内部吞掉。
 */
export function startGitPoller(
	cwd: string,
	onUpdate: (snapshot: GitSnapshot) => void,
	intervalMs = 3000,
): () => void {
	let stopped = false;
	let inFlight = false;
	let timer: ReturnType<typeof setInterval> | null = null;

	const poll = async () => {
		if (stopped || inFlight) return;
		inFlight = true;
		try {
			const snapshot = await collectGitStatus(cwd);
			if (!stopped) {
				try {
					onUpdate(snapshot);
				} catch {
					// ignore listener errors
				}
			}
		} finally {
			inFlight = false;
		}
	};

	void poll();
	timer = setInterval(() => void poll(), intervalMs);
	(timer as unknown as { unref?: () => void }).unref?.();
	return () => {
		stopped = true;
		if (timer) clearInterval(timer);
		timer = null;
	};
}
