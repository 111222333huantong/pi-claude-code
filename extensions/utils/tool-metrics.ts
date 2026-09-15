/**
 * Tool 执行耗时/输出量统计装饰器（移植自 pi-pretty `src/tools/metrics.ts`，MIT）。
 *
 * 用法：包一层 tool `execute`，成功时把耗时记入 `details`（throw 路径走
 * `onRejected` 回调，不吞错）。调用方按需展示，渲染层只读 `details`。
 */

/** `details` 上的耗时键（与 pi-pretty 同名，便于跨包对账）。 */
export const ELAPSED_MS_KEY = "__prettyElapsedMs";
/** `details` 上的输出字符数键（与 pi-pretty 同名）。 */
export const OUTPUT_CHARS_KEY = "__prettyOutputChars";

export function attachExecuteMetrics(
	details: Record<string, unknown> | undefined,
	elapsedMs: number,
	outputChars: number,
): Record<string, unknown> {
	const target = details ?? {};
	target[ELAPSED_MS_KEY] = elapsedMs;
	target[OUTPUT_CHARS_KEY] = outputChars;
	return target;
}

/** 工具执行耗时短格式：`<1s` 返回 ""（调用方省略），否则 `Ns`/`Nm Ns`。 */
export function formatElapsedShort(ms: number): string {
	if (!Number.isFinite(ms) || ms < 1_000) return "";
	const totalSec = Math.floor(ms / 1000);
	const minutes = Math.floor(totalSec / 60);
	const seconds = totalSec % 60;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

export function wrapExecuteWithMetrics<TExecute extends (...args: never[]) => Promise<unknown>>(
	execute: TExecute,
	onRejected?: (error: unknown, elapsedMs: number) => void,
): TExecute {
	return (async (...args: never[]) => {
		const start = performance.now();
		try {
			return await execute(...args);
		} catch (error) {
			try {
				onRejected?.(error, performance.now() - start);
			} catch {
				/* 回调永不抛，不掩盖原始错误 */
			}
			throw error;
		}
	}) as TExecute;
}
