/**
 * fullscreen 选区复制清洗补丁（clean copy）。
 *
 * 官方 TuiAltScreen 复制链路：
 *   copySelectionToClipboard() → getActiveSelectionText() → copyTextToClipboard(text)
 * 这里包一层最外层：拿到纯文本后先过 `cleanCopiedText`，再交给官方
 * `copyTextToClipboard`（它会走宿主的 clipboard 实现 + “Copied!” flash）。
 *
 * 只影响 fullscreen 鼠标选区；regular 模式的选区由终端模拟器自己处理。
 * `config.cleanCopy` 在调用时读取，`/ccstyle` 里切换立即生效。
 */
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { config } from "../../config/config.ts";
import { cleanCopiedText } from "../../utils/clean-copy.ts";
import { CLEAN_COPY_PATCH, patchRegistry } from "../../utils/patch-keys.ts";

type CopyPatch = {
	active: boolean;
	original: (this: any, ...args: unknown[]) => unknown;
	installed: (this: any, ...args: unknown[]) => unknown;
};

/** 安装（幂等）：/reload 后复用上一份 original，避免补丁套补丁。 */
export function installCleanCopy(): void {
	const prototype = (TuiAltScreen as unknown as { prototype?: Record<string, unknown> })?.prototype;
	if (!prototype || typeof prototype.copySelectionToClipboard !== "function") return;

	const previous = patchRegistry.get<CopyPatch>(CLEAN_COPY_PATCH);
	if (previous) previous.active = false;
	const original =
		previous && prototype.copySelectionToClipboard === previous.installed
			? previous.original
			: (prototype.copySelectionToClipboard as CopyPatch["original"]);

	const patch: CopyPatch = {
		active: true,
		original,
		installed(this: any, ...args: unknown[]) {
			if (!patch.active || !config.cleanCopy) return original.apply(this, args);
			let text: string | undefined;
			try {
				text = this.getActiveSelectionText?.();
			} catch {
				text = undefined;
			}
			if (!text) return original.apply(this, args);
			const cleaned = cleanCopiedText(text);
			if (!cleaned) return false;
			if (typeof this.copyTextToClipboard !== "function") return original.apply(this, args);
			return this.copyTextToClipboard(cleaned);
		},
	};
	prototype.copySelectionToClipboard = patch.installed;
	patchRegistry.install(CLEAN_COPY_PATCH, patch);
}
