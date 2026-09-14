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
	/** 冲突文件数（porcelain UU/AA/DD/AU/UA/DU/UD 行数）。 */
	conflictFiles: number;
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
	conflictFiles: 0,
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
	conflictFiles: number;
} {
	let changedFiles = 0;
	let hasConflicts = false;
	let conflictFiles = 0;
	for (const line of lines) {
		if (line.length < 2) continue;
		const code = line.slice(0, 2);
		if (code === "??") {
			changedFiles++;
			continue;
		}
		if (code.trim() === "") continue;
		changedFiles++;
		if (CONFLICT_CODES.has(code)) {
			hasConflicts = true;
			conflictFiles++;
		}
	}
	return { changedFiles, hasConflicts, conflictFiles };
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
		// `-uno`（normal）：未跟踪目录折叠为单行，比 `all` 递归扫描便宜一个量级；
		// 状态栏只用脏否（changedFiles > 0），计数口径差异无影响。
		runGit(cwd, ["status", "--porcelain=v1", "--branch", "--untracked-files=normal"]),
		// 对 HEAD（含 staged）：`git add` 后数字不归零，避免"明明改了却显示 ok"。
		runGit(cwd, ["diff", "HEAD", "--shortstat"]),
		runGit(cwd, ["rev-parse", "--git-dir"]),
	]);
	if (porcelain === null) return { ...EMPTY_GIT_SNAPSHOT };
	const lines = porcelain.split("\n");
	const { branch, ahead, behind } = parsePorcelainHead(lines[0] ?? "");
	if (branch === null) return { ...EMPTY_GIT_SNAPSHOT };
	const { changedFiles, hasConflicts, conflictFiles } = parsePorcelainFiles(lines.slice(1));
	const { insertions, deletions } = parseShortstat(shortstat ?? "");
	return {
		branch,
		changedFiles,
		hasConflicts,
		conflictFiles,
		ahead,
		behind,
		insertions,
		deletions,
		worktree: gitDir ? parseWorktree(gitDir) : null,
	};
}

/** 退避上限：连续无变化/失败时轮询间隔指数退避至此。 */
export const MAX_GIT_POLL_INTERVAL_MS = 30_000;

/**
 * 启动后台轮询：立即采一次 + 按需刷新（单飞行，忙则跳过）。
 * 快照无变化或采集失败时指数退避（×2，上限 30s），有变化立即恢复基准；
 * 无变化不调 onUpdate（省一次 footer 重绘）。
 * 返回停表函数；回调异常内部吞掉。
 */
export function startGitPoller(
	cwd: string,
	onUpdate: (snapshot: GitSnapshot) => void,
	intervalMs = 3000,
): () => void {
	let stopped = false;
	let inFlight = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let delay = intervalMs;
	let lastKey = "";

	const schedule = () => {
		if (stopped) return;
		timer = setTimeout(() => void tick(), delay);
		(timer as unknown as { unref?: () => void }).unref?.();
	};

	const tick = async () => {
		timer = null;
		if (stopped || inFlight) {
			schedule();
			return;
		}
		inFlight = true;
		try {
			const snapshot = await collectGitStatus(cwd);
			if (stopped) return;
			const key = JSON.stringify(snapshot);
			// 采集失败（空快照）或快照无变化：退避，不打扰渲染。
			if (snapshot.branch === null || key === lastKey) {
				delay = Math.min(MAX_GIT_POLL_INTERVAL_MS, Math.max(intervalMs, delay * 2));
			} else {
				delay = intervalMs;
				lastKey = key;
				try {
					onUpdate(snapshot);
				} catch {
					// ignore listener errors
				}
			}
		} finally {
			inFlight = false;
		}
		schedule();
	};

	void tick();
	return () => {
		stopped = true;
		if (timer) clearTimeout(timer);
		timer = null;
	};
}
