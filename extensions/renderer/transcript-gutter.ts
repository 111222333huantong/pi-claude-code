/**
 * transcript 右缘内缩（container 层统一实现）。
 *
 * 正文/表格/代码框/工具卡/用户消息等 transcript 内容全部挂在 pi 的 chatContainer
 * 下；官方 Container.render(width) 把宽度原样传给子组件，内容因此一直顶到屏幕
 * 右缘。这里在容器实例上包装 render / handleMouse，统一把 width 平移为
 * `width − TRANSCRIPT_RIGHT_GUTTER`：右缘整体内缩 2 列，左缘不动（行从 col 0
 * 开始，宽度变化只影响折行位置）。
 *
 * 范围仅限 transcript 容器：状态栏、输入框、header 等兄弟容器满宽贴边不变。
 * 识别依据是容器的直接子组件含 transcript 消息（assistant/user/tool/custom/
 * skill/分组）；空 transcript 无从识别 → 安全 no-op，由 refreshCurrentTranscript
 * / message_update / session 事件的重扫周期补上。重复扫描幂等（实例打符号防叠加）。
 *
 * 鼠标一致性：普通模式命中基于实际绘制行（自动跟随内缩）；fullscreen 的行高重算
 * 走 mouse/layout.ts 的 componentAtLocalRow，入口经 transcriptMappingWidth 做
 * 同款宽度平移，保证折行行数与实际渲染一致（y 不漂移；x 因左缘未动天然对齐）。
 */
import {
	AssistantMessageComponent,
	CustomMessageComponent,
	SkillInvocationMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
	patchRegistry,
	TRANSCRIPT_GUTTER_PATCH_KEY,
	TRANSCRIPT_GUTTER_SLOTS,
} from "../utils/patch-keys.ts";
import { ToolGroupComponent } from "./tool/grouping.ts";

/** transcript 右缘内缩列数（只缩右，左缘保持贴边）。先落代码常量，实机不合适再调。 */
export const TRANSCRIPT_RIGHT_GUTTER = 2;

/** 平移后的子组件宽度：极窄终端下限 1，避免 render(0) 触发折行死循环。 */
function gutterWidth(width: number): number {
	return Math.max(1, width - TRANSCRIPT_RIGHT_GUTTER);
}

/** transcript 消息组件：transcript 容器的直接子节点识别依据。 */
function isTranscriptMessage(value: any): boolean {
	return (
		value instanceof AssistantMessageComponent ||
		value instanceof UserMessageComponent ||
		value instanceof ToolExecutionComponent ||
		value instanceof CustomMessageComponent ||
		value instanceof SkillInvocationMessageComponent ||
		value instanceof ToolGroupComponent
	);
}

/** 是否已安装右内缩的 transcript 容器（mouse 层行高平移的判定）。 */
export function isTranscriptGutterContainer(value: any): boolean {
	return Boolean(value && typeof value === "object" && TRANSCRIPT_GUTTER_PATCH_KEY in value);
}

/**
 * fullscreen 行高映射的入口宽度：从 gutter 容器起用缩后宽度下钻，与 render 的
 * 实际折行一致；其余组件（含父容器按全宽度量子 render 的场景）原样透传。
 */
export function transcriptMappingWidth(component: any, width: number): number {
	return isTranscriptGutterContainer(component) ? gutterWidth(width) : width;
}

type TranscriptGutterPatch = {
	originalRender: (...args: any[]) => any;
	originalHandleMouse?: (...args: any[]) => any;
	wrappedRender: (...args: any[]) => any;
	wrappedHandleMouse?: (...args: any[]) => any;
	hadOwnRender: boolean;
	hadOwnHandleMouse?: boolean;
};

function gutterSlots(): Set<any> {
	return patchRegistry.ensure(TRANSCRIPT_GUTTER_SLOTS, () => new Set<any>());
}

function hasOwn(target: any, key: string): boolean {
	return Object.hasOwn(target, key);
}

/** 实例级包装 render / handleMouse（幂等：已打符号直接登记返回）。 */
function patchTranscriptContainer(container: any): void {
	const slots = gutterSlots();
	slots.add(container);
	if (isTranscriptGutterContainer(container)) return;
	const originalRender = container.render;
	if (typeof originalRender !== "function") {
		slots.delete(container);
		return;
	}
	const hadOwnRender = hasOwn(container, "render");
	const wrappedRender = function (this: any, width: number): any {
		return originalRender.call(this, gutterWidth(width));
	};
	const patch: TranscriptGutterPatch = { originalRender, wrappedRender, hadOwnRender };
	container.render = wrappedRender;
	const originalHandleMouse = container.handleMouse;
	if (typeof originalHandleMouse === "function") {
		const hadOwnHandleMouse = hasOwn(container, "handleMouse");
		// 只平移 width：左缘未动，x 原样透传；height/y 由父层按缩后行高给定。
		const wrappedHandleMouse = function (this: any, event: any): any {
			const translated =
				event && typeof event.width === "number"
					? { ...event, width: gutterWidth(event.width) }
					: event;
			return originalHandleMouse.call(this, translated);
		};
		patch.originalHandleMouse = originalHandleMouse;
		patch.wrappedHandleMouse = wrappedHandleMouse;
		patch.hadOwnHandleMouse = hadOwnHandleMouse;
		container.handleMouse = wrappedHandleMouse;
	}
	container[TRANSCRIPT_GUTTER_PATCH_KEY] = patch;
}

/** 还原包装。第三方在本包装之上又叠加了包装时保留原状（维持渲染/鼠标一致性）。 */
function unpatchTranscriptContainer(container: any): void {
	const patch = container[TRANSCRIPT_GUTTER_PATCH_KEY] as TranscriptGutterPatch | undefined;
	if (!patch) return;
	const renderIsOurs = container.render === patch.wrappedRender;
	const mouseIsOurs =
		!patch.wrappedHandleMouse || container.handleMouse === patch.wrappedHandleMouse;
	if (!renderIsOurs || !mouseIsOurs) return;
	if (patch.hadOwnRender) container.render = patch.originalRender;
	else delete container.render;
	if (patch.wrappedHandleMouse) {
		if (patch.hadOwnHandleMouse) container.handleMouse = patch.originalHandleMouse;
		else delete container.handleMouse;
	}
	delete container[TRANSCRIPT_GUTTER_PATCH_KEY];
}

/**
 * 从 tui 根找 transcript 容器：广度优先，遇到「直接子组件含消息组件」的容器即停
 * （chatContainer 挂在 documentContainer 下，深度 ≤ 4）。空树/非 TUI 返回 null。
 */
function findTranscriptContainer(root: any): any {
	if (!root || typeof root !== "object") return null;
	const seen = new Set<any>();
	const queue: any[] = [root];
	for (let index = 0; index < queue.length; index++) {
		const node = queue[index];
		if (!node || typeof node !== "object" || seen.has(node)) continue;
		seen.add(node);
		if (Array.isArray(node)) {
			for (const child of node) queue.push(child);
			continue;
		}
		const children = node.children;
		if (Array.isArray(children)) {
			if (children.some(isTranscriptMessage)) return node;
			for (const child of children) queue.push(child);
		}
		try {
			const mounted = node.getMountedRoots?.();
			if (Array.isArray(mounted)) {
				for (const mountedRoot of mounted) queue.push(mountedRoot);
			}
		} catch {
			// renderer 切换中的惰性 Proxy 可能暂时没有 mounted roots。
		}
	}
	return null;
}

/** 扫描并安装右内缩（幂等）；root 为 null/非 TUI/空 transcript 时安全 no-op。 */
export function refreshTranscriptGutter(root: any): void {
	const container = findTranscriptContainer(root);
	if (container) patchTranscriptContainer(container);
}

/** 释放全部右内缩包装（session_shutdown 统一调用）。 */
export function disposeTranscriptGutter(): void {
	const slots = patchRegistry.get<Set<any>>(TRANSCRIPT_GUTTER_SLOTS);
	if (!slots) return;
	for (const container of slots) unpatchTranscriptContainer(container);
	patchRegistry.dispose(TRANSCRIPT_GUTTER_SLOTS, slots);
}
