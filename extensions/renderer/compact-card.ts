/**
 * Compact 卡片绘制：底色推导、展开面板排布、live 槽位裁剪。
 *
 * 纯渲染辅助，不持有回合状态；从 compact-mode.ts 抽出以缩小主文件。
 * `compact-mode.ts` 继续 re-export `stripSlotHint`，外部导入路径不变。
 */
import { Box, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	contentRowRange,
	hasVisibleText,
	removeStyledRange,
	stripBackgroundAnsi,
	stripTerminalSequencesPreservingLayout,
} from "../utils/ansi-text.ts";
import { paddedBackgroundRow } from "./tool/grouping.ts";
import { getMessageDisplayTheme } from "./tool/message-display.ts";
import { aggregateToolCardBgSlot, toolCardBgSlot } from "./tool/tool-state.ts";

export function fallbackTheme(): any {
	return {
		fg: (_color: string, text: string) => text,
		italic: (text: string) => text,
		bold: (text: string) => text,
	};
}

export function themeOf(): any {
	return getMessageDisplayTheme() ?? fallbackTheme();
}

/** RGB → HSL（h∈[0,1), l/s∈[0,1]）。 */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
	r /= 255;
	g /= 255;
	b /= 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const l = (max + min) / 2;
	if (max === min) return [0, 0, l];
	const d = max - min;
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	let h: number;
	switch (max) {
		case r:
			h = (g - b) / d + (g < b ? 6 : 0);
			break;
		case g:
			h = (b - r) / d + 2;
			break;
		default:
			h = (r - g) / d + 4;
	}
	return [h / 6, l, s];
}

/** HSL → RGB（h∈[0,1)，l/s∈[0,1]）。 */
function hslToRgb(h: number, l: number, s: number): [number, number, number] {
	if (s === 0) {
		const v = Math.round(l * 255);
		return [v, v, v];
	}
	const hue2rgb = (p: number, q: number, t: number): number => {
		if (t < 0) t += 1;
		if (t > 1) t -= 1;
		if (t < 1 / 6) return p + (q - p) * 6 * t;
		if (t < 1 / 2) return q;
		if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
		return p;
	};
	const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
	const p = 2 * l - q;
	return [
		Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
		Math.round(hue2rgb(p, q, h) * 255),
		Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
	];
}

/** 内部 tool call card 背景：在 userMessageBg 基础上按 HSL 变暗（l×0.7），
 *  与外卡片形成嵌套层次；非 RGB 色或已足够暗时原样返回。 */
function darkenBgAnsi(theme: any, slot: string): string {
	const prefix = typeof theme?.getBgAnsi === "function" ? String(theme.getBgAnsi(slot)) : "";
	const m = prefix.match(/48;2;(\d+);(\d+);(\d+)/);
	if (!m) return prefix;
	const [h, l, s] = rgbToHsl(Number(m[1]), Number(m[2]), Number(m[3]));
	if (l <= 0.05) return prefix; // 已足够暗，不再变暗
	const [r, g, b] = hslToRgb(h, l * 0.7, s);
	return `\x1b[48;2;${r};${g};${b}m`;
}

/** 工具卡深色行：左右各缩 1 格（含工具卡自身 padding），背景只到内容区，
 *  修复行尾 reset 截断。 */
function toolCardBgRow(
	theme: any,
	slot: string,
	bgAnsi: string,
	line: string,
	width: number,
): string {
	const leftInset = 1;
	const rightInset = 1;
	const contentWidth = Math.max(0, width - leftInset - rightInset);
	// 深色块内左右各 1 格内部 padding；去掉行首原有空格后重新对齐
	const text = stripBackgroundAnsi(line).replace(/^ +/, "");
	const innerPad = 2;
	const clipped = truncateToWidth(text, Math.max(0, contentWidth - innerPad), "");
	const pad = Math.max(0, contentWidth - innerPad - visibleWidth(clipped));
	const body = ` ${clipped}${" ".repeat(pad)} `;
	const stable = body.replace(/\x1b\[(?:0)?m/g, (reset) => reset + bgAnsi);
	const outerBg = typeof theme?.getBgAnsi === "function" ? String(theme.getBgAnsi(slot)) : "";
	const inset = (n: number) => (outerBg ? `${outerBg}${" ".repeat(n)}\x1b[49m` : " ".repeat(n));
	return `${inset(leftInset)}${bgAnsi}${stable}\x1b[49m${inset(rightInset)}`;
}
/** edit/write 展开卡：按这张工具卡自己的状态取底色，不应用工具卡深色/间距改动。 */
export function editWriteExpandedCard(theme: any, component: any): any {
	const slot = toolCardBgSlot(component);
	return new Box(
		1,
		1,
		typeof theme.bg === "function" ? (text: string) => theme.bg(slot, text) : undefined,
	);
}

/** compact 展开面板：外卡片保持展开卡背景；展开的 thinking 另包一层更深的
 *  内卡（自身 Box 背景与外卡同色，不区分会糊在一起），工具卡直接铺在外卡背景上。
 *  每个子卡前面补 1 行分隔（上一条已经是空行时不再补），子卡自带的首尾空行会被裁掉，
 *  避免与外卡/内卡 padding 叠出双空行（内联图片的占位行不裁，见 contentRowRange）。
 *  hits：子卡的行区间与命中目标（thinking 命中自身，工具命中 tool 组件），
 *  供展开后点击 hint。未开启 toolHits 时不映射工具，点击仍归外层面板。
 *  live=true：live 槽位用，不铺底色也不留上下空行，首行紧跟 `↳`、其余行缩进对齐
 *  （Claude Code 的 ⎿ 口径）。行的产出仍是一行对一行，hits 行号无需平移。
 */
export function layoutExpandedToolCard(
	theme: any,
	children: any[],
	width: number,
	paints?: string[][],
	toolHits = false,
	live = false,
): { lines: string[]; hits: Array<{ child: any; start: number; end: number }> } {
	const slot = aggregateToolCardBgSlot(children.map((child) => child?.__ccTool).filter(Boolean));
	const toolBgAnsi = darkenBgAnsi(theme, slot);
	// 展开面板外卡底色随组内工具状态聚合（与 default 模式分组卡同口径）：
	// 有一个失败用失败底色、没有失败但有进行中用进行中底色、全成功用成功底色。
	const outerSlot = slot;
	/** live 每行前面的标记宽度（首行 `↳ `，其余对齐空格）。 */
	const markerWidth = live ? 2 : 0;
	const innerWidth = Math.max(0, width - 2 - markerWidth);
	const lines: string[] = [];
	const hits: Array<{ child: any; start: number; end: number }> = [];
	const isThinkingPreview = (child: any) => typeof child?.setHintHovered === "function";
	let lastBlank = false;
	/** live 首行被吃掉的前导缩进：续行同步左移同样格数，保持块内相对对齐。 */
	let liveLead = 0;
	const pushRow = (raw: string) => {
		if (!live) {
			// 面板 pad 1 是唯一左边距：剥掉子行 collapsed 态自带的 1 格 lead，
			// 否则标题行偏到 2、↳ 行偏到 4，左右不再对称。
			const line = raw.replace(/^((?:\x1b\[[0-?]*[ -/]*[@-~])*) /, "$1");
			lines.push(paddedBackgroundRow(theme, outerSlot, line, width));
			return;
		}
		// 槽位里不重复展开入口（见 SLOT_HINT_PATTERNS）。
		const line = stripSlotHint(raw);
		// 工具卡行首带 SGR：ANSI 之后才是缩进空格。
		const head = line.match(/^((?:\x1b\[[0-9;]*m)*)( *)/);
		const ansi = head?.[1] ?? "";
		const spaces = head?.[2]?.length ?? 0;
		const first = lines.length === 0;
		if (first) liveLead = spaces;
		// 首行挂 muted 的 `↳`（与 default-mode 工具结果行同色）；续行按 liveLead 去缩进。
		// 两侧都保留行首 SGR：丢掉它整行会掉回终端默认前景色。
		const marker = first ? `${theme.fg("muted", "↳")} ` : "  ";
		const lead = first ? spaces : Math.min(spaces, liveLead);
		lines.push(
			`${marker}${ansi}${truncateToWidth(line.slice(ansi.length + lead), innerWidth, "")}`,
		);
	};
	const pushBlank = () => {
		if (live || lastBlank) return;
		lines.push(paddedBackgroundRow(theme, outerSlot, "", width));
		lastBlank = true;
	};
	for (let childIndex = 0; childIndex < children.length; childIndex++) {
		const child = children[childIndex];
		const painted = paints?.[childIndex];
		const childLines = Array.isArray(painted) ? painted : child.render(innerWidth);
		const innerCard = !live && isThinkingPreview(child) && child.expanded === true;
		// 内联图片按 placement 把范围撑开：锚点前后的空行是图片占的位置，不能当首尾空行裁。
		const { first, last } = contentRowRange(childLines);
		if (first < 0) {
			if (live) continue;
			for (const line of childLines) {
				lines.push(paddedBackgroundRow(theme, outerSlot, line, width));
				lastBlank = !hasVisibleText(line);
			}
			continue;
		}
		if (!innerCard) pushBlank();
		const rangeStart = lines.length;
		// 展开的 thinking 走深色内卡（上下各 1 行 padding），工具卡直接铺在外卡上。
		const paintRow = innerCard
			? (line: string) => lines.push(toolCardBgRow(theme, slot, toolBgAnsi, line, width))
			: pushRow;
		if (innerCard) paintRow("");
		for (let i = first; i <= last; i++) paintRow(childLines[i]);
		if (innerCard) paintRow("");
		// 内卡的下 padding 不能当分隔：后面的子卡要再留 1 行外卡空行。
		lastBlank = false;
		// thinking 命中自身；工具在展开卡内需要能二次展开时才映射回 tool 组件。
		if (isThinkingPreview(child)) hits.push({ child, start: rangeStart, end: lines.length });
		else if (toolHits && child.__ccTool) {
			hits.push({ child: child.__ccTool, start: rangeStart, end: lines.length });
		}
	}
	pushBlank();
	return { lines, hits };
}

export function compactRoundCard(
	cardItems: Array<{ child?: any; tool?: any }>,
	toolRender: (tool: any, width: number) => string[],
	/** true 时卡内工具行归 tool 组件，可点击二次展开（整回合展开卡）。 */
	toolHits = false,
	/** true 时走 live 槽位排布：不留空行、首行紧跟 `↳`。 */
	live = false,
): any {
	const children: any[] = [];
	for (const item of cardItems) {
		if (item.child) children.push(item.child);
		else if (item.tool) {
			const tool = item.tool;
			children.push({
				__ccToolCard: true,
				__ccTool: tool,
				render: (innerWidth: number) => toolRender(tool, innerWidth),
				invalidate: () => tool.invalidate?.(),
			});
		}
	}
	/** 子块可用宽度：live 还要让出首行 `↳ ` 的标记位。 */
	const contentWidth = (width: number) => Math.max(0, width - 2 - (live ? 2 : 0));
	let paint:
		| {
				width: number;
				theme: unknown;
				/** 背景槽位也是面板行的输入：改配置后不能复用旧底色的整卡。 */
				bgSlot: string;
				paints: unknown[];
				lines: string[];
				hits: Array<{ child: any; start: number; end: number }>;
		  }
		| undefined;
	const layout = (width: number) => {
		const theme = themeOf();
		// 与 default 模式分组卡同口径：外卡底色随组内工具聚合，子卡状态变了要重绘。
		const bgSlot = aggregateToolCardBgSlot(
			children.map((child) => child?.__ccTool).filter(Boolean),
		);
		const innerWidth = contentWidth(width);
		const paints = children.map((child) => {
			const lines = child.render?.(innerWidth);
			return Array.isArray(lines) ? lines : [];
		});
		if (
			paint &&
			paint.width === width &&
			paint.theme === theme &&
			paint.bgSlot === bgSlot &&
			paint.paints.length === paints.length &&
			paint.paints.every((item, index) => item === paints[index])
		) {
			return paint;
		}
		const laid = layoutExpandedToolCard(theme, children, width, paints, toolHits, live);
		paint = {
			width,
			theme,
			bgSlot,
			paints,
			lines: laid.lines,
			hits: laid.hits,
		};
		return paint;
	};
	return {
		children,
		render(width: number): string[] {
			return layout(width).lines;
		},
		childAtRow(localRow: number, width: number) {
			for (const hit of layout(width).hits) {
				if (localRow >= hit.start && localRow < hit.end) return hit.child;
			}
			return null;
		},
		invalidate() {
			paint = undefined;
			for (const child of children) child.invalidate?.();
		},
	};
}

/** 展开入口的动作词：我们的 `click to show more`、pi 的 `<key> to expand`（键名可能取不到）。 */
const EXPAND_ACTION = String.raw`(?:click to show more|(?:[\w/+]+\s+)?to (?:show more|expand))`;

/**
 * 展开入口只挂在行尾：正则只看行尾这一段，单行代价与行长无关。
 * 图片负载（kitty 图形数据的 Base64）一行可达数百 KB，整行过正则会拖住渲染帧。
 */
const SLOT_HINT_WINDOW = 200;
/** 窗口里出现这些词才可能有展开入口，其余行（负载、代码）直接放过正则。 */
const SLOT_HINT_MARKERS = ["to expand", "to show more"];

const SLOT_HINT_PATTERNS: RegExp[] = [
	// 卡在括号里：`(9 more lines, click to show more)` / `(195 earlier lines, ctrl+o to expand)`，
	// 只去掉动作词，收尾括号与计数保留。
	new RegExp(String.raw`,\s*[^()]*?${EXPAND_ACTION}(?=\))`),
	// 直接挂在行尾：整段去掉。
	// 尾部分隔点：ccstyle 统一 `·`，同时兼容旧帧与 pi 原生的 `•`
	new RegExp(String.raw`\s*(?:[•·]\s*)?${EXPAND_ACTION}\s*$`),
];

/** 导出供单测：窗口边界与键名长度是性能与裁剪行为的关键，需要逐条钉住。 */
export function stripSlotHint(line: string): string {
	// 切点可能落在转义序列中间，残片只当作窗口头部文本；两个模式都锚在行尾，不受影响。
	const head = line.slice(0, Math.max(0, line.length - SLOT_HINT_WINDOW));
	const tail = line.slice(head.length);
	const plain = stripTerminalSequencesPreservingLayout(tail);
	if (!SLOT_HINT_MARKERS.some((marker) => plain.includes(marker))) return line;
	for (const re of SLOT_HINT_PATTERNS) {
		const match = re.exec(plain);
		if (!match) continue;
		// 删除区间而非截断后拼纯文本：收尾括号留在原样式里（dim），不会掉回默认前景色。
		return head + removeStyledRange(tail, match.index, match.index + match[0].length);
	}
	return line;
}
