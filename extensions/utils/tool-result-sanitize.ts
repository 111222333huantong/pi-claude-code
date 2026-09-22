const UNSAFE_TERMINAL_ESCAPE = new RegExp(
	"(?:\\u001B\\]|\\u009D)[\\s\\S]*?(?:\\u0007|\\u001B\\x5C|\\u009C)" +
		"|(?:\\u001B[PX^_]|\\u0090)[\\s\\S]*?(?:\\u001B\\x5C|\\u009C)" +
		"|(?:\\u001B\\[|\\u009B)[0-?]*[ -/]*[@-~]" +
		"|\\u001B[@-_]",
	"g",
);

/**
 * Prevent captured terminal control responses from being replayed by tool renderers.
 * Optional `maxChars` trims the input first so preview/one-line paths never scan multi-MB outputs.
 */
export function sanitizeToolResultText(value: string, maxChars?: number): string {
	const source =
		typeof maxChars === "number" && maxChars >= 0 && value.length > maxChars
			? value.slice(0, maxChars)
			: value;
	return (
		source
			.replace(UNSAFE_TERMINAL_ESCAPE, "")
			.replace(/\x1B/g, "")
			.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "")
			.replace(/\r\n/g, "\n")
			// \r 进度帧折叠：同一物理行被反复覆写时只留最后一帧——终端回放的
			// 视觉结果本就只有末帧，npm/pip 安装条不再刷屏（思想重写自 pix-pretty）。
			.replace(/[^\n]*\r[^\n]*/g, (run) => {
				const frames = run.split("\r");
				for (let i = frames.length - 1; i >= 0; i--) {
					if (frames[i]) return frames[i]!;
				}
				return "";
			})
	);
}
