/**
 * 用户端只加一个箭头（朴素 ❯），其余一律不动。
 *
 * A. 已提交消息：首个有字行前插 dim 色 `❯ `，超宽截断保宽；
 *    边框/留白/底色/附件树/图片块全部保持 Pi 原生。
 * B. 输入框：提示行加 `❯ `；bash `!` 开头与已装饰行放过，续行不动。
 */

import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { config } from "../config/config.ts";
import { hasVisibleText, stripAnsi } from "../utils/ansi-text.ts";
import { walkComponentTree } from "../utils/component-tree.ts";
import { patchRegistry, USER_MESSAGE_PATCH } from "../utils/patch-keys.ts";
import { getMessageDisplayTheme } from "./tool/message-display.ts";

/** 箭头前缀 `❯ `。 */
export const USER_PROMPT_PREFIX = "❯ ";

const ESC_CODE = 27;
const BEL_CODE = 7;

/**
 * 切出行首不可见前缀（空格 + CSI/OSC 转义Run）：手工扫描，
 * 不用含转义字面的正则。返回 [head, rest]。
 */
function splitHeadRest(line: string): [string, string] {
	let i = 0;
	while (i < line.length) {
		const code = line.charCodeAt(i);
		if (code === 32 || code === 9) {
			i += 1;
			continue;
		}
		if (code !== ESC_CODE) break;
		const next = line[i + 1];
		if (next === "[") {
			let j = i + 2;
			while (j < line.length) {
				const c = line.charCodeAt(j);
				if (c >= 64 && c <= 126) {
					j += 1;
					break;
				}
				j += 1;
			}
			i = j;
			continue;
		}
		if (next === "]") {
			let j = i + 2;
			while (j < line.length) {
				if (line.charCodeAt(j) === BEL_CODE) {
					j += 1;
					break;
				}
				if (line.charCodeAt(j) === ESC_CODE && line[j + 1] === "\\") {
					j += 2;
					break;
				}
				j += 1;
			}
			i = j;
			continue;
		}
		break;
	}
	return [line.slice(0, i), line.slice(i)];
}

/**
 * 只加一个箭头：首个有字行前插 dim 色 `❯ `，超宽截断保宽，
 * 其余行逐字节不动。行首已有 ❯/›/> 标记则替换（保持只一个箭头，
 * 宽度不变）。
 */
export function addArrowToFirstLine(
	lines: string[],
	width: number,
	dim: (text: string) => string,
): string[] {
	const index = lines.findIndex((line) => hasVisibleText(line));
	if (index === -1) return lines;
	const next = lines.slice();
	const line = next[index]!;
	const [head, rest] = splitHeadRest(line);
	let inserted: string;
	if (/^[❯›>]/.test(rest)) {
		inserted = `${head}${dim("❯")}${rest.slice(1)}`;
	} else {
		inserted = `${head}${dim(USER_PROMPT_PREFIX)}${rest.replace(/^ /, "")}`;
	}
	next[index] =
		visibleWidth(stripAnsi(inserted)) > width ? truncateToWidth(inserted, width, "") : inserted;
	return next;
}

/**
 * 输入框提示行：去 editor 左 padding，加朴素 `❯ `；bash `!` 开头与已装饰
 * 行原样放过。
 */
export function prefixEditorPromptLine(line: string, paddingX: number, width: number): string {
	const removablePadding = Math.min(Math.max(0, paddingX), line.match(/^ */)?.[0].length ?? 0);
	const content = line.slice(removablePadding);
	const plainStart = stripAnsi(content).trimStart();
	if (plainStart.startsWith("❯") || plainStart.startsWith("!")) return line;
	return truncateToWidth(`${USER_PROMPT_PREFIX}${content}`, Math.max(0, width), "");
}

function dimPaint(): ((text: string) => string) | undefined {
	const theme = getMessageDisplayTheme() as
		| { fg?: (color: string, text: string) => string }
		| undefined;
	if (typeof theme?.fg !== "function") return undefined;
	return (text: string) => theme.fg!("dim", text);
}

/** patch 已提交消息 render；mode=off 回退原生。返回 dispose。 */
export function installUserMessageRender(): () => void {
	const previous = patchRegistry.get<{ dispose: () => void }>(USER_MESSAGE_PATCH);
	if (previous) previous.dispose();
	const prototype = (UserMessageComponent as any).prototype;
	const original = prototype.render;
	if (typeof original !== "function") return () => {};
	const patch: { active: boolean; dispose: () => void } = { active: true, dispose: () => {} };
	const installed = function (this: any, width: number): string[] {
		if (!patch.active || config.mode === "off") return original.call(this, width);
		try {
			const dim = dimPaint();
			if (!dim) return original.call(this, width);
			const lines = original.call(this, width) ?? [];
			if (!Array.isArray(lines) || lines.length === 0) return lines;
			return addArrowToFirstLine(lines, Math.max(1, Math.floor(width) || 80), dim);
		} catch {
			return original.call(this, width);
		}
	};
	prototype.render = installed;
	patch.dispose = () => {
		patch.active = false;
		if (prototype.render === installed) prototype.render = original;
		patchRegistry.dispose(USER_MESSAGE_PATCH, patch);
	};
	patchRegistry.install(USER_MESSAGE_PATCH, patch);
	return patch.dispose;
}

/** 已挂载用户消息按当前 mode 重渲染（/ccstyle 切换）。 */
export function refreshUserMessages(root: any): void {
	walkComponentTree(root, (value: any) => {
		if (value instanceof UserMessageComponent) {
			value.invalidate?.();
			return false;
		}
		return true;
	});
}
