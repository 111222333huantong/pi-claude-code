import { Markdown, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { config } from "../../config/config.ts";
import { stripAnsi } from "../../utils/ansi-text.ts";
import { CODE_BLOCK_PATCH, patchRegistry } from "../../utils/patch-keys.ts";

/**
 * Assistant 代码块美化：把 Pi 原生 Markdown 渲染出的 ```fence 行
 * 套上主题色圆角框（移植自 cc-my-pi `tool-chrome.ts` 的套框语义，
 * 去掉复制分区/`Alt+C` hint，只留美化）。
 *
 * Pi 原生行为（`@earendil-works/pi-tui` Markdown）：代码块渲染为
 * ` ```lang ` / `  <code> ` / ` ``` ` 三段，` ``` ` 行经 `codeBlockBorder`
 * 主题着色。本模块在 `Markdown.render(width)` 返回后做行级后处理，
 * 把 fence 对替换为 `╭── lang ──╮ / │ code │ / ╰──╯`，框线取 UI 主题
 * accent 色（与 spinner 动词同色，`setCodeBlockTheme` 同步）。
 */

// 固定灰回退（主题取不到时用）。
export const FALLBACK_BORDER_COLOR = "\x1b[38;5;238m";
const LANG_FG = "\x1b[38;2;95;95;95m";
const RESET = "\x1b[0m";
const TRANSPARENT_RESET = `${RESET}\x1b[49m`;
const ITALIC = "\x1b[3m";

type UiThemeLike = { getFgAnsi?: (key: string) => string };

/** renderer/index 在 session_start 等处同步的 TUI 主题（与 spinner 同源，换主题实时生效）。 */
let uiTheme: UiThemeLike | undefined;

export function setCodeBlockTheme(theme: unknown): void {
	uiTheme = theme as UiThemeLike | undefined;
}

/** 优先取主题 accent 色（cc-dark 下蓝色，与 spinner 动词同色）。 */
function resolveAccentBorder(): string | undefined {
	const getFg = uiTheme?.getFgAnsi;
	if (typeof getFg !== "function") return undefined;
	for (const key of ["borderAccent", "accent"]) {
		try {
			const value = getFg.call(uiTheme, key);
			if (typeof value === "string" && value.length > 0) return value;
		} catch {
			/* ignore，试下一个 key */
		}
	}
	return undefined;
}

/**
 * 框线色解析：UI 主题 accent → Markdown 实例 `codeBlockBorder` 样本 → 固定灰。
 * 注意 `codeBlockBorder` 在 cc-dark 里本身就是深灰，不能作为主题色的首选。
 */
export function resolveBorderColor(mdTheme: unknown): string {
	const accent = resolveAccentBorder();
	if (accent) return accent;
	try {
		const theme = mdTheme as { codeBlockBorder?: (text: string) => string } | undefined;
		const sample = theme?.codeBlockBorder?.("─");
		if (typeof sample === "string") {
			const prefix = sample.match(/^((?:\x1b\[[0-9;]*m)+)/)?.[1];
			if (prefix) return prefix;
		}
	} catch {
		/* ignore，使用回退色 */
	}
	return FALLBACK_BORDER_COLOR;
}

/** 不套框的语言：空 fence 与纯文本标记只去 fence 标记、保留原文。 */
export const PLAIN_FENCE_LANGS = new Set(["text", "txt", "plain", "plaintext", ""]);

type FenceLine = { kind: "open" | "close"; language: string };

/** 解析渲染后的 fence 行（主题可能已加 ANSI，先剥离再判断）。 */
export function parseRenderedFenceLine(line: string): FenceLine | undefined {
	const plain = stripAnsi(line).trim();
	if (plain === "```") return { kind: "close", language: "" };
	if (!plain.startsWith("```")) return undefined;
	const rest = plain.slice(3).trim();
	if (rest.includes("`")) return undefined;
	return { kind: "open", language: rest };
}

/** 语言标签归一化：小写，空返回 ""（无标签头）。 */
export function formatCodeBlockLanguageLabel(language: string): string {
	const raw = language.trim();
	if (!raw) return "";
	return raw.toLowerCase();
}

export function roundedCodeBlockTop(
	width: number,
	language: string,
	border: string = FALLBACK_BORDER_COLOR,
): string {
	if (width <= 1) return `${border}│${TRANSPARENT_RESET}`;
	const label = formatCodeBlockLanguageLabel(language);
	if (!label || width < 10) {
		const inner = Math.max(0, width - 2);
		return `${border}╭${"─".repeat(inner)}╮${TRANSPARENT_RESET}`;
	}
	// 顶行标签两侧留呼吸感：`╭── label ──…╮`（固定 6 格 + 标签 + 填充）。
	const visibleLabel = truncateToWidth(label, Math.max(1, width - 8), "…");
	const styledLabel = `${LANG_FG}${ITALIC}${visibleLabel}${RESET}${TRANSPARENT_RESET}`;
	const labelW = visibleWidth(styledLabel);
	const fill = "─".repeat(Math.max(0, width - 6 - labelW));
	return `${border}╭── ${TRANSPARENT_RESET}${styledLabel} ${border}${fill}╮${TRANSPARENT_RESET}`;
}

export function roundedCodeBlockBottom(
	width: number,
	border: string = FALLBACK_BORDER_COLOR,
): string {
	if (width <= 1) return `${border}│${TRANSPARENT_RESET}`;
	const inner = Math.max(0, width - 2);
	return `${border}╰${"─".repeat(inner)}╯${TRANSPARENT_RESET}`;
}

export function borderedCodeBlockLine(
	line: string,
	width: number,
	border: string = FALLBACK_BORDER_COLOR,
): string {
	const innerWidth = Math.max(1, width - 4);
	let content = line;
	if (visibleWidth(content) > innerWidth) {
		content = truncateToWidth(content, innerWidth, "", false);
	}
	const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(content)));
	return `${border}│${TRANSPARENT_RESET} ${content}${padding} ${border}│${TRANSPARENT_RESET}`;
}

export function boxRenderedCodeBlock(
	bodyLines: string[],
	language: string,
	width: number,
	border: string = FALLBACK_BORDER_COLOR,
): string[] {
	const safeWidth = Math.max(4, Number.isFinite(width) ? Math.floor(width) : 0);
	return [
		roundedCodeBlockTop(safeWidth, language, border),
		...bodyLines.map((line) => borderedCodeBlockLine(line, safeWidth, border)),
		roundedCodeBlockBottom(safeWidth, border),
	];
}

/**
 * 行级后处理：fence 对 → 圆角框；plain 语言只去标记；未闭合保持原文。
 * 非 fence 行原样透传（不做标题剥离等额外改动）。
 */
export function sanitizeRenderedTextBlockLines(
	lines: string[],
	width?: number,
	border: string = resolveBorderColor(undefined),
): string[] {
	const result: string[] = [];
	let i = 0;
	const canBox = typeof width === "number" && width > 0;
	while (i < lines.length) {
		const fence = parseRenderedFenceLine(lines[i]);
		// 顶层 ` ``` ` 无语言：按 toggle 语义视为 open（空语言），
		// 与 ` ```lang ` 同走套框/去标记流程；plain 名单保证空语言只去标记不套框。
		const openLang =
			fence?.kind === "open" ? fence.language : fence?.kind === "close" ? "" : undefined;
		if (openLang !== undefined) {
			const language = openLang;
			const hideBox = PLAIN_FENCE_LANGS.has(language.trim().toLowerCase());
			const body: string[] = [];
			i++;
			let closed = false;
			while (i < lines.length) {
				const close = parseRenderedFenceLine(lines[i]);
				if (close?.kind === "close") {
					closed = true;
					i++;
					break;
				}
				// fence 未闭合时遇到新的 open：上一块按原文保留，避免吞行。
				if (close?.kind === "open") break;
				body.push(lines[i]);
				i++;
			}
			if (!closed) {
				// 未闭合：保留原文（含 opening fence 行本身）。
				result.push(lines[i - body.length - 1]);
				result.push(...body);
				continue;
			}
			if (hideBox) {
				result.push(...body);
			} else if (canBox && (body.length > 0 || language.trim())) {
				result.push(...boxRenderedCodeBlock(body, language, width, border));
			} else {
				result.push(...body);
			}
			continue;
		}
		if (fence?.kind === "close") {
			// 孤立 closing fence：保持原文，避免丢行。
			result.push(lines[i]);
			i++;
			continue;
		}
		result.push(lines[i]);
		i++;
	}
	return result;
}

type MarkdownRenderFn = (width: number) => string[];

const RENDER_WRAPPED = Symbol.for("pi.ccstyle.code-block-render-wrapped");

/**
 * 给 `Markdown.render` 打套框补丁：幂等（/reload 重复加载不叠包装饰），
 * `mode === "off"` 时直通原生。常驻安装、无需 dispose（开关走 live 判断）。
 */
export function installCodeBlockBox(): void {
	const prototype = Markdown.prototype as unknown as Record<string | symbol, unknown>;
	if ((prototype.render as unknown as Record<symbol, unknown>)?.[RENDER_WRAPPED]) {
		patchRegistry.ensure(CODE_BLOCK_PATCH, () => ({ active: true }));
		return;
	}
	const original = prototype.render as unknown as MarkdownRenderFn;
	if (typeof original !== "function") return;
	const installed = function (this: unknown, width: number): string[] {
		const lines = original.call(this, width);
		if (!Array.isArray(lines) || lines.length === 0) return lines;
		if (config.mode === "off") return lines;
		try {
			const border = resolveBorderColor((this as { theme?: unknown } | undefined)?.theme);
			return sanitizeRenderedTextBlockLines(lines, width, border);
		} catch {
			return lines;
		}
	};
	(installed as unknown as Record<symbol, unknown>)[RENDER_WRAPPED] = true;
	prototype.render = installed as unknown;
	patchRegistry.install(CODE_BLOCK_PATCH, { active: true });
}
