import { CustomMessageComponent, type MessageRenderer } from "@earendil-works/pi-coding-agent";
import {
	Box,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { sanitizeToolResultText } from "../../utils/tool-result-sanitize.ts";
import type { GroupDisplayItem } from "./grouping.ts";
import { showMoreHintText } from "./names.ts";
import { formatToolDuration, toolViewportWidth } from "./result.ts";
import { TOOL_CARD_BG_SLOT } from "./tool-state.ts";

/**
 * pi-subagents 的 `subagent-notification`：只换展示，不动消息本身。
 * agent 一停下（完成、到轮数上限收尾、被停、中止或出错）就发这条通知，所以标题
 * 不说「完成」，结局写在行里。单独出现时渲染为可展开的一行；挨着工具时由分组
 * 模块经显示适配器并入工具组。一条通知可能带多个 agent（`others`），每个 agent 一行。
 */

export const SUBAGENT_NOTIFICATION_TYPE = "subagent-notification";
const FINISHED_LABEL = "Subagent Finished";

type Fg = (color: string, text: string) => string;

/** 通知里一个 agent 的结束记录。payload 里每个字段都可能缺失，缺的就不显示。 */
type FinishedSubagent = {
	id: string;
	description: string;
	status: string;
	failed: boolean;
	stats: string[];
	/** pi-subagents 存下的结果预览，本身可能已被截断。 */
	resultPreview: string;
	error: string;
	/** 保存时的 transcript 路径，文件可能已不在。 */
	outputFile: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
	return typeof value === "string" ? sanitizeToolResultText(value).trim() : "";
}

/**
 * pi-subagents 拿不到的统计也照样写 0（turnCount 恒为 `?? 0`，未完成的 durationMs、
 * 没有定价的 totalCost 都是 0），payload 里分不出「测得 0」和「没测」，0 一律当缺失。
 */
function measured(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function plural(count: number, unit: string): string {
	return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

function formatTokens(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M token`;
	if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k token`;
	return `${count} token`;
}

/** 估算花费：带 `~`，一美元以下最多四位小数。 */
function formatCost(cost: number): string {
	if (cost < 0.0001) return "<$0.0001";
	if (cost >= 1) return `~$${cost.toFixed(2)}`;
	const rounded = Number(cost.toFixed(4));
	const decimals = (String(rounded).split(".")[1] ?? "").length;
	return `~$${rounded.toFixed(Math.max(2, decimals))}`;
}

function subagentStats(details: Record<string, unknown>): string[] {
	const stats: string[] = [];
	const turns = measured(details.turnCount);
	if (turns) stats.push(plural(turns, "turn"));
	const toolUses = measured(details.toolUses);
	if (toolUses) stats.push(plural(toolUses, "tool use"));
	const tokens = measured(details.totalTokens);
	if (tokens) stats.push(formatTokens(tokens));
	const cost = measured(details.totalCost);
	if (cost) stats.push(formatCost(cost));
	const duration = measured(details.durationMs);
	if (duration) stats.push(formatToolDuration(duration));
	return stats;
}

const FAILED_STATUSES = new Set(["error", "stopped", "aborted"]);

function toFinishedSubagent(details: Record<string, unknown>): FinishedSubagent {
	const status = text(details.status);
	const error = text(details.error);
	return {
		id: text(details.id),
		description: text(details.description),
		status,
		// 没有 status 时只能看有没有错误正文；有 status 就以它为准。
		failed: status ? FAILED_STATUSES.has(status) : Boolean(error),
		stats: subagentStats(details),
		resultPreview: text(details.resultPreview),
		error,
		outputFile: text(details.outputFile),
	};
}

/** 通知里的全部 agent：首个 + `others`。details 缺失时仍是一行没有附加信息的结束行。 */
function finishedSubagents(details: unknown): FinishedSubagent[] {
	const first = isRecord(details) ? details : {};
	const others = Array.isArray(first.others) ? first.others.filter(isRecord) : [];
	return [first, ...others].map(toFinishedSubagent);
}

/** 通知消息不会再变：按消息对象解析一次，分组每帧拿到的是同一批记录。 */
const subagentsByMessage = new WeakMap<object, FinishedSubagent[]>();

function messageSubagents(message: any): FinishedSubagent[] {
	if (!message || typeof message !== "object") return finishedSubagents(undefined);
	let subagents = subagentsByMessage.get(message);
	if (!subagents) {
		subagents = finishedSubagents(message.details);
		subagentsByMessage.set(message, subagents);
	}
	return subagents;
}

/**
 * 结局的叫法，与 pi-subagents 自己的渲染器一致。steered 是到了轮数软上限、被要求收尾后
 * 按时结束（不是 steer_subagent），算完成，但输出可能不全。
 */
function outcomeText(status: string): string {
	return status === "steered" ? "completed (steered)" : status;
}

function subagentTitle(subagent: FinishedSubagent, fg: Fg): string {
	return subagent.id
		? `${fg("toolTitle", FINISHED_LABEL)} ${fg("muted", subagent.id)}`
		: fg("toolTitle", FINISHED_LABEL);
}

/**
 * 折叠行正文（不含状态图标）：标题 + agent id + 结局 + 可用统计。单独行与分组行共用。
 * 普通完成不写结局（✓ 已经说明）；没有 status 时也不写。
 */
function subagentSummary(subagent: FinishedSubagent, width: number, fg: Fg): string {
	const outcome =
		subagent.status && subagent.status !== "completed"
			? ` ${fg("dim", "·")} ${fg(subagent.failed ? "error" : "warning", outcomeText(subagent.status))}`
			: "";
	const stats = subagent.stats.map((stat) => ` ${fg("dim", "·")} ${fg("dim", stat)}`).join("");
	return truncateToWidth(`${subagentTitle(subagent, fg)}${outcome}${stats}`, width, "…");
}

const DETAIL_INDENT = "  ";

/** 一段正文：保留原有换行，超宽折行，每行带缩进。 */
function detailBlock(value: string, width: number, color: string, fg: Fg): string[] {
	const room = Math.max(1, width - DETAIL_INDENT.length);
	return value
		.split("\n")
		.flatMap((line) => (line ? wrapTextWithAnsi(line, room) : [""]))
		.map((line) => (line ? `${DETAIL_INDENT}${fg(color, line)}` : ""));
}

function detailSection(heading: string, value: string, width: number, color: string, fg: Fg) {
	return ["", `${DETAIL_INDENT}${fg("muted", heading)}`, ...detailBlock(value, width, color, fg)];
}

/**
 * 展开详情（标题行之后的部分）：说明、状态、统计、结果预览、错误、transcript。
 * 只展示保存下来的内容：不调用工具、不读 transcript 文件。
 */
function subagentDetailRows(subagent: FinishedSubagent, width: number, fg: Fg): string[] {
	const rows: string[] = [];
	if (subagent.description) rows.push(...detailBlock(subagent.description, width, "text", fg));
	if (subagent.status) {
		const color = subagent.failed ? "error" : "dim";
		rows.push(`${DETAIL_INDENT}${fg("dim", "Status:")} ${fg(color, outcomeText(subagent.status))}`);
	}
	if (subagent.stats.length) {
		rows.push(...detailBlock(subagent.stats.join(" · "), width, "dim", fg));
	}
	if (subagent.resultPreview) {
		rows.push(
			...detailSection("Saved result preview", subagent.resultPreview, width, "toolOutput", fg),
		);
	}
	if (subagent.error) rows.push(...detailSection("Error", subagent.error, width, "error", fg));
	if (subagent.outputFile) {
		rows.push(...detailSection("Transcript", subagent.outputFile, width, "dim", fg));
	}
	return rows;
}

function statusIcon(subagent: FinishedSubagent, fg: Fg): string {
	return subagent.failed ? fg("error", "✗") : fg("success", "✓");
}

/**
 * 单击切换的展开状态，按消息记：CustomMessageComponent 每次重建（invalidate、换主题）都会
 * 重新调用渲染器，状态不能只放在视图实例上。记下单击时的全局状态（Ctrl+O 等经
 * setExpanded 传进来的 options.expanded），全局状态一变就作废，以最后一次操作为准。
 */
const clickExpansion = new WeakMap<object, { base: boolean; expanded: boolean }>();

function resolveExpanded(message: object, base: boolean): boolean {
	const local = clickExpansion.get(message);
	if (local?.base === base) return local.expanded;
	clickExpansion.delete(message);
	return base;
}

type HintBox = { row: number; start: number; end: number };

class FinishedSubagentView implements Component {
	private readonly message: object;
	private readonly subagents: FinishedSubagent[];
	private readonly theme: any;
	private readonly fg: Fg;
	private readonly pad: number;
	private readonly base: boolean;
	private expanded: boolean;
	/** 折叠行里展开提示的列区间（0-based，左闭右开）：fullscreen 单击只认这一段。 */
	private hintBox: HintBox | undefined;
	/** fullscreen 悬停在展开提示上（鼠标层经 setHintHovered 设置），提示文字提亮。 */
	private hintHovered = false;

	constructor(message: object, theme: any, pad: number, base: boolean) {
		this.message = message;
		this.subagents = messageSubagents(message);
		this.theme = theme;
		this.fg = (color, value) => theme.fg(color, value);
		this.pad = pad;
		this.base = base;
		this.expanded = resolveExpanded(message, base);
	}

	render(width: number): string[] {
		return this.expanded ? this.renderExpanded(width) : this.renderCollapsed(width);
	}

	private renderCollapsed(width: number): string[] {
		const fg = this.fg;
		const rowWidth = toolViewportWidth(width);
		const indent = " ".repeat(this.pad);
		const hintText = showMoreHintText();
		const hint = ` ${fg("dim", "·")} ${fg(this.hintHovered ? "text" : "dim", hintText)}`;
		const last = this.subagents.length - 1;
		return this.subagents.map((subagent, index) => {
			const prefix = `${indent}${statusIcon(subagent, fg)} `;
			const tail = index === last ? hint : "";
			const room = Math.max(0, rowWidth - visibleWidth(prefix) - visibleWidth(tail));
			const line = `${prefix}${subagentSummary(subagent, room, fg)}${tail}`;
			if (index === last) {
				const end = visibleWidth(line);
				this.hintBox = { row: index, start: end - visibleWidth(hintText), end };
			}
			return line;
		});
	}

	/** 展开卡：与工具展开卡同一套底色，有一个 agent 失败就整卡用失败底色。 */
	private renderExpanded(width: number): string[] {
		const fg = this.fg;
		const failed = this.subagents.some((subagent) => subagent.failed);
		const slot = TOOL_CARD_BG_SLOT[failed ? "error" : "success"];
		const box = new Box(this.pad, 1, (line) => this.theme.bg(slot, line));
		const subagents = this.subagents;
		box.addChild({
			render: (inner: number) =>
				subagents.flatMap((subagent, index) => [
					...(index ? [""] : []),
					`${statusIcon(subagent, fg)} ${subagentTitle(subagent, fg)}`,
					...subagentDetailRows(subagent, inner, fg),
				]),
			invalidate() {},
		});
		return box.render(width);
	}

	/**
	 * fullscreen 单击：折叠时只有展开提示可点（同一行正文留给选区），展开卡整卡单击收起。
	 * 只认 click：拖动选择不会合成 click，不会误收起。
	 */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left") return undefined;
		if (!this.expanded) {
			const box = this.hintBox;
			if (!box || event.y !== box.row || event.x < box.start || event.x >= box.end) {
				return undefined;
			}
		}
		this.expanded = !this.expanded;
		clickExpansion.set(this.message, { base: this.base, expanded: this.expanded });
		return { handled: true };
	}

	setHintHovered(hovered: boolean): void {
		this.hintHovered = hovered;
	}

	invalidate(): void {}
}

/** 单独出现的 subagent 通知行：fullscreen 鼠标层据此做提示悬停高亮。 */
export function isSubagentNotificationView(value: unknown): boolean {
	return value instanceof FinishedSubagentView;
}

/** `subagent-notification` 的消息渲染器：单独出现时的结束行。 */
export const renderSubagentNotification: MessageRenderer = (message, options, theme) =>
	new FinishedSubagentView(message, theme, Math.max(0, options.outputPad), options.expanded);

/** 挂在 transcript 上的 subagent 通知（Pi 的 CustomMessageComponent）。 */
export function isSubagentNotificationComponent(value: unknown): boolean {
	return (
		value instanceof CustomMessageComponent &&
		(value as any).message?.customType === SUBAGENT_NOTIFICATION_TYPE
	);
}

function themeFg(theme: any): Fg {
	return (color, value) => theme?.fg?.(color, value) ?? value;
}

type ExpandedRowsCache = { width: number; theme: unknown; rows: string[] };

function subagentItem(subagent: FinishedSubagent): GroupDisplayItem {
	let cache: ExpandedRowsCache | undefined;
	return {
		name: SUBAGENT_NOTIFICATION_TYPE,
		label: FINISHED_LABEL,
		status: subagent.failed ? "error" : "success",
		summary: (width, theme) => subagentSummary(subagent, width, themeFg(theme)),
		expandedRows(width, theme) {
			if (cache?.width === width && cache.theme === theme) return cache.rows;
			const fg = themeFg(theme);
			// 续行前缀（`│ `）占 2 列；末尾空行把详情和下一项隔开。
			const rows = [
				subagentTitle(subagent, fg),
				...subagentDetailRows(subagent, Math.max(1, width - 2), fg),
				"",
			];
			cache = { width, theme, rows };
			return rows;
		},
	};
}

const itemsBySubagents = new WeakMap<FinishedSubagent[], GroupDisplayItem[]>();

/**
 * 显示适配器：分组里每个 agent 是一项（计入组头计数，但不是工具执行，不重复统计用量）。
 * 不是 subagent 通知时返回 undefined。
 */
export function subagentNotificationItems(component: unknown): GroupDisplayItem[] | undefined {
	if (!isSubagentNotificationComponent(component)) return undefined;
	const subagents = messageSubagents((component as any).message);
	let items = itemsBySubagents.get(subagents);
	if (!items) {
		items = subagents.map(subagentItem);
		itemsBySubagents.set(subagents, items);
	}
	return items;
}
