import {
	CustomMessageComponent,
	ExtensionRunner,
	type MessageRenderer,
} from "@earendil-works/pi-coding-agent";
import {
	Box,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
} from "@earendil-works/pi-tui";
import { config } from "../../config/config.ts";
import { walkComponentTree } from "../../utils/component-tree.ts";
import {
	patchRegistry,
	PROTOTYPE_ORIGINAL_KEY,
	SUBAGENT_NOTIFICATION_RENDERER_PATCH as RENDERER_PATCH_KEY,
} from "../../utils/patch-keys.ts";
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

/** 每行折进 width，空行原样保留；已折过的行不变。Box 不折也不截超宽行，分组面板只截不折，先在这里折好。 */
function wrapRows(rows: string[], width: number): string[] {
	return rows.flatMap((row) => (row ? wrapTextWithAnsi(row, Math.max(1, width)) : [""]));
}

function statusIcon(subagent: FinishedSubagent, fg: Fg): string {
	return subagent.failed ? fg("error", "✗") : fg("success", "✓");
}

/**
 * 鼠标层单独展开/收起这一行的状态，按消息记：CustomMessageComponent 每次重建（invalidate、
 * 换主题）都会重新调用渲染器，状态不能只放在视图实例上。记下当时的全局状态（Ctrl+O 等经
 * CustomMessageComponent.setExpanded 传进来的 options.expanded），全局状态一变就作废，
 * 以最后一次操作为准。
 */
const localExpansion = new WeakMap<object, { base: boolean; expanded: boolean }>();

function resolveExpanded(message: object, base: boolean): boolean {
	const local = localExpansion.get(message);
	if (local?.base === base) return local.expanded;
	localExpansion.delete(message);
	return base;
}

class FinishedSubagentView implements Component {
	private readonly message: object;
	private readonly subagents: FinishedSubagent[];
	private readonly theme: any;
	private readonly fg: Fg;
	private readonly pad: number;
	private readonly base: boolean;
	private _expanded: boolean;
	/** fullscreen 悬停在展开提示上（鼠标层经 setHintHovered 设置），提示文字提亮。 */
	private hintHovered = false;

	constructor(message: object, theme: any, pad: number, base: boolean) {
		this.message = message;
		this.subagents = messageSubagents(message);
		this.theme = theme;
		this.fg = (color, value) => theme.fg(color, value);
		this.pad = pad;
		this.base = base;
		this._expanded = resolveExpanded(message, base);
	}

	get expanded(): boolean {
		return this._expanded;
	}

	/** 鼠标层的单击展开/收起（与消息卡同一条路径）。 */
	setExpanded(expanded: boolean): void {
		this._expanded = expanded;
		localExpansion.set(this.message, { base: this.base, expanded });
	}

	render(width: number): string[] {
		return this._expanded ? this.renderExpanded(width) : this.renderCollapsed(width);
	}

	private renderCollapsed(width: number): string[] {
		const fg = this.fg;
		const rowWidth = toolViewportWidth(width);
		const indent = " ".repeat(this.pad);
		const hint = ` ${fg("dim", "·")} ${fg(this.hintHovered ? "text" : "dim", showMoreHintText())}`;
		const last = this.subagents.length - 1;
		return this.subagents.map((subagent, index) => {
			const prefix = `${indent}${statusIcon(subagent, fg)} `;
			const tail = index === last ? hint : "";
			const room = Math.max(0, rowWidth - visibleWidth(prefix) - visibleWidth(tail));
			// 窄到放不下提示时连提示一起截（与分组卡一致），Ctrl+O 仍能展开。
			return truncateToWidth(
				`${prefix}${subagentSummary(subagent, room, fg)}${tail}`,
				rowWidth,
				"",
			);
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
			// 标题、状态与小标题也折进内宽。
			render: (inner: number) =>
				wrapRows(
					subagents.flatMap((subagent, index) => [
						...(index ? [""] : []),
						`${statusIcon(subagent, fg)} ${subagentTitle(subagent, fg)}`,
						...subagentDetailRows(subagent, inner, fg),
					]),
					inner,
				),
			invalidate() {},
		});
		return box.render(width);
	}

	setHintHovered(hovered: boolean): void {
		this.hintHovered = hovered;
	}

	invalidate(): void {}
}

/**
 * 单独出现的 subagent 通知行。鼠标层把它当消息卡：悬停提示提亮、单击提示展开、
 * 单击展开卡收起，都经 expanded / setExpanded / setHintHovered 这几个钩子。
 */
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

type RendererLookup = (this: unknown, customType: string) => MessageRenderer | undefined;

type RendererLookupPatch = {
	active: boolean;
	/** 按当前 mode 画一条通知；upstream 是原查找结果。 */
	render(
		upstream: MessageRenderer | undefined,
		...args: Parameters<MessageRenderer>
	): Component | undefined;
	dispose(): void;
};

/**
 * CustomMessageComponent 存下查找结果，每次 rebuild 都重新调它：mode 在调用时才看，
 * 也不绑死发出它的补丁——/reload 后转给当前补丁（新模块的配置与渲染），补丁撤掉后回到原生。
 */
function modeAwareRenderer(upstream: MessageRenderer | undefined): MessageRenderer {
	const renderer: MessageRenderer = (message, options, theme) => {
		const patch = patchRegistry.get<RendererLookupPatch>(RENDERER_PATCH_KEY);
		return patch?.active
			? patch.render(upstream, message, options, theme)
			: upstream?.(message, options, theme);
	};
	(renderer as any)[RENDERER_PATCH_KEY] = true;
	return renderer;
}

/**
 * Pi 每种 customType 只用最先加载的扩展注册的渲染器（ExtensionRunner.getMessageRenderer）：
 * 注册争不过先加载的 pi-subagents，先加载时又会遮住它，off 就还原不了它的原生视图。
 * 所以不注册，改在查找处给 subagent-notification 换上按 mode 分派的渲染器：on/compact
 * 画本插件的结束行，off 交回原查找结果（pi-subagents 的渲染器；没有就返回 undefined，
 * 由 Pi 画通用卡片）。其他 customType 原样返回。返回 dispose（/reload 链安全）。
 */
export function installSubagentNotificationRenderer(): () => void {
	patchRegistry.get<RendererLookupPatch>(RENDERER_PATCH_KEY)?.dispose();
	const prototype = ExtensionRunner.prototype as any;
	let original: RendererLookup = prototype.getMessageRenderer;
	// 最外层还是失效的旧补丁（所有权槽已丢）就拆开，不在它外面再套一层；被别人包着的不动。
	while ((original as any)[RENDERER_PATCH_KEY] && (original as any)[PROTOTYPE_ORIGINAL_KEY]) {
		original = (original as any)[PROTOTYPE_ORIGINAL_KEY];
	}
	const installed: RendererLookup = function (this: unknown, customType) {
		const upstream = original.call(this, customType);
		if (!patch.active || customType !== SUBAGENT_NOTIFICATION_TYPE) return upstream;
		// 内层还有一个本插件补丁时它已经分派过了。
		return (upstream as any)?.[RENDERER_PATCH_KEY] ? upstream : modeAwareRenderer(upstream);
	};
	(installed as any)[RENDERER_PATCH_KEY] = true;
	(installed as any)[PROTOTYPE_ORIGINAL_KEY] = original;
	const patch: RendererLookupPatch = {
		active: true,
		render: (upstream, message, options, theme) =>
			config.mode === "off"
				? upstream?.(message, options, theme)
				: renderSubagentNotification(message, options, theme),
		dispose() {
			if (!patch.active) return;
			patch.active = false;
			// 被别人包在里面时撤不下来：留着失效直通，不动对方的包装。
			if (prototype.getMessageRenderer === installed) prototype.getMessageRenderer = original;
			patchRegistry.dispose(RENDERER_PATCH_KEY, patch);
		},
	};
	prototype.getMessageRenderer = installed;
	patchRegistry.install(RENDERER_PATCH_KEY, patch);
	return patch.dispose;
}

/**
 * 让已挂载的通知按当前 mode 重建（/ccstyle on|compact|off 切换后、session_start 之后）。
 * /reload 与 /resume 先重建 transcript 再发 session_start，那批卡存的是补丁装上前的
 * 原查找结果：补丁在位时给它们换上按 mode 分派的渲染器，原结果留作上游。
 */
export function refreshSubagentNotifications(root: unknown): void {
	const active = patchRegistry.get<RendererLookupPatch>(RENDERER_PATCH_KEY)?.active === true;
	walkComponentTree(root, (value) => {
		if (!isSubagentNotificationComponent(value)) return;
		if (active && !value.customRenderer?.[RENDERER_PATCH_KEY]) {
			value.customRenderer = modeAwareRenderer(value.customRenderer);
		}
		// CustomMessageComponent.invalidate 会 rebuild，重新调用渲染器。
		value.invalidate?.();
		return false;
	});
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
			// 首行接在 `├ ✓ ` 之后占 4 列，续行前缀（`│ `）占 2 列；分组只截不折，这里先折好。
			// 末尾空行把详情和下一项隔开。
			const room = Math.max(1, width - 2);
			const rows = [
				...wrapRows([subagentTitle(subagent, fg)], width - 4),
				...wrapRows(subagentDetailRows(subagent, room, fg), room),
				"",
			];
			cache = { width, theme, rows };
			return rows;
		},
		// 主题是稳定代理，换主题后身份不变：靠分组 invalidate 丢掉带旧颜色的行。
		invalidate() {
			cache = undefined;
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
