/**
 * 状态栏独立配置：`~/.pi/agent/statusline.json`。
 *
 * 与主配置 `claude-code-style.json` 分离（用户选择）：坏文件永不抛、
 * 缺键回默认、写入保留其他键。`filePath` 参数供测试指向临时文件。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface StatuslineConfig {
	/** 总闸；false 时不注册 footer，`/statusline` 可重新打开。 */
	enabled: boolean;
	/** L2 是否显示 `wt <name>` worktree 段。 */
	showWorktree: boolean;
}

export const DEFAULT_STATUSLINE_CONFIG: StatuslineConfig = {
	enabled: true,
	showWorktree: true,
};

/** 与 config.ts / quiet-startup.ts 一致：honor PI_CODING_AGENT_DIR。 */
export function defaultStatuslinePath(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return join(agentDir, "statusline.json");
}

function normalize(input: unknown): StatuslineConfig {
	const source = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
	return {
		enabled: source.enabled !== false,
		showWorktree: source.showWorktree !== false,
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
	try {
		mkdirSync(dirname(filePath), { recursive: true });
		writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`);
	} catch {
		// best effort
	}
}
