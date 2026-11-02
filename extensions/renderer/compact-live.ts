/**
 * Compact 的 live 尾行与状态行组件。
 *
 * 从 compact-mode.ts 抽出：摘要行、abort/error/length 状态行、live 槽位缩进。
 * hover 状态由调用方传入，模块本身不持有回合状态。
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { themeOf } from "./compact-card.ts";
import {
	animateCompactThinkingText,
	type CompactThinkingQuery,
	styleCompactThinkingText,
} from "./compact-summary.ts";
import { showMoreHintText } from "./tool/names.ts";

export function compactAssistantLineComponent(
	component: any,
	/** 静态串或每次 render 重算（Running 时长需逐步跳动）。 */
	summary: string | (() => string),
	query?: CompactThinkingQuery,
	options: {
		hint?: boolean;
		leadingBlank?: boolean;
		pad?: number;
		isHovered?: () => boolean;
	} = {},
): any {
	const self = component as any;
	let paint:
		| {
				width: number;
				theme: unknown;
				resolved: string;
				hover: boolean;
				hint: boolean;
				pad: number;
				frame: number;
				leadingBlank: boolean;
				lines: string[];
		  }
		| undefined;
	return {
		render(width: number): string[] {
			const theme = themeOf();
			const pad = Math.max(0, options.pad ?? (Number(self.outputPad) || 0));
			const available = Math.max(0, width - pad);
			const hint = options.hint !== false;
			const hintText = hint ? ` · ${showMoreHintText()}` : "";
			const summaryWidth = Math.max(0, available - visibleWidth(hintText));
			const resolved = typeof summary === "function" ? summary() : summary;
			const runningActive = resolved.startsWith("Running...");
			const hover = options.isHovered?.() ?? false;
			const frame = runningActive ? (query?.getThinkingAnimationFrame?.() ?? 0) : 0;
			const leadingBlank = options.leadingBlank !== false;
			if (
				paint &&
				paint.width === width &&
				paint.theme === theme &&
				paint.resolved === resolved &&
				paint.hover === hover &&
				paint.hint === hint &&
				paint.pad === pad &&
				paint.frame === frame &&
				paint.leadingBlank === leadingBlank
			) {
				return paint.lines;
			}
			const plainText = truncateToWidth(resolved, summaryWidth, "…");
			const plain = (value: string) => theme.fg("dim", value);
			let text = plain(plainText);
			if (runningActive || plainText.startsWith("Ran for ")) {
				const separator = plainText.indexOf(", ");
				const heading = separator < 0 ? plainText : plainText.slice(0, separator);
				const tools = separator < 0 ? "" : plainText.slice(separator);
				if (runningActive) {
					const durationSeparator = heading.indexOf(" · ");
					const label = durationSeparator < 0 ? heading : heading.slice(0, durationSeparator);
					const duration = durationSeparator < 0 ? "" : heading.slice(durationSeparator);
					text = `${animateCompactThinkingText(label, theme, query?.getThinkingAnimationFrame?.() ?? 0)}${styleCompactThinkingText(duration, theme)}${plain(tools)}`;
				} else {
					text = `${styleCompactThinkingText(heading, theme)}${plain(tools)}`;
				}
			}
			// 圆点保持 dim；hover 只高亮可点击文字。
			const hintPart = hint
				? `${theme.fg("dim", " · ")}${theme.fg(hover ? "text" : "dim", showMoreHintText())}`
				: "";
			const line = `${text}${hintPart}`;
			const rendered = `${" ".repeat(pad)}${truncateToWidth(line, available, "")}`;
			const lines = leadingBlank ? ["", rendered] : [rendered];
			paint = {
				width,
				theme,
				resolved,
				hover,
				hint,
				pad,
				frame,
				leadingBlank,
				lines,
			};
			return lines;
		},
		invalidate() {
			paint = undefined;
		},
	};
}

export function compactStopStatusLine(
	status: { text: string; kind: string } | string,
	pad = 0,
): any {
	return {
		render(width: number): string[] {
			const theme = themeOf();
			const prefix = " ".repeat(Math.max(0, pad));
			const text = typeof status === "string" ? status : status.text;
			const kind = typeof status === "string" ? "error" : status.kind;
			// 取消灰 / 失败红 / 超长 warning + /compact 引导。
			const color = kind === "aborted" ? "dim" : kind === "length" ? "warning" : "error";
			const hint = kind === "length" ? theme.fg("dim", " • run /compact to compress") : "";
			const line = `${prefix}${theme.fg(color, text)}${hint}`;
			return ["", truncateToWidth(line, width, "")];
		},
		invalidate() {},
	};
}

/** live 槽位卡：按 pad 缩进；首行 `↳` 由卡自身的 live 排布加，行不增不减。 */
export function compactLiveSlot(card: any, pad = 0): any {
	const innerOf = (width: number) => Math.max(0, width - Math.max(0, pad));
	return {
		render(width: number): string[] {
			const indent = " ".repeat(Math.max(0, pad));
			return card.render(innerOf(width)).map((line: string) => `${indent}${line}`);
		},
		childAtRow(localRow: number, width: number) {
			return card.childAtRow?.(localRow, innerOf(width)) ?? null;
		},
		invalidate() {
			card.invalidate();
		},
	};
}

export function appendStopStatus(
	component: any,
	status: { text: string; kind: string } | string | undefined,
): void {
	if (!status || !component?.contentContainer?.addChild) return;
	component.contentContainer.addChild(
		compactStopStatusLine(status, Number(component.outputPad) || 0),
	);
}
