/**
 * 当前分支关联 PR 号：`gh pr view` 60 秒缓存 + 单飞行。
 *
 * 约定（与 git.ts 一致）：
 * - 渲染路径只读缓存（同步返回），永不阻塞；
 * - gh 缺失 / 无 PR / 非仓库一律 null（整段省略），永不抛；
 * - runner/now 可注入，纯逻辑可单测。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** PR 缓存有效期：与上游 cc-my-pi / statusline-pi 同档 60 秒。 */
export const PR_CACHE_TTL_MS = 60_000;

type Runner = (cwd: string) => Promise<string>;

async function defaultRunner(cwd: string): Promise<string> {
	const { stdout } = await execFileAsync(
		"gh",
		["pr", "view", "--json", "number", "--jq", ".number"],
		{
			cwd,
			timeout: 10_000,
		},
	);
	return stdout;
}

/** 解析 gh 输出；纯函数。 */
export function parsePrNumber(output: string): number | null {
	const n = Number((output ?? "").trim());
	return Number.isInteger(n) && n > 0 ? n : null;
}

const cache = new Map<string, { at: number; value: number | null }>();
const inFlight = new Set<string>();

/** 同步返回上次已知值；过期则后台刷新一次（单飞行）。 */
export function getPrNumber(
	cwd: string,
	enabled: boolean,
	run: Runner = defaultRunner,
	now: number = Date.now(),
): number | null {
	if (!enabled || !cwd) return null;
	const hit = cache.get(cwd);
	if (hit && now - hit.at < PR_CACHE_TTL_MS) return hit.value;
	if (inFlight.has(cwd)) return hit?.value ?? null;
	inFlight.add(cwd);
	run(cwd).then(
		(out) => {
			cache.set(cwd, { at: now, value: parsePrNumber(out) });
			inFlight.delete(cwd);
		},
		() => {
			cache.set(cwd, { at: now, value: null });
			inFlight.delete(cwd);
		},
	);
	return hit?.value ?? null;
}

/** 测试用：清缓存与单飞行标记。 */
export function _resetPrCache(): void {
	cache.clear();
	inFlight.clear();
}
