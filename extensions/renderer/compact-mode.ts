/**
 * Compact mode：每条含 toolCall 的 assistant message 折叠为一条逐步累加的摘要行
 * （`Ran for 8s, bash×2, read×2`），edit/write 独立标题行（`✓ write <path> (+25 -0)`），
 * 普通工具折叠时不显示独立行；展开（Ctrl+O / fullscreen 点击）时助手文本按原生渲染，
 * thinking 与工具卡装进按状态着色的面板（卡内恢复 compact-thinking/Pi 原生或专用
 * renderer）。edit/write 复用 mode=on 的 rich diff
 * 与 `editDiffCollapsedLines` / `writeDiffCollapsedLines` / `expandedPreviewMaxLines`。
 * Agent/Task 族：调用只进摘要计数，tool 卡始终折叠（避免 pending→完成高度闪动）。
 * edit/write 与 ask_user_question 留在外层：不进摘要计数，折叠态也单独成行。
 * 外层行一旦在消息里出现，当前回合就地完结（不计静默期），后续消息另起回合：
 * 摘要行因此只折叠连续的一段工具调用，展开/收起不再跨外层行搬位置。
 * 用户消息是回合的硬边界：steer 消息插进回合中间、或上一回合没正文就收尾时，回合
 * 就地收口、后续消息另起一回合。custom 通知/summary 类组件既不是成员也不算外来行，
 * 原地留在两段之间，不打断统计也不被挪位。
 * 底部 Agents/Tasks 面板由 pi-subagents/pi-tasks 独立 widget 负责，不经 tool 卡外置。
 *
 * live 围观态（回合进行中 / 收尾静默期）：正文跟折叠态同形；摘要行与单一槽位卡
 * （`↳` + 最新的一个块：仍在增长的思考预览，或本回合最近的工具，运行中优先）挂在
 * transcript 容器的回合末尾（尾行组件，anchor 与工具卡之后、下一消息之前）。
 * 思考原地增长不轮换，只有新的思考块或工具调用进来才换槽位内容。
 * 摘要行挂末尾是刻意的：运行中它恒在可写视口底缘，收尾时原地从 Running... 翻成
 * Ran for 真实落进 scrollback；放在 anchor 内部则会被工具/diff 顶出视口后定格。
 * （anchor 未挂载进容器的独立渲染场景退回组件内旧行为。）
 *
 * 工具计数：read 按非空路径去重、其余按调用计数（首次出现顺序）；edit/write 不进摘要。
 * 时长 = 回合流逝挂钟；进行中 Running...，结束 Ran for。
 * abort/error/length 状态行挂在摘要外层，避免被折叠吞掉。
 * 最终 agent 回合摘要由 feature/agent-summary 独占（bash/read/edit/write/other）。
 *
 * 补丁生命周期遵循仓库既有模式：Symbol 所有权、dispose 仅恢复仍由本安装持有的
 * 方法、重入守卫防止 /reload 后残留闭包递归。
 */
import {
	AssistantMessageComponent,
	CustomMessageComponent,
	SkillInvocationMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Spacer } from "@earendil-works/pi-tui";
import { getAssistantMessagePrototype, getToolExecutionPrototype } from "../compat/pi-internals.ts";
import { config } from "../config/config.ts";
import { subscribeTicker } from "../feature/shell/spinner-ticker.ts";
import { walkComponentTree } from "../utils/component-tree.ts";
import {
	ASSISTANT_REENTRY_KEY,
	ASSISTANT_SET_EXPANDED_KEY,
	ASSISTANT_TOGGLE_ROUND_KEY,
	COMPACT_MODE_PATCH_KEY,
	COMPACT_THINKING_PATCH_KEY,
	PATCH_NAME_KEY,
	PROTOTYPE_ORIGINAL_KEY,
	patchRegistry,
	TOOL_GROUPING_PARENT_KEY,
} from "../utils/patch-keys.ts";
import { compactRoundCard } from "./compact-card.ts";
import {
	appendStopStatus,
	compactAssistantLineComponent,
	compactLiveSlot,
} from "./compact-live.ts";
import {
	buildMessagesSummary,
	type CompactThinkingQuery,
	EDIT_WRITE_TOOLS,
	messageStopStatus,
	OUTER_TOOLS,
	roundStopStatus,
} from "./compact-summary.ts";
import { compactEditWriteLines } from "./compact-tool-lines.ts";
import { getToolMouseTui } from "./mouse/scroll.ts";
import type { WriteExecutionMetadataStore } from "./tool/diff/write-execution.ts";
import { isLiveToolCall, scheduleAnimation } from "./tool/tool-state.ts";
import { refreshTranscriptComponent } from "./transcript-refresh.ts";

export { stripSlotHint } from "./compact-card.ts";
export type { CompactThinkingQuery } from "./compact-summary.ts";
export {
	animateCompactThinkingText,
	buildMessageSummary,
	formatThoughtDuration,
	messageStopStatus,
	styleCompactThinkingText,
} from "./compact-summary.ts";

/** Pi 的 native 组件与扩展可能各持一份 pi-tui，Spacer 不能只靠 instanceof 判。 */
function isSpacerComponent(value: any): boolean {
	return value instanceof Spacer || value?.constructor?.name === "Spacer";
}

/**
 * 回合收尾后延迟收拢的静默期（ms）。正文 token 往往先于 toolCall 到达，
 * 立刻收拢会得到「先收再开」两次转场；静默期内被新回合接替则一并收拢。
 */
const FOLD_SETTLE_MS = 250;

function isAssistantComponent(value: any): boolean {
	return value instanceof AssistantMessageComponent;
}

function isToolComponent(value: any): boolean {
	return value instanceof ToolExecutionComponent;
}

/** 成员离开回合后不再算外层面板，避免点别的卡时被跳过收起。 */
function clearRoundAnchor(component: any): void {
	if (!component || Object.getOwnPropertyDescriptor(component, "roundAnchor")?.get) return;
	delete component.roundAnchor;
}

function detachAssistantExpansion(component: any): void {
	if (
		typeof component?.[ASSISTANT_SET_EXPANDED_KEY] !== "function" ||
		component.setExpanded !== component[ASSISTANT_SET_EXPANDED_KEY]
	) {
		return;
	}
	delete component.setExpanded;
	delete component[ASSISTANT_SET_EXPANDED_KEY];
	delete component[ASSISTANT_TOGGLE_ROUND_KEY];
	delete component[ASSISTANT_REENTRY_KEY];
	clearRoundAnchor(component);
}

/** 供 mouse-interaction 识别可点击的 compact assistant 行（仅 compact 模式下生效）。 */
export function isCompactAssistantComponent(value: unknown): boolean {
	if (config.mode !== "compact" || !value || typeof value !== "object") return false;
	const component = value as any;
	return (
		typeof component[ASSISTANT_SET_EXPANDED_KEY] === "function" &&
		component.setExpanded === component[ASSISTANT_SET_EXPANDED_KEY]
	);
}

export type CompactModeHooks = {
	/** 会话事件后同步：所有权、全局展开状态、已挂载组件。 */
	sync(ctx: any): void;
	/** 重绘所有被跟踪的 assistant/tool 组件（模式切换用）。 */
	refresh(): void;
	/** compact 模式下重新认领 assistant patch（位于 compact-thinking 之上）。 */
	assertOwnership(): void;
	/** 重新渲染包含指定 toolCallId 的 assistant 消息（思考收尾时刷新）。 */
	refreshToolCallMessage(toolCallId: string | undefined): void;
	/**
	 * 会话已空闲时收尾末尾回合。回放/切换样式/重载重建之后，末尾那条消息
	 * 后面没有消息来收口；活性只问会话，不从消息形状推断。
	 */
	settleIdleRound(): void;
	/** agent 这轮跑完：收尾仍在 live 的末尾回合，别让它一直挂着 Running。 */
	settleFinishedRound(): void;
	shutdown(): void;
};

type CompactModeInstallDeps = {
	query?: CompactThinkingQuery;
	writeMetadata: WriteExecutionMetadataStore;
	/** 会话是否空闲；测试注入用，正式路径取 ctx.isIdle。 */
	isIdle?: () => boolean;
};

type CompactModePatch = {
	active: boolean;
	prototype: any;
	assistantInstalled: (...args: any[]) => any;
	assistantOriginal: (...args: any[]) => any;
	assistantNative: (...args: any[]) => any;
	toolInstalledRender: (width: number) => string[];
	toolInstalledUpdateDisplay: () => void;
	toolOriginalRender: (width: number) => string[];
	toolOriginalUpdateDisplay: () => void;
	assertAssistantOwnership: () => void;
	dispose: () => void;
};

const trackedAssistantComponents = new Set<any>();
const trackedToolComponents = new Set<any>();
let hoveredAssistantComponent: any;

/**
 * 回合尾行记录：摘要行（live 时连槽位卡）挂成 transcript 容器里回合末尾的
 * 兄弟组件，而不是 anchor 内部。anchor 内部的可变内容一旦被工具/diff 顶出视口
 * 就再也写不进 scrollback（regular 主屏只能差分可视区），运行态 Running 会永久
 * 定格在挤出前最后一帧；尾行恒在可写底缘，收尾的 Ran for 才真实落进历史。
 * 模块级持有（与 trackedAssistantComponents 同理）：跨 /reload 去重与清理。
 */
type MountedRoundTail = {
	host: any;
	container: any;
	parts: any[];
	round: any;
};
const tailByAnchor = new WeakMap<object, MountedRoundTail>();
const mountedTails = new Set<MountedRoundTail>();

export function setHoveredCompactAssistant(component: any): boolean {
	if (hoveredAssistantComponent === component) return false;
	hoveredAssistantComponent = component;
	return true;
}

/**
 * 整回合展开卡内的工具被点击展开时调用：让 compact 的强制折叠放行这一个，
 * 并把同一回合里其他展开的工具收回去（保持单开）。非 round 内工具是空操作。
 */
let roundToolExpansion: { markUserExpanded(tool: any): void } | undefined;

export function markCompactRoundToolExpanded(tool: any): void {
	roundToolExpansion?.markUserExpanded(tool);
}

/**
 * 展开面板前的分隔空行与面板绑成一体：挂在同一尾行上，才不会被拆到
 * anchor 正文之后（面板挂回合尾行，空行却留在消息里）。
 * 带 childAtRow 返回 null：拆分判据认它为面板成员，行命中落空时归外层面板。
 */
function panelBoundSpacer(): any {
	return {
		render: () => [""],
		childAtRow: () => null,
		invalidate() {},
	};
}

/** 面板展开前的视口标记：收起时需要重钉视口的卡。 */
const panelViewportBeforeExpand = new WeakSet<object>();

function capturePanelViewport(card: any): void {
	if (!card) return;
	panelViewportBeforeExpand.add(card);
}

function restorePanelViewport(card: any): void {
	if (!panelViewportBeforeExpand.delete(card)) return;
	const view = getToolMouseTui()?.getPrimaryScrollView?.();
	if (!view) return;
	// 不用展开前的快照：展开期间用户可能滚进面板里，回跳旧位置才是"跳"。
	// 面板在摘要行之下，收起只删它以下的行，保持当前 scrollTop 摘要行原地不动；
	// clamp 后落在新底时 scrollTo 会自动恢复 followingEnd（并清 followSuppressedAtEnd）。
	if (typeof view.scrollTo === "function" && typeof view.scrollTop === "number") {
		view.scrollTo(view.scrollTop);
	}
}

function ensureAssistantSetExpanded(component: any): void {
	if (
		typeof component[ASSISTANT_SET_EXPANDED_KEY] === "function" &&
		component.setExpanded === component[ASSISTANT_SET_EXPANDED_KEY]
	) {
		return;
	}
	if (typeof component.setExpanded === "function") {
		detachAssistantExpansion(component);
		if (typeof component.setExpanded === "function") return;
	}
	const installed = function (this: any, expanded: boolean) {
		if (config.mode !== "compact") {
			detachAssistantExpansion(this);
			return;
		}
		const toggleRound = this[ASSISTANT_TOGGLE_ROUND_KEY];
		if (typeof toggleRound === "function") {
			toggleRound(expanded);
			return;
		}
		this.expanded = expanded;
		if (typeof this.updateContent === "function" && this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	};
	component[ASSISTANT_SET_EXPANDED_KEY] = installed;
	component.setExpanded = installed;
}

function collectMountedComponents(root: any): void {
	if (!root || typeof root !== "object") return;
	const assistants = new Set<any>();
	const tools = new Set<any>();
	walkComponentTree(root, (value: any) => {
		if (isAssistantComponent(value)) {
			assistants.add(value);
			// 仅在 compact 模式给实例装 setExpanded，避免 on/off 下 Ctrl+O/mouse 回归。
			if (config.mode === "compact") ensureAssistantSetExpanded(value);
		} else if (isToolComponent(value)) {
			tools.add(value);
		}
	});
	// 扫到组件才替换跟踪表。面板/custom UI 打开时 root 往往扫不到 transcript，
	// 若此时清空会丢掉 live updateContent/updateDisplay 已登记的实例，
	// /ccstyle 切换就只能靠 /reload 重建。
	if (assistants.size > 0 || tools.size > 0) {
		trackedAssistantComponents.clear();
		trackedToolComponents.clear();
		for (const component of assistants) trackedAssistantComponents.add(component);
		for (const component of tools) trackedToolComponents.add(component);
	} else if (config.mode === "compact") {
		for (const component of trackedAssistantComponents) ensureAssistantSetExpanded(component);
	}
}

export function installCompactMode(deps: CompactModeInstallDeps): CompactModeHooks {
	const previous = patchRegistry.get<CompactModePatch>(COMPACT_MODE_PATCH_KEY);
	if (previous) previous.dispose();

	const assistantPrototype = getAssistantMessagePrototype();
	const toolPrototype = getToolExecutionPrototype();
	// Pi 内部接口缺失：整套 compact 补丁放弃安装，回退原生渲染。
	if (!assistantPrototype || !toolPrototype) {
		return {
			sync() {},
			refresh() {},
			assertOwnership() {},
			refreshToolCallMessage() {},
			settleIdleRound() {},
			settleFinishedRound() {},
			shutdown() {},
		};
	}
	const patch: CompactModePatch = {
		active: true,
		prototype: assistantPrototype,
		assistantInstalled: undefined as any,
		assistantOriginal: assistantPrototype.updateContent,
		assistantNative: assistantPrototype.updateContent,
		toolInstalledRender: undefined as any,
		toolInstalledUpdateDisplay: undefined as any,
		toolOriginalRender: toolPrototype.render,
		toolOriginalUpdateDisplay: toolPrototype.updateDisplay,
		assertAssistantOwnership: () => {},
		dispose: () => {},
	};

	const passThroughAssistant = (component: any, message: any, isStreaming?: boolean): any => {
		const self = component as any;
		if (self[ASSISTANT_REENTRY_KEY] === patch)
			return patch.assistantNative.call(component, message, isStreaming);
		self[ASSISTANT_REENTRY_KEY] = patch;
		try {
			return patch.assistantOriginal.call(component, message, isStreaming);
		} finally {
			delete self[ASSISTANT_REENTRY_KEY];
		}
	};

	type CompactRound = {
		anchor: any;
		messages: Map<any, any>;
		detachedMessages: any[];
		active: boolean;
		suppressedToolIds: Set<string>;
		/** live 槽位内联渲染的工具 id；回合结束时随槽位一起交还外层。 */
		liveSlotToolIds: Set<string>;
		/** 收尾后的静默期截止时间戳；期间仍按围观态渲染，到点才收拢。 */
		settleUntil?: number;
		/** 消息已有 toolCall、工具组件还没到：等它一 updateDisplay 就重画槽位。 */
		pendingLiveTool?: boolean;
		foldTimer?: ReturnType<typeof setTimeout>;
		/** 回合挂钟起点，保证 Running 时长连续递增。 */
		startedAt: number;
		/** 本进程看见回合的挂钟起点。消息 timestamp 不随工具执行前进。 */
		wallStartedAt: number;
		endedAt?: number;
		/** 回合尾行（摘要 + live 槽位），挂在 transcript 容器的回合末尾。 */
		tail?: MountedRoundTail;
	};
	let activeRound: CompactRound | undefined;
	let roundByComponent = new WeakMap<object, CompactRound>();
	/** 本 pass 建起的回合（含被收编的）：清扫孤儿尾行的在册名单。 */
	const liveRounds = new Set<CompactRound>();
	const expandedRoundToolIds = new Set<string>();
	/** 用户显式点开的 round 内工具；强制折叠不压回这些 id。 */
	const explicitRoundToolIds = new Set<string>();
	const liveSlotToolIds = new Set<string>();
	const pendingFoldRounds = new Set<CompactRound>();
	let uiRef: { requestRender?: (force?: boolean) => void } | undefined;
	let roundTickUnsubscribe: (() => void) | null = null;
	let lastRoundTickAt = 0;
	/** round 摘要秒级时钟 + Running 扫光节奏（250ms，自备 tick 改走共享时钟）。 */
	const ROUND_TICK_INTERVAL_MS = 250;
	let idleRef: (() => boolean) | undefined = deps.isIdle;

	/** 会话是否空闲：回合活性的事实来源，取不到就当没空闲（宁可保留 Running）。 */
	const sessionIdle = (): boolean => {
		try {
			return idleRef?.() === true;
		} catch {
			return false;
		}
	};

	const roundWallMs = (round: CompactRound): number => {
		const end = round.active ? Date.now() : (round.endedAt ?? Date.now());
		return Math.max(1, end - round.startedAt);
	};

	const summarize = (messages: Iterable<any>, runningActive?: boolean, round?: CompactRound) =>
		buildMessagesSummary(
			messages,
			deps.query,
			runningActive,
			round ? roundWallMs(round) : undefined,
		);

	const stopRoundTick = (): void => {
		roundTickUnsubscribe?.();
		roundTickUnsubscribe = null;
	};

	// 自备 tick：getter 在 render 重算挂钟；兼驱动 Running 扫光（setCompactSummaryActive）。
	// 走 90ms 共享时钟（累计满 250ms 行动一次），不再自建定时器。
	const ensureRoundTick = (): void => {
		if (roundTickUnsubscribe) return;
		lastRoundTickAt = Date.now();
		roundTickUnsubscribe = subscribeTicker(() => {
			if (!patch.active || !activeRound?.active) {
				stopRoundTick();
				return;
			}
			const now = Date.now();
			if (now - lastRoundTickAt < ROUND_TICK_INTERVAL_MS) return;
			lastRoundTickAt = now;
			settleStrandedRounds();
			try {
				// 非 force：保留 fullscreen 布局缓存和差分绘制。
				uiRef?.requestRender?.();
			} catch {
				/* 无 UI */
			}
		});
	};

	/** 围观中：活动回合，或收尾静默期还没走完的回合（槽位卡仍挂在屏幕上）。 */
	const roundLive = (round: CompactRound): boolean =>
		round.active || (round.settleUntil !== undefined && Date.now() < round.settleUntil);

	const clearFoldTimer = (round: CompactRound): void => {
		if (round.foldTimer !== undefined) {
			clearTimeout(round.foldTimer);
			round.foldTimer = undefined;
		}
		round.settleUntil = undefined;
		pendingFoldRounds.delete(round);
	};

	/** 供采纳为回合边界的 timestamp：必须是看起来像 epoch 毫秒的数（桩数据/秒级会被拒）。 */
	const isUsableTimestamp = (value: unknown): value is number =>
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= 1_600_000_000_000 &&
		value <= Date.now() + 60_000;

	/** 结束回合活动态；不做任何重绘。更晚的消息 timestamp 用来保住回放时长；
	 * 同一条消息的 timestamp 不动，活回合改用本进程挂钟，避免把历史 timestamp 收到「现在」。 */
	const finalizeRound = (round: CompactRound, endTimestamp?: number): void => {
		clearFoldTimer(round);
		round.active = false;
		if (round.endedAt === undefined) {
			let fallback = 0;
			for (const message of roundMessages(round)) {
				if (isUsableTimestamp(message?.timestamp) && message.timestamp > fallback) {
					fallback = message.timestamp;
				}
			}
			const stamped = isUsableTimestamp(endTimestamp) ? endTimestamp : fallback;
			if (stamped > round.startedAt) round.endedAt = stamped;
			else if (typeof round.wallStartedAt === "number") {
				round.endedAt = round.startedAt + Math.max(0, Date.now() - round.wallStartedAt);
			} else round.endedAt = Math.max(round.startedAt, Date.now());
		}
		if (activeRound === round) {
			activeRound = undefined;
			deps.query?.setCompactSummaryActive?.(false);
			stopRoundTick();
		}
	};

	/**
	 * 结束回合活动态；render=true 时走静默期，延迟 FOLD_SETTLE_MS 再收拢。
	 * 分组语义不受影响：activeRound 立即让位，新消息不会被并进已收尾的回合。
	 */
	const endRound = (round: CompactRound, render = false, endTimestamp?: number): void => {
		if (!render || !round.active) {
			finalizeRound(round, endTimestamp);
			if (render) renderRound(round);
			return;
		}
		finalizeRound(round, endTimestamp);
		if (round.foldTimer !== undefined) return;
		round.settleUntil = Date.now() + FOLD_SETTLE_MS;
		pendingFoldRounds.add(round);
		round.foldTimer = setTimeout(() => {
			round.foldTimer = undefined;
			round.settleUntil = undefined;
			pendingFoldRounds.delete(round);
			renderRound(round);
		}, FOLD_SETTLE_MS);
	};

	/**
	 * 外层行（edit/write/ask）切出的段落封口：跳过静默期直接定稿。
	 * 静默期是为"正文 token 先于 toolCall 到达"的双重转场准备的；外层边界
	 * 出现时摘要段内容已完整，立即收拢让 Ran for 当场落位，槽位卡一并撤走。
	 */
	const sealRound = (round: CompactRound, endTimestamp?: number): void => {
		finalizeRound(round, endTimestamp);
		renderRound(round);
	};

	/** 新回合接替时立即收掉还在静默期的回合，把两次转场并成一次。 */
	const flushSettle = (): void => {
		for (const round of [...pendingFoldRounds]) {
			clearFoldTimer(round);
			renderRound(round);
		}
	};

	const renderAssistantWithoutThinking = (
		component: any,
		message: any,
		isStreaming?: boolean,
	): any => {
		const content = Array.isArray(message?.content) ? message.content : [];
		const result = passThroughAssistant(
			component,
			{
				...message,
				content: content.filter((item: any) => item?.type !== "thinking"),
			},
			isStreaming,
		);
		component.lastMessage = message;
		return result;
	};

	/** compact 只允许单开：收回一张工具卡的展开态。 */
	const collapseTool = (tool: any): void => {
		if (typeof tool?.setExpanded === "function") tool.setExpanded(false);
		else {
			tool.expanded = false;
			tool.updateDisplay?.();
		}
	};

	/** 按条件收回已展开的工具卡。 */
	const collapseTools = (shouldCollapse: (tool: any) => boolean): void => {
		for (const tool of trackedToolComponents) {
			if (tool.expanded === true && shouldCollapse(tool)) collapseTool(tool);
		}
	};

	const markRoundToolUserExpanded = (tool: any): void => {
		const id = String(tool?.toolCallId ?? "");
		if (!id || !expandedRoundToolIds.has(id)) return;
		for (const other of trackedToolComponents) {
			const otherId = String(other?.toolCallId ?? "");
			if (other === tool || !expandedRoundToolIds.has(otherId) || other.expanded !== true) continue;
			explicitRoundToolIds.delete(otherId);
			collapseTool(other);
		}
		explicitRoundToolIds.add(id);
	};
	roundToolExpansion = { markUserExpanded: markRoundToolUserExpanded };

	const roundMessages = (round: CompactRound): any[] => [
		...round.messages.values(),
		...round.detachedMessages,
	];

	const roundToolCallIds = (round: CompactRound): Set<string> => {
		const ids = new Set<string>();
		for (const message of roundMessages(round)) {
			for (const item of Array.isArray(message?.content) ? message.content : []) {
				if (item?.type === "toolCall" && typeof item.id === "string") ids.add(item.id);
			}
		}
		return ids;
	};

	/**
	 * 摘要行有东西可汇总才挂：普通工具（edit/write/ask 之外）或非空思考。
	 * 只剩外层卡的回合不挂——那些卡各自能展开，空摘要点开只会跳位。
	 */
	const roundHasSummaryContent = (round: CompactRound): boolean => {
		for (const message of roundMessages(round)) {
			for (const item of Array.isArray(message?.content) ? message.content : []) {
				if (item?.type === "thinking" && String(item.thinking ?? "").trim()) return true;
				if (
					item?.type === "toolCall" &&
					typeof item.name === "string" &&
					!OUTER_TOOLS.has(item.name)
				) {
					return true;
				}
			}
		}
		return false;
	};

	/**
	 * anchor 所在的 transcript 容器（pi chatContainer）。
	 * 优先走分组补丁在 addChild 时挂的父指针；没有则沿 tui 组件树找直属父容器。
	 */
	const tailContainerOf = (anchor: any): any => {
		const keyed = anchor?.[TOOL_GROUPING_PARENT_KEY];
		if (keyed && Array.isArray(keyed.children) && keyed.children.includes(anchor)) {
			return keyed;
		}
		let found: any;
		walkComponentTree(getToolMouseTui(), (value: any) => {
			if (found) return false;
			if (Array.isArray(value?.children) && value.children.includes(anchor)) {
				found = value;
				return false;
			}
			return undefined;
		});
		return found;
	};

	/** 组件在树里的直属父容器。TUI 切换/reparent 后缓存的 container 会过期。 */
	const containerOfHost = (host: any): any => {
		let found: any;
		walkComponentTree(getToolMouseTui(), (value: any) => {
			if (found) return false;
			if (Array.isArray(value?.children) && value.children.includes(host)) {
				found = value;
				return false;
			}
			return undefined;
		});
		return found;
	};

	/** 回合成员判定：本回合的 assistant 组件，或归属本回合的工具（含分组容器）。 */
	const roundMemberMatcher = (round: CompactRound): ((value: any) => boolean) => {
		const ids = roundToolCallIds(round);
		const matchesTool = (value: any): boolean =>
			typeof value?.toolCallId === "string" && ids.has(value.toolCallId);
		return (value: any): boolean =>
			round.messages.has(value) ||
			matchesTool(value) ||
			(Array.isArray(value?.children) && value.children.some(matchesTool));
	};

	/** 用户消息（含 skill 调用块）是回合的硬边界。 */
	const isUserMessageComponent = (value: any): boolean =>
		value instanceof UserMessageComponent || value instanceof SkillInvocationMessageComponent;

	/**
	 * 回合内的透明行：custom 通知（系统提示、extension 注入）既不是成员也不算外来行。
	 * 它落在两个成员之间时原地保留——不打断统计、不被搬到摘要行下方。
	 * 硬边界仍只有用户消息；summary/compaction 块由各自的 message 边界收口。
	 */
	const isTransparentComponent = (value: any): boolean => value instanceof CustomMessageComponent;

	/**
	 * 新组件与回合已有成员之间是否隔着一条用户消息。隔着就说明这是下一回合的内容：
	 * steer 消息插进了回合中间，或上一回合没有正文就收尾、用户又问了新问题。
	 * 组件还没挂进容器时判断不了，按不隔开处理（会话重放的 refresh 会再求值一次）。
	 */
	const crossesUserMessage = (round: CompactRound, component: any): boolean => {
		const container = tailContainerOf(round.anchor);
		const children = container?.children;
		if (!Array.isArray(children)) return false;
		const index = children.indexOf(component);
		if (index < 0) return false;
		const isMember = roundMemberMatcher(round);
		for (let i = index - 1; i >= 0; i--) {
			if (isMember(children[i])) return false;
			if (isUserMessageComponent(children[i])) return true;
		}
		return false;
	};

	/**
	 * 可以并入的活动回合。被用户消息隔开时返回 undefined，调用方收掉旧回合另起一个，
	 * 保证回合不跨用户消息——否则区间里的用户消息会被当成外来行挪到回合末尾之后。
	 */
	const joinableActiveRound = (component: any): CompactRound | undefined =>
		activeRound && !crossesUserMessage(activeRound, component) ? activeRound : undefined;

	/** 取并入目标；旧回合被用户消息隔开时先收尾（静默期一转场，新回合立即接手）。 */
	const joinOrCreateRound = (component: any, message: any): CompactRound => {
		const joinable = joinableActiveRound(component);
		if (!joinable && activeRound) finishRound(activeRound, message?.timestamp);
		return joinable ?? createRound(component, message);
	};

	/** 尾行实际所在容器；缓存的 container 过期时按树找回来。 */
	const tailHostContainer = (tail: MountedRoundTail): any =>
		containerOfHost(tail.host) ??
		(tail.container?.children?.includes?.(tail.host) === true ? tail.container : undefined);

	/** 摘尾行：按实际所在容器摘，避免缓存过期时摘了个空、行留在树上。 */
	const removeTailHost = (tail: MountedRoundTail): void => {
		tailHostContainer(tail)?.removeChild?.(tail.host);
	};

	const ensureTailHost = (round: CompactRound): MountedRoundTail => {
		if (round.tail) return round.tail;
		// 同一 anchor 上残留的旧回合尾行（reset/重组后建新回合）先摘除，避免双摘要。
		const stale = tailByAnchor.get(round.anchor);
		if (stale) {
			removeTailHost(stale);
			mountedTails.delete(stale);
			tailByAnchor.delete(round.anchor);
		}
		const tail: MountedRoundTail = { host: undefined, container: undefined, parts: [], round };
		const host: any = {
			outputPad: Number(round.anchor?.outputPad) || 0,
			children: [],
			render: (width: number) => tail.parts.flatMap((part: any) => part?.render?.(width) ?? []),
			childAtRow(localRow: number, width: number) {
				let offset = 0;
				for (const part of tail.parts) {
					const lines = part?.render?.(width);
					const count = Array.isArray(lines) ? lines.length : 0;
					if (localRow < offset + count) {
						return part?.childAtRow?.(localRow - offset, width) ?? null;
					}
					offset += count;
				}
				return null;
			},
			invalidate: () => {
				for (const part of tail.parts) part?.invalidate?.();
			},
		};
		Object.defineProperty(host, "expanded", {
			configurable: true,
			get: () => tail.round?.anchor?.expanded === true,
			set: (value: boolean) => {
				const anchor = tail.round?.anchor;
				if (anchor) anchor.expanded = value;
			},
		});
		// 点击/悬停归属与 anchor 同一展开入口；toggle 每次 renderRound 重建，按值转发。
		// 经 tail.round 动态解引用：重建过户时 anchor 可能换成别的组件。
		ensureAssistantSetExpanded(host);
		Object.defineProperty(host, "roundAnchor", {
			configurable: true,
			get: () => tail.round?.anchor,
		});
		host[ASSISTANT_TOGGLE_ROUND_KEY] = (expanded: boolean) =>
			tail.round?.anchor?.[ASSISTANT_TOGGLE_ROUND_KEY]?.(expanded);
		tail.host = host;
		tailByAnchor.set(round.anchor, tail);
		mountedTails.add(tail);
		round.tail = tail;
		return tail;
	};

	/**
	 * 尾行归位。目标位：活回合（运行中/收尾静默期）且未展开 → 容器最末，
	 * 计数行钉在 transcript 可写底缘，运行中到达的提示行/custom 条目只能落在
	 * 它上方，不会被顶离底部截成两行；其余（收尾回合、展开的回合）→ 回合最后
	 * 一个成员之后，外来行统一换到摘要行之下。展开的回合不按 live 推到底：
	 * 展开卡属于回合原位，推进容器末尾会把它挪到别的消息之间。
	 * 尾行已在目标位就不动容器：展开/收起只换 tail.parts，无谓的重摘重插
	 * 本身就是摘要行挪位的来源。
	 */
	const syncTailPosition = (round: CompactRound): void => {
		const tail = round.tail;
		if (!tail?.host) return;
		const container =
			tail.container?.children?.includes?.(round.anchor) === true
				? tail.container
				: tailContainerOf(round.anchor);
		if (!container || !Array.isArray(container.children)) return;
		tail.container = container;
		const children = container.children as any[];
		const isMember = roundMemberMatcher(round);
		const current = children.indexOf(tail.host);
		// 摘尾行前先定目标位，已在位就整段跳过。
		let last = -1;
		for (let i = 0; i < children.length; i++) {
			if (children[i] === tail.host || !isMember(children[i])) continue;
			last = i;
		}
		const pinToEnd = roundLive(round) && round.anchor?.expanded !== true;
		const desired = pinToEnd || last < 0 ? children.length - 1 : last + 1;
		if (current === desired) return;
		if (current >= 0) children.splice(current, 1);
		let first = -1;
		last = -1;
		for (let i = 0; i < children.length; i++) {
			if (!isMember(children[i])) continue;
			if (first < 0) first = i;
			last = i;
		}
		const lastMember = last >= 0 ? children[last] : undefined;
		const intruders: any[] = [];
		for (let i = last - 1; i > first; i--) {
			// 用户消息永远留在原地：挪走会把别人的消息挪到用户消息下面去。
			// custom 通知同理：它是回合内的透明行，不被统计也不挪位。
			if (
				isMember(children[i]) ||
				isUserMessageComponent(children[i]) ||
				isTransparentComponent(children[i])
			) {
				continue;
			}
			intruders.unshift(children.splice(i, 1)[0]);
		}
		if (lastMember) last = children.indexOf(lastMember);
		const insertAt = last < 0 ? children.length : last + 1;
		if (pinToEnd) {
			// 活回合：外来行压到最后成员之后，尾行占容器最末。
			children.splice(insertAt, 0, ...intruders);
			children.push(tail.host);
		} else {
			children.splice(insertAt, 0, tail.host, ...intruders);
		}
		tail.host[TOOL_GROUPING_PARENT_KEY] = container;
	};

	const unmountRoundTail = (round: CompactRound): void => {
		const tail = round.tail;
		if (!tail) return;
		round.tail = undefined;
		removeTailHost(tail);
		mountedTails.delete(tail);
		if (tailByAnchor.get(round.anchor) === tail) tailByAnchor.delete(round.anchor);
	};

	/**
	 * pi 把新工具卡 append 在容器末尾（尾行之后）：updateDisplay 时把所属回合的
	 * 尾行压回末尾。只有 live/收尾静默期的回合还会长工具。
	 */
	const syncTailForTool = (toolCallId: string): void => {
		if (!toolCallId) return;
		for (const round of [activeRound, ...pendingFoldRounds]) {
			if (!round || !roundToolCallIds(round).has(toolCallId)) continue;
			// 槽位是在消息更新时画的，当时工具组件还不存在：组件到了就补上。
			// 参数流式更新也走这里，槽位卡跟着换内容。
			if (round.pendingLiveTool || roundLive(round)) renderRound(round);
			else if (round.tail) syncTailPosition(round);
			return;
		}
	};

	/**
	 * refresh 重建时继承旧回合：resetRounds 只清索引不摘 compact 尾行，
	 * 残留尾行带着旧 round。同一组件重放同一消息（lastMessage 回放）
	 * 才算重建——保留挂钟起点、已脱离的工具历史与尾行组件本身；
	 * 旧回合已收尾的直接落成折叠态（不回摆 Running、不重演静默期），
	 * 仍活动的只接回挂钟，Running 时长继续走。
	 */
	const adoptPriorRound = (round: CompactRound, message: any): void => {
		let prior: CompactRound | undefined;
		for (const tail of mountedTails) {
			const stale = tail.round as CompactRound | undefined;
			if (
				stale &&
				// 先认组件：重放时消息对象未必是同一个（会话重读/重建），
				// 只认消息身份会漏掉本该接回的回合，摘要行就此掉队。
				(stale.anchor === round.anchor ||
					stale.messages.has(round.anchor) ||
					stale.detachedMessages.includes(message))
			) {
				prior = stale;
				break;
			}
		}
		if (!prior) return;
		round.startedAt = prior.startedAt;
		if (typeof prior.wallStartedAt === "number") round.wallStartedAt = prior.wallStartedAt;
		if (prior.detachedMessages.length) round.detachedMessages.push(...prior.detachedMessages);
		if (!prior.active) {
			round.active = false;
			round.endedAt = prior.endedAt ?? round.startedAt;
		}
		const tail = prior.tail;
		if (tail) {
			prior.tail = undefined;
			if (tailByAnchor.get(prior.anchor) === tail) tailByAnchor.delete(prior.anchor);
			tail.round = round;
			tailByAnchor.set(round.anchor, tail);
			round.tail = tail;
		}
	};

	/** 新建活回合：起点用消息真实时刻（回放里 Date.now 会把整轮挤在同一毫秒）。 */
	const createRound = (anchor: any, message: any): CompactRound => {
		const round: CompactRound = {
			anchor,
			messages: new Map(),
			detachedMessages: [],
			active: true,
			suppressedToolIds: new Set(),
			liveSlotToolIds: new Set(),
			startedAt: isUsableTimestamp(message?.timestamp) ? message.timestamp : Date.now(),
			wallStartedAt: Date.now(),
		};
		liveRounds.add(round);
		activateRound(round);
		adoptPriorRound(round, message);
		return round;
	};

	/**
	 * 尾行挂载入口：makeParts 按渲染态产出内容（折叠态 [摘要行]，live 态
	 * [摘要行, 槽位卡]），identity 决定行内 hover/点击归属组件（尾行模式下是
	 * host，hit-test 直达它）。anchor 未挂进任何容器时（独立渲染）退回
	 * contentContainer——与旧行为一致。
	 */
	const mountRoundTail = (round: CompactRound, makeParts: (identity: any) => any[]): void => {
		if (!tailContainerOf(round.anchor)) {
			// anchor 不在任何容器里（独立渲染/未挂载）：退回 anchor 内部，与旧行为一致。
			unmountRoundTail(round);
			for (const part of makeParts(round.anchor)) {
				round.anchor?.contentContainer?.addChild?.(part);
			}
			return;
		}
		const tail = ensureTailHost(round);
		tail.parts = makeParts(tail.host);
		tail.host.children = tail.parts;
		syncTailPosition(round);
	};

	/**
	 * 末块仍是 thinking = 思考还在长；后面跟了正文或工具调用就算结束。
	 * 围观态只预览这一种，已完成的思考直接回收进摘要行，不在屏幕上留 Thought 行。
	 */
	const hasTrailingThinking = (message: any): boolean => {
		const content = Array.isArray(message?.content) ? message.content : [];
		for (let i = content.length - 1; i >= 0; i--) {
			const item = content[i];
			if (item?.type === "thinking") return true;
			if (item?.type === "toolCall") return false;
			if (item?.type === "text" && String(item.text ?? "").trim()) return false;
		}
		return false;
	};

	/** 运行中的工具：已开始且尚无最终结果。 */
	const isRunningTool = (tool: any): boolean =>
		tool?.executionStarted === true && (!tool.result || tool.isPartial === true);

	/**
	 * live 围观态：正文 + 摘要行照折叠态渲染，只在摘要行下多一张槽位卡。
	 * - 思考：只预览最后一条仍在思考的消息，它的块是当前最新内容；
	 * - 工具：没有活动思考时才占槽位，运行中优先，否则取本回合最近的，完成也留着；
	 * - 槽位只放一个块（思考或工具），新的思考块/工具调用进来才轮换；
	 * - 本回合所有工具都由槽位卡接管，外层不再单独成行。
	 * 可见性判断只在这里发生；回合结束（renderRound 非 active）只剩槽位卡消失。
	 */
	const renderRoundLive = (
		round: CompactRound,
		stopStatus: { text: string; kind: string } | string | undefined,
		getSummary: () => string,
	): void => {
		// 仍在思考的消息 = 当前最新内容，优先占槽位。
		let previewComponent: any;
		for (const [component, message] of round.messages) {
			if (hasTrailingThinking(message)) previewComponent = component;
		}

		const thinkingKids: any[] = [];
		for (const [component, message] of round.messages) {
			if (component === previewComponent) {
				passThroughAssistant(component, message);
				const kids = Array.isArray(component.contentContainer?.children)
					? [...component.contentContainer.children]
					: [];
				component.contentContainer?.clear?.();
				// 只摘思考预览块进槽位；已收尾的思考回收进摘要行。
				for (const kid of kids) {
					if (typeof kid?.setHintHovered === "function") thinkingKids.push(kid);
				}
			}
			// text 在各消息自己的位置渲染，不随回合折叠态；非 anchor 成员的
			// 中止/错误状态仍汇总在 anchor 外层，不在成员处重复成行。
			renderAssistantWithoutThinking(
				component,
				component === round.anchor ? message : { ...message, stopReason: "stop" },
			);
		}

		const toolsById = new Map<string, any>();
		for (const tool of trackedToolComponents) {
			if (typeof tool?.toolCallId === "string") toolsById.set(tool.toolCallId, tool);
		}
		let runningTool: any;
		let lastTool: any;
		let missingTool = false;
		for (const [, message] of round.messages) {
			for (const item of Array.isArray(message?.content) ? message.content : []) {
				if (item?.type !== "toolCall" || typeof item.id !== "string") continue;
				const tool = toolsById.get(item.id);
				// edit/write 保留自己的 compact 行，不进槽位。
				if (OUTER_TOOLS.has(String(tool?.toolName ?? item.name ?? ""))) continue;
				round.liveSlotToolIds.add(item.id);
				liveSlotToolIds.add(item.id);
				// pi 的 message_update 先 updateContent 再建工具组件：这一帧计数已经算上，
				// 组件要等 updateDisplay 才能进槽位。记下来，组件一到就补画。
				if (!tool) {
					missingTool = true;
					continue;
				}
				lastTool = tool;
				if (isRunningTool(tool)) runningTool = tool;
			}
		}
		round.pendingLiveTool = missingTool;
		// 槽位单块：活动思考最新；否则本回合最近的工具（运行中原位增长，完成也留着）。
		const slotTool = thinkingKids.length > 0 ? undefined : (runningTool ?? lastTool);
		const cardItems: Array<{ child?: any; tool?: any }> = slotTool
			? [{ tool: slotTool }]
			: thinkingKids.map((child) => ({ child }));

		const anchor = round.anchor;
		const pad = Number(anchor.outputPad) || 0;
		// 摘要行与槽位卡挂回合尾行（transcript 容器内回合末尾，而非 anchor 内部）：
		// 运行中恒在可写视口底缘，收尾的 Ran for 原地落进 scrollback，不再留下
		// 被挤出视口后定格的 Running 帧。
		mountRoundTail(round, (identity) => {
			const parts: any[] = [
				compactAssistantLineComponent(identity, getSummary, deps.query, {
					isHovered: () => hoveredAssistantComponent === identity,
				}),
			];
			if (cardItems.length > 0) {
				parts.push(
					compactLiveSlot(
						compactRoundCard(
							cardItems,
							(tool, innerWidth) => patch.toolOriginalRender.call(tool, innerWidth),
							false,
							true,
						),
						pad,
					),
				);
			}
			return parts;
		});
		appendStopStatus(anchor, stopStatus);
	};

	const renderRound = (round: CompactRound): void => {
		const messages = roundMessages(round);
		const stopStatus = roundStopStatus(messages);
		if (stopStatus) endRound(round);
		// Running 时每次 render 重算时长（含挂钟下限）；结束后固定。
		// 静默期内回合已收尾，摘要行直接给 Ran for，只有槽位卡多留一拍。
		const getSummary = () => summarize(roundMessages(round), round.active, round);
		const summary = getSummary();
		for (const id of round.suppressedToolIds) expandedRoundToolIds.delete(id);
		round.suppressedToolIds.clear();
		// 回合收起（或本回合不在展开态）时忘掉用户的单开选择，并把面板接管的工具一起收回：
		// 少了后一步，被点开的工具会带着自身的 expanded 落到 toolInstalledRender 的放行分支，
		// 面板一收就单独渲染成一张卡。
		if (round.anchor.expanded !== true) {
			const ids = roundToolCallIds(round);
			for (const id of ids) explicitRoundToolIds.delete(id);
			collapseTools(
				(tool) =>
					ids.has(String(tool.toolCallId ?? "")) && !OUTER_TOOLS.has(String(tool.toolName ?? "")),
			);
		}
		for (const id of round.liveSlotToolIds) liveSlotToolIds.delete(id);
		round.liveSlotToolIds.clear();
		// pendingLiveTool 留给 renderRoundLive 重算：这里清掉的话，组件刚到的那次
		// 补画会把自己的触发条件抹掉，槽位仍是空的。

		for (const [component, message] of round.messages) {
			component.lastMessage = message;
			ensureAssistantSetExpanded(component);
			// 尾行用 getter 指向 anchor；成员用同名属性，点内部工具时能认出同一回合。
			if (!Object.getOwnPropertyDescriptor(component, "roundAnchor")?.get) {
				component.roundAnchor = round.anchor;
			}
			component[ASSISTANT_TOGGLE_ROUND_KEY] = (expanded: boolean) => {
				const wasExpanded = round.anchor.expanded === true;
				if (expanded && !wasExpanded) capturePanelViewport(round.anchor);
				for (const member of round.messages.keys()) member.expanded = expanded;
				if (!expanded) {
					for (const id of round.suppressedToolIds) expandedRoundToolIds.delete(id);
					round.suppressedToolIds.clear();
				}
				renderRound(round);
				if (!expanded && wasExpanded) restorePanelViewport(round.anchor);
			};
		}

		if (round.anchor.expanded === true) {
			// 没有可汇总内容的回合不进展开态：摘要行不存在，展开只会把正文搬回回合开头。
			if (!roundHasSummaryContent(round)) {
				for (const member of round.messages.keys()) member.expanded = false;
				round.anchor.expanded = false;
			}
		}
		if (round.anchor.expanded === true) {
			// 展开内容留在摘要行那个位置：回合最后一个成员（含 write/edit）之后。
			// 放进 anchor 内部会跳到回合起点，盖到中间的 write/edit 上面。
			// anchor 未挂进 transcript 时没有这个位置，退回 anchor 内部。
			const mounted = Boolean(tailContainerOf(round.anchor));
			const toolsById = new Map<string, any>();
			for (const tool of trackedToolComponents) {
				if (typeof tool?.toolCallId === "string") toolsById.set(tool.toolCallId, tool);
			}
			// 助手文本按原生渲染、不进面板（面板只留 thinking 与工具卡）。
			// thinking/工具卡按连续段各包一张面板；先出文本再出面板，
			// 否则消息内容里的 thinking（[thinking, text, toolCall]）会盖到文本上面。
			const anchorChildren: any[] = [];
			let cardItems: Array<{ child?: any; tool?: any }> = [];
			// 纯 spacer 串拆不开面板，还给它所在消息的组件（通常是上一个
			// text 块的前导空行）。
			const flushPanel = (spacerOwner: any = round.anchor) => {
				if (cardItems.length === 0) return;
				if (cardItems.every((item) => !item.tool && isSpacerComponent(item.child))) {
					for (const item of cardItems) {
						spacerOwner?.contentContainer?.addChild?.(item.child);
					}
				} else {
					// 面板上沿留 1 行卡外空行：面板底色与 userMessage 同色，
					// 贴在一起会看成一个块；卡内顶部再加 1 行 padding 保持上下对称。
					// 空行必须与面板同进退（childAtRow 参与面板拆分），用 panelBoundSpacer。
					anchorChildren.push(panelBoundSpacer());
					anchorChildren.push(
						compactRoundCard(
							cardItems,
							(tool, innerWidth) => patch.toolOriginalRender.call(tool, innerWidth),
							// 整回合展开卡：卡内工具行归 tool 组件，可单击二次展开。
							true,
						),
					);
				}
				cardItems = [];
			};
			// outside 的块（text 及其前导空行）留在各自组件上原位渲染：展开态下
			// 助手文本不跨消息搬家；它不切断面板——cardItems 跨消息延续，回合的
			// thinking/工具统一汇成末尾的一张共享面板，混排 text 不再把卡撕成几段。
			const takeChild = (component: any, child: any, outside: boolean) => {
				if (!outside) {
					cardItems.push({ child });
					return;
				}
				component.contentContainer?.addChild?.(child);
			};
			const placedToolIds = new Set<string>();
			const placeTool = (id: string, fallbackName?: string) => {
				const tool = toolsById.get(id);
				if (!tool || OUTER_TOOLS.has(String(tool.toolName ?? fallbackName ?? ""))) return;
				if (placedToolIds.has(id)) return;
				placedToolIds.add(id);
				cardItems.push({ tool });
			};
			type LocalEntry = { outside: boolean; child?: any; toolId?: string; toolName?: string };
			for (const [component, message] of round.messages) {
				passThroughAssistant(component, message);
				const kids = Array.isArray(component.contentContainer?.children)
					? [...component.contentContainer.children]
					: [];
				component.contentContainer?.clear?.();
				const cursor = { i: 0 };
				let inThinkingRun = false;
				// 本消息产出先收集再发射：文本（含其前导 Spacer）统一排在面板前面。
				const local: LocalEntry[] = [];
				const takeRun = (outside: boolean) => {
					while (cursor.i < kids.length && isSpacerComponent(kids[cursor.i])) {
						local.push({ outside, child: kids[cursor.i++] });
					}
					if (cursor.i < kids.length) local.push({ outside, child: kids[cursor.i++] });
				};
				for (const item of Array.isArray(message?.content) ? message.content : []) {
					if (item?.type === "thinking") {
						if (!String(item.thinking ?? "").trim()) continue;
						if (!inThinkingRun) {
							takeRun(false);
							inThinkingRun = true;
						}
						continue;
					}
					inThinkingRun = false;
					if (item?.type === "text" && String(item.text ?? "").trim()) {
						takeRun(true);
						continue;
					}
					if (item?.type === "toolCall" && typeof item.id === "string") {
						local.push({ outside: false, toolId: item.id, toolName: item.name });
					}
				}
				while (cursor.i < kids.length) local.push({ outside: false, child: kids[cursor.i++] });
				for (const entry of local) if (entry.outside) takeChild(component, entry.child, true);
				for (const entry of local) {
					if (entry.outside) continue;
					if (entry.toolId) placeTool(entry.toolId, entry.toolName);
					else takeChild(component, entry.child, false);
				}
			}
			for (const message of round.detachedMessages) {
				for (const item of Array.isArray(message?.content) ? message.content : []) {
					if (item?.type === "toolCall" && typeof item.id === "string") {
						placeTool(item.id, item.name);
					}
				}
			}
			const ids = roundToolCallIds(round);
			for (const id of ids) {
				round.suppressedToolIds.add(id);
				expandedRoundToolIds.add(id);
				if (!placedToolIds.has(id)) placeTool(id);
			}
			// Round 展开只打开外层卡片。普通工具保持折叠，避免长输出递归撑满屏幕；
			// 用户单独点开的（explicitRoundToolIds）不压回去。
			collapseTools(
				(tool) =>
					ids.has(String(tool.toolCallId ?? "")) &&
					!OUTER_TOOLS.has(String(tool.toolName ?? "")) &&
					!explicitRoundToolIds.has(String(tool.toolCallId ?? "")),
			);
			flushPanel();
			// anchorChildren 只剩面板件（spacer+panelBoundSpacer 都是 childAtRow 组件）：
			// 面板挂回摘要行原位，text 已在各自组件上。
			if (mounted) {
				if (anchorChildren.length > 0) mountRoundTail(round, () => anchorChildren);
				else unmountRoundTail(round);
			} else {
				unmountRoundTail(round);
				for (const child of anchorChildren) round.anchor.contentContainer.addChild(child);
			}
			// 展开卡内工具会显示 error，外层仍挂 abort/length，避免只藏在折叠工具里。
			appendStopStatus(round.anchor, stopStatus);
			return;
		}

		if (roundLive(round)) {
			// 围观态：单一槽位卡（活动思考预览 + 当前工具），回合结束自动收回。
			renderRoundLive(round, stopStatus, getSummary);
			return;
		}

		for (const [component, message] of round.messages) {
			if (component === round.anchor) {
				renderAssistantWithoutThinking(component, message);
				// 空摘要不挂行（getter 在 Running 启动瞬间也可能短暂为空）。
				// 只剩外层卡的回合同样不挂：摘要行没有可汇总的内容。
				if ((summary || round.active) && (round.active || roundHasSummaryContent(round))) {
					mountRoundTail(round, (identity) => [
						compactAssistantLineComponent(identity, getSummary, deps.query, {
							isHovered: () => hoveredAssistantComponent === identity,
						}),
					]);
				} else {
					unmountRoundTail(round);
				}
				// 折叠时工具行被隐藏：abort/error/length 必须挂在摘要外层。
				appendStopStatus(component, stopStatus);
			} else {
				// 成员的 text 同样留在自己组件上；中止状态只在 anchor 外层报一次。
				renderAssistantWithoutThinking(component, { ...message, stopReason: "stop" });
			}
		}
	};

	const activateRound = (round: CompactRound): void => {
		flushSettle();
		round.active = true;
		if (!round.startedAt) round.startedAt = Date.now();
		delete round.endedAt;
		activeRound = round;
		deps.query?.setCompactSummaryActive?.(true);
		ensureRoundTick();
	};

	/** 结束回合活动态；render=true 时走静默期，延迟 FOLD_SETTLE_MS 再收拢。 */
	const finishRound = (round: CompactRound, endTimestamp?: number): void =>
		endRound(round, true, endTimestamp);

	/**
	 * 重放/重建结束后的对账：mountedTails 里凡 tail.round 不在本 pass 回合名单的
	 * 都是没被收编的孤儿（anchor 组件没了、消息换成了新对象、回放顺序错位），
	 * 就地摘除。收编过的尾行 round 已过户到新 round，不在此列。
	 */
	const sweepOrphanTails = (): void => {
		for (const tail of [...mountedTails]) {
			const round = tail.round as CompactRound | undefined;
			// 回合还在本 pass 名单里、且没有同 anchor 的更新 tail 顶位时保留。
			if (round && liveRounds.has(round)) {
				const anchor = round.anchor;
				if (!anchor || tailByAnchor.get(anchor) === tail) continue;
			}
			removeTailHost(tail);
			mountedTails.delete(tail);
			if (round?.anchor && tailByAnchor.get(round.anchor) === tail) {
				tailByAnchor.delete(round.anchor);
			}
			if (round?.tail === tail) round.tail = undefined;
		}
	};

	const resetRounds = (): void => {
		for (const round of [...pendingFoldRounds]) clearFoldTimer(round);
		activeRound = undefined;
		liveRounds.clear();
		roundByComponent = new WeakMap();
		expandedRoundToolIds.clear();
		explicitRoundToolIds.clear();
		liveSlotToolIds.clear();
		// 尾行是 transcript 兄弟组件：compact 下保留为静态行（与原 anchor 内摘要
		// 一致；同 anchor 重建回合时 ensureTailHost 去重摘除），非 compact 摘掉，
		// 别把紧凑摘要带进 default 渲染。
		for (const tail of [...mountedTails]) {
			const container = tailHostContainer(tail);
			if (!container) {
				mountedTails.delete(tail);
				continue;
			}
			tail.container = container;
			if (config.mode === "compact") continue;
			container.removeChild(tail.host);
			mountedTails.delete(tail);
			if (tail.round?.tail === tail) tail.round.tail = undefined;
			if (tail.round?.anchor && tailByAnchor.get(tail.round.anchor) === tail) {
				tailByAnchor.delete(tail.round.anchor);
			}
		}
		deps.query?.setCompactSummaryActive?.(false);
		stopRoundTick();
	};

	/**
	 * 兜底：resetRounds 会丢掉回合索引但保留已挂的尾行，重放没能接回的回合会一直
	 * active——尾行永远显示 Running...（时长还在涨）却不再计入新工具。既不是活动
	 * 回合也不在收尾静默期的活回合就地收尾，不让它永远挂在屏幕上。
	 */
	const settleStrandedRounds = (): void => {
		for (const tail of [...mountedTails]) {
			const round = tail.round as CompactRound | undefined;
			if (!round?.active || round === activeRound || pendingFoldRounds.has(round)) continue;
			endRound(round, true);
		}
	};

	/**
	 * 会话已空闲时收尾末尾回合。重建 pass 内仍按顺序并回合（同一 turn 的多条
	 * 消息要合成一条摘要），只在 pass 结束时对账：会话没在跑，末尾那条就不会
	 * 再长出内容，停在 Running 是假的。
	 */
	const settleTrailingRound = (): void => {
		if (!sessionIdle()) return;
		const round = activeRound;
		if (!round) return;
		finalizeRound(round);
		renderRound(round);
	};

	patch.assistantInstalled = function (this: any, message: any, isStreaming?: boolean) {
		const self = this as any;
		// 同 compact-thinking：isStreaming 丢失 → mermaid 流式误渲染来回闪。
		if (isStreaming !== undefined) self.isStreaming = isStreaming;
		if (self[ASSISTANT_REENTRY_KEY] === patch) {
			return patch.assistantNative.call(this, message, isStreaming);
		}
		self.lastMessage = message;
		trackedAssistantComponents.add(this);
		if (!patch.active || config.mode !== "compact") {
			return passThroughAssistant(this, message, isStreaming);
		}
		if (!self.contentContainer || typeof self.contentContainer.clear !== "function") {
			return passThroughAssistant(this, message, isStreaming);
		}

		const content = Array.isArray(message?.content) ? message.content : [];
		const hasToolCalls = content.some((item: any) => item?.type === "toolCall");
		const hasOuterToolCall = content.some(
			(item: any) => item?.type === "toolCall" && OUTER_TOOLS.has(String(item?.name ?? "")),
		);
		const hasInnerToolCall = content.some(
			(item: any) => item?.type === "toolCall" && !OUTER_TOOLS.has(String(item?.name ?? "")),
		);
		const hasThinkingContent = content.some(
			(item: any) => item?.type === "thinking" && String(item?.thinking ?? "").trim(),
		);
		const hasText = content.some(
			(item: any) => item?.type === "text" && typeof item.text === "string" && item.text.trim(),
		);
		self.hasToolCalls = hasToolCalls;

		if (hasToolCalls) {
			let round = roundByComponent.get(this);
			const previousMessage = round?.messages.get(this);
			const previousHadOuter = Array.isArray(previousMessage?.content)
				? previousMessage.content.some(
						(item: any) => item?.type === "toolCall" && OUTER_TOOLS.has(String(item?.name ?? "")),
					)
				: false;
			if (!round) {
				// 外层行打断摘要段：本条消息带外层调用且可并入的活动回合已有内容时，
				// 旧回合就地完结（不走静默期）。本条消息自己含 inner 调用或思考才另起一段；
				// 外层独段（edit-only 消息）不建回合——没有可汇总内容，建段只会挂空摘要行。
				const joinable = joinableActiveRound(this);
				if (joinable && hasOuterToolCall) {
					sealRound(joinable, message?.timestamp);
					if (hasInnerToolCall || hasThinkingContent) {
						round = createRound(this, message);
						roundByComponent.set(this, round);
						round.messages.set(this, message);
						if (isUsableTimestamp(message.timestamp) && message.timestamp < round.startedAt) {
							round.startedAt = message.timestamp;
						}
						renderRound(round);
						return undefined;
					}
					// 外层独段：text/thinking 照原生渲染，edit 行由 tool render 外置，没有摘要行。
					return passThroughAssistant(this, message);
				}
				if (hasInnerToolCall || hasThinkingContent) {
					// 本条消息是否带 text 不是回合边界：pi 流式协议里同一条
					// assistant 消息会以 text+toolCall、toolCall-only 反复到达。
					// 只在「组件未挂进任何回合」时并入 activeRound；被用户消息
					// 隔开（steer/上回合没正文）时由 joinOrCreateRound 收尾另起。
					round = joinOrCreateRound(this, message);
					roundByComponent.set(this, round);
					round.messages.set(this, message);
					if (isUsableTimestamp(message.timestamp) && message.timestamp < round.startedAt) {
						round.startedAt = message.timestamp;
					}
					renderRound(round);
					return undefined;
				}
				// 外层独段、又没有可并入的活动回合：不建回合，text/工具各归其位。
				if (activeRound) finishRound(activeRound, message?.timestamp);
				return passThroughAssistant(this, message);
			}
			if (hasOuterToolCall && !previousHadOuter && roundLive(round)) {
				// 消息入段后流式增长才冒出外层调用（先 thinking 后 toolCall）：
				// 就地封口所在段，本条消息按消息级归属留在原段，后续消息另起一段。
				sealRound(round, message?.timestamp);
			}
			round.messages.set(this, message);
			if (isUsableTimestamp(message.timestamp) && message.timestamp < round.startedAt) {
				round.startedAt = message.timestamp;
			}
			renderRound(round);
			return undefined;
		}

		if (hasText) {
			const round = roundByComponent.get(this);
			const previousMessage = round?.messages.get(this);
			if (round && previousMessage && (round.anchor !== this || round.messages.size > 1)) {
				// 最终回答开始后，当前组件恢复原生文本；它已完成的 thinking
				// 留在上一轮摘要中，避免再次生成独立 Thought 行。
				round.messages.delete(this);
				clearRoundAnchor(this);
				round.detachedMessages.push(previousMessage);
				roundByComponent.delete(this);
				finishRound(round, message.timestamp);
				return renderAssistantWithoutThinking(this, message);
			}
			if (round) {
				// 围观态下 anchor 还挂着槽位卡，必须重绘才能收回。
				endRound(round, true, message.timestamp);
				roundByComponent.delete(this);
				clearRoundAnchor(this);
				return passThroughAssistant(this, message);
			}
			if (activeRound) finishRound(activeRound, message.timestamp);
			return renderAssistantWithoutThinking(this, message);
		}

		const hasThinking = content.some((item: any) => item?.type === "thinking");
		if (hasThinking) {
			let round = roundByComponent.get(this);
			if (!round) {
				round = joinOrCreateRound(this, message);
				roundByComponent.set(this, round);
			}
			round.messages.set(this, message);
			if (isUsableTimestamp(message.timestamp) && message.timestamp < round.startedAt) {
				round.startedAt = message.timestamp;
			}
			renderRound(round);
			return undefined;
		}

		// 无可见内容的 abort/error/length：直接外层状态行，并结束进行中的回合。
		const loneStatus = messageStopStatus(message);
		if (loneStatus) {
			if (activeRound) finishRound(activeRound, message.timestamp);
			self.contentContainer.clear();
			appendStopStatus(this, loneStatus);
			return undefined;
		}

		self.contentContainer.clear();
		return undefined;
	};

	patch.toolInstalledRender = function (this: any, width: number) {
		if (!patch.active || config.mode !== "compact") {
			return patch.toolOriginalRender.call(this, width);
		}
		const name = String(this.toolName ?? "");
		if (OUTER_TOOLS.has(name)) {
			// edit/write 走 compact 自己的 rich diff；ask_user_question 走 default 模式的专用渲染。
			// 两者都留在外层，不进摘要、不进展开面板。
			if (EDIT_WRITE_TOOLS.has(name)) {
				const pending = !this.result || this.isPartial === true;
				// 等待窗口（声明流式中或等待派发）也要转，否则这一行冻在第一帧。
				if (pending && (this.executionStarted || isLiveToolCall(this.toolCallId)))
					scheduleAnimation(this);
				return compactEditWriteLines(this, width, deps.writeMetadata);
			}
			return patch.toolOriginalRender.call(this, width);
		}
		// Agent/Task 等同普通工具：折叠不外置（live 面板走独立 widget）。
		if (expandedRoundToolIds.has(String(this.toolCallId ?? ""))) return [];
		// live 围观态：本回合工具交由槽位卡内联渲染，外层不再单独成行，
		// 卡片因此不会随工具完成反复挂载/卸载。
		if (liveSlotToolIds.has(String(this.toolCallId ?? ""))) return [];
		// 普通工具折叠时不显示独立行（摘要行已统计），独立展开走原 renderer。
		if (this.expanded === true) {
			return patch.toolOriginalRender.call(this, width);
		}
		return [];
	};

	patch.toolInstalledUpdateDisplay = function (this: any) {
		const id = String(this.toolCallId ?? "");
		if (
			patch.active &&
			config.mode === "compact" &&
			(expandedRoundToolIds.has(id) || liveSlotToolIds.has(id))
		) {
			// 用户点开的保留展开；其余（含全局展开、live 槽位接管的）继续强制折叠。
			// 槽位卡在消息更新时就接管了 id，组件后到时 setExpanded 会把它翻开，外层多出一张卡。
			if (this.expanded !== true) explicitRoundToolIds.delete(id);
			else if (!explicitRoundToolIds.has(id)) this.expanded = false;
		}
		const result = patch.toolOriginalUpdateDisplay.call(this);
		if (!patch.active) return result;
		trackedToolComponents.add(this);
		if (config.mode === "compact") syncTailForTool(id);
		return result;
	};

	patch.assertAssistantOwnership = () => {
		// compact 必须在外层：从 compact-thinking 包装器认领，或收回 mode=on/off
		// 时主动释放给 original/native 的所有权。未知外部包装器不抢，避免递归。
		if (!patch.active || assistantPrototype.updateContent === patch.assistantInstalled) return;
		const current = assistantPrototype.updateContent;
		if ((current as any)[COMPACT_THINKING_PATCH_KEY] === true) {
			patch.assistantOriginal = current;
			assistantPrototype.updateContent = patch.assistantInstalled;
			return;
		}
		if (current === patch.assistantOriginal || current === patch.assistantNative) {
			assistantPrototype.updateContent = patch.assistantInstalled;
		}
	};

	(patch.assistantInstalled as any)[PROTOTYPE_ORIGINAL_KEY] = patch.assistantNative;
	(patch.assistantInstalled as any)[PATCH_NAME_KEY] = "compact";

	patch.dispose = () => {
		if (!patch.active) return;
		patch.active = false;
		if (roundToolExpansion?.markUserExpanded === markRoundToolUserExpanded) {
			roundToolExpansion = undefined;
		}
		if (assistantPrototype.updateContent === patch.assistantInstalled) {
			assistantPrototype.updateContent = patch.assistantOriginal;
		}
		if (toolPrototype.render === patch.toolInstalledRender) {
			toolPrototype.render = patch.toolOriginalRender;
		}
		if (toolPrototype.updateDisplay === patch.toolInstalledUpdateDisplay) {
			toolPrototype.updateDisplay = patch.toolOriginalUpdateDisplay;
		}
		patchRegistry.dispose(COMPACT_MODE_PATCH_KEY, patch);
		for (const component of trackedAssistantComponents) detachAssistantExpansion(component);
		trackedAssistantComponents.clear();
		trackedToolComponents.clear();
		hoveredAssistantComponent = undefined;
		resetRounds();
	};

	assistantPrototype.updateContent = patch.assistantInstalled;
	toolPrototype.render = patch.toolInstalledRender;
	toolPrototype.updateDisplay = patch.toolInstalledUpdateDisplay;
	patchRegistry.install(COMPACT_MODE_PATCH_KEY, patch);

	const syncGlobalExpanded = (ctx: any): void => {
		let globalExpanded = false;
		try {
			globalExpanded = ctx?.ui?.getToolsExpanded?.() === true;
		} catch {
			// 测试或无 UI 上下文时保持折叠。
		}
		for (const component of trackedAssistantComponents) component.expanded = globalExpanded;
		for (const component of trackedToolComponents) component.expanded = globalExpanded;
	};

	return {
		sync(ctx: any) {
			if (!patch.active) return;
			uiRef = ctx?.ui;
			if (typeof ctx?.isIdle === "function") idleRef = () => ctx.isIdle() === true;
			resetRounds();
			// 始终保持补丁在链上：mode=on/off 走 passThrough，仍写入 lastMessage
			// 与 tracked 集合，这样 /ccstyle 切回 compact 时不必 /reload。
			patch.assertAssistantOwnership();
			if (config.mode === "compact") syncGlobalExpanded(ctx);
			else hoveredAssistantComponent = undefined;
			refreshTrackedComponents();
			sweepOrphanTails();
			settleTrailingRound();
		},
		refresh() {
			if (!patch.active) return;
			resetRounds();
			patch.assertAssistantOwnership();
			if (config.mode !== "compact") hoveredAssistantComponent = undefined;
			refreshTrackedComponents();
			sweepOrphanTails();
			settleTrailingRound();
		},
		assertOwnership() {
			if (!patch.active) return;
			patch.assertAssistantOwnership();
		},
		refreshToolCallMessage(toolCallId: string | undefined) {
			if (!patch.active || typeof toolCallId !== "string" || !toolCallId) return;
			for (const component of [...trackedAssistantComponents]) {
				const message = component.lastMessage;
				const contains =
					Array.isArray(message?.content) &&
					message.content.some((item: any) => item?.type === "toolCall" && item.id === toolCallId);
				if (!contains) continue;
				try {
					component.updateContent?.(message);
				} catch {
					trackedAssistantComponents.delete(component);
				}
			}
		},
		settleIdleRound() {
			if (!patch.active || config.mode !== "compact") return;
			settleTrailingRound();
		},
		settleFinishedRound() {
			if (!patch.active || config.mode !== "compact") return;
			const round = activeRound;
			if (!round) return;
			// 走静默期：摘要行当场翻成 Ran for，槽位卡多留一拍再收拢。
			endRound(round, true);
			renderRound(round);
		},
		shutdown() {
			patch.dispose();
		},
	};
}

function refreshTrackedComponents(): void {
	for (const component of [...trackedAssistantComponents]) {
		try {
			if (config.mode !== "compact") detachAssistantExpansion(component);
			refreshTranscriptComponent(component);
		} catch {
			trackedAssistantComponents.delete(component);
		}
	}
	for (const component of [...trackedToolComponents]) {
		try {
			// 共享实现负责 updateDisplay；invalidate 属于 compact-mode 的跟踪语义。
			refreshTranscriptComponent(component);
			component.invalidate?.();
		} catch {
			trackedToolComponents.delete(component);
		}
	}
}

/** 供 renderer/index.ts 在 session 事件后收集 /reload 重建的组件。 */
export function refreshCompactModeComponents(root: any): void {
	collectMountedComponents(root);
}
