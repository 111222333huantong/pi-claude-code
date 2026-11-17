/**
 * 状态栏独立配置：`~/.pi/agent/statusline.json`。
 *
 * 与主配置 `claude-code-style.json` 分离（用户选择）：坏文件永不抛、
 * 缺键回默认、写入保留其他键。`filePath` 参数供测试指向临时文件。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface StatuslineConfig {
	/** 总闸；false 时不注册 footer，`/statusline` 可重新打开。 */
	enabled: boolean;
	/** L2 是否显示 `wt <name>` worktree 段。 */
	showWorktree: boolean;
	/**
	 * git 轮询档位：
	 * - `full`：完整快照（分支 + staged/unstaged/untracked + insertions/deletions + PR），默认。
	 * - `branch`：只读分支名（轻量 `git branch --show-current`），适合 Windows 多 worktree
	 *   或 git 进程敏感场景（pi-powerline-footer issue #57 同口径）。
	 * - `off`：不做扩展轮询，git 段只保留启动快照（不再后台刷新）。
	 */
	gitPolling: "full" | "branch" | "off";
}

export const DEFAULT_STATUSLINE_CONFIG: StatuslineConfig = {
	enabled: true,
	showWorktree: true,
	gitPolling: "full",
};

/** 与 config.ts / quiet-startup.ts 一致：honor PI_CODING_AGENT_DIR。 */
export function defaultStatuslinePath(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return join(agentDir, "statusline.json");
}

function normalize(input: unknown): StatuslineConfig {
	const source = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
	const polling = source.gitPolling;
	return {
		enabled: source.enabled !== false,
		showWorktree: source.showWorktree !== false,
		gitPolling: polling === "branch" || polling === "off" ? polling : "full",
	};
}

/** 读取配置；文件缺失/损坏一律回默认，永不抛。 */
export function readStatuslineConfig(filePath: string = defaultStatuslinePath()): StatuslineConfig {
	try {
		if (!existsSync(filePath)) return { ...DEFAULT_STATUSLINE_CONFIG };
		return normalize(JSON.parse(readFileSync(filePath, "utf8")));
	} catch {
		return { ...DEFAULT_STATUSLINE_CONFIG };
	}
}

/** 合并写入 partial，保留其他键；损坏的原文件不覆盖。写失败静默。 */
export function writeStatuslineConfig(
	partial: Partial<StatuslineConfig>,
	filePath: string = defaultStatuslinePath(),
): void {
	let settings: Record<string, unknown> = {};
	if (existsSync(filePath)) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
			if (parsed && typeof parsed === "object") settings = parsed as Record<string, unknown>;
			else return;
		} catch {
			return;
		}
	}
	const next = normalize({ ...settings, ...partial });
	const text = `${JSON.stringify(next, null, 2)}\n`;
	// 原子写：先写 tmp 再 rename，崩溃不留半截 JSON（与主配置同做法）。
	const tmp = `${filePath}.${process.pid}.tmp`;
	try {
		mkdirSync(dirname(filePath), { recursive: true });
		writeFileSync(tmp, text);
		renameSync(tmp, filePath);
	} catch {
		try {
			rmSync(tmp, { force: true });
		} catch {
			// best effort
		}
		try {
			writeFileSync(filePath, text);
		} catch {
			// best effort
		}
	}
}
