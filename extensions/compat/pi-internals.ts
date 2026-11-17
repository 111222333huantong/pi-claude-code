/**
 * Pi 内部接口的单点适配层。
 *
 * 本扩展是呈现层扩展，做不到全部走公开 API：工具卡外壳、分组、鼠标命中
 * 都依赖 `ToolExecutionComponent` / `Container` / `AssistantMessageComponent`
 * 的原型与实例字段。这些字段不属于 Pi 的扩展契约，patch 版本可能变化。
 *
 * 约定：
 * - 所有「原型成员是否存在」的校验集中在这里；缺失时记录一条 issue 并让
 *   调用方降级（通常是放弃该补丁、回退 Pi 原生渲染），而不是抛异常。
 * - issue 由 `drainCompatIssues()` 在 session_start 后统一提示一次。
 * - 升级 Pi 后如果只剩少量不兼容，优先改这个文件，而不是散落各处。
 */
import { AssistantMessageComponent, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, Markdown } from "@earendil-works/pi-tui";

export type CompatIssue = {
	/** 哪个功能受影响，例如 "tool-execution"。 */
	feature: string;
	/** 缺失的成员路径。 */
	missing: string;
};

/**
 * 补丁押注清单：每条补丁依赖的「上游实现坐标」。
 *
 * 这些是运行时探测之外的事前声明——探测只能发现「方法没了」，清单回答
 * 「升级 pi 时应该去 diff 哪个文件判断这条链会不会断」。升级 pi 后按
 * source 字段逐一 git diff 上游仓库即可预判漂移，不用等用户报障。
 *
 * 登记约定：每处对原型/内部字段的 patch 都必须在这里有一行；漏登记
 * 的 patch 点在 /ccstyle diag 的押注覆盖检查里会显示 uncovered。
 */
export type PatchBet = {
	/** 补丁标识（与 PATCH_NAME_KEY / feature 名对齐）。 */
	feature: string;
	/** 依赖的上游文件（pi-mono 仓库相对路径）。 */
	source: string;
	/** 依赖的成员/行为。 */
	depends: string;
	/** 首次引入该补丁时验证通过的 pi-coding-agent 版本。 */
	since: string;
};

export const PATCH_BETS: readonly PatchBet[] = [
	{
		feature: "tool-execution",
		source: "packages/coding-agent/src/modes/interactive/components/tool-execution.ts",
		depends:
			"ToolExecutionComponent.prototype.render / updateDisplay / contentBox / children / expanded / toolCallId",
		since: "1.4.0",
	},
	{
		feature: "assistant-message",
		source: "packages/coding-agent/src/modes/interactive/components/assistant-message.ts",
		depends:
			"AssistantMessageComponent.prototype.updateContent / contentContainer / markdownSlots / lastMessage / outputPad / isStreaming",
		since: "1.4.0",
	},
	{
		feature: "markdown",
		source: "packages/tui/src/components/markdown.ts",
		depends: "Markdown.prototype.render / setText / invalidate / cachedTokens WeakRef",
		since: "1.5.0",
	},
	{
		feature: "container",
		source: "packages/tui/src/tui.ts",
		depends: "Container.prototype.addChild / removeChild / clear / children 数组",
		since: "1.4.0",
	},

	{
		feature: "tool-grouping",
		source:
			"packages/coding-agent/src/modes/interactive/components/tool-execution.ts + assistant-message.ts",
		depends: "ToolExecutionComponent 在 contentContainer 中的挂载顺序 / toolCall.id 字段",
		since: "1.4.0",
	},
	{
		feature: "transcript-gutter",
		source: "packages/tui/src/tui.ts + chatContainer 布局",
		depends: "transcript 容器在组件树中的位置与直接子组件构成（消息组件识别）",
		since: "1.5.0",
	},
	{
		feature: "tool-mouse",
		source: "packages/tui/src/tui-alt-screen.ts + layout.ts",
		depends:
			"tui.currentLayout（LayoutFrame）恒等失效语义 / SGR mouse 事件流 / componentAtLocalRow 命中坐标系。" +
			"注意：上游 PR #11968（fullscreen scroll O(viewport)）拟让 renderCache 跨帧存活，" +
			"layout 对象可能改为部分复用而非每帧新建——hover/sticky 的 `layout !== tui.currentLayout`" +
			" 判失效逻辑要复查；PR #11598 的 transcript 虚拟化更可能把消息组件改为 windowed " +
			"build-factory，本 patch 面届时需整体重估",
		since: "1.5.0",
	},
	{
		feature: "main-screen-do-render",
		source: "packages/tui/src/tui-main-screen.ts",
		depends:
			"TuiMainScreen.applyLineResets / previousLines / previousViewportTop。" +
			"上游 fullscreen 已 O(viewport) 化推进中，regular 主屏差分是同类优化的下一块，" +
			"本 patch 押注的内部字段（previousLines 可变数组）若改不可变帧结构需重写",
		since: "1.5.0",
	},
	{
		feature: "editor-factory",
		source: "packages/coding-agent 的 editor 工厂链",
		depends: "setEditorComponent 一次性替换语义 / editor.handleInput 实例方法可被包装",
		since: "1.4.0",
	},
	{
		feature: "write-ownership",
		source: "packages/coding-agent 的工具注册表",
		depends: "registerTool 先到先得语义 / toolDefinition vs builtInToolDefinition 字段",
		since: "1.4.0",
	},
];

/** 押注清单查询：feature → 登记行（diag 与升级巡检共用）。 */
export function patchBetFor(feature: string): PatchBet | undefined {
	return PATCH_BETS.find((bet) => bet.feature === feature);
}

const issues: CompatIssue[] = [];
const seenIssues = new Set<string>();
/** 最近一次 drain 的内容：session_start 清空 issues 后，诊断仍能看到本会话漂移。 */
let lastIssues: CompatIssue[] = [];

export function reportCompatIssue(feature: string, missing: string): void {
	const key = `${feature}\0${missing}`;
	if (seenIssues.has(key)) return;
	seenIssues.add(key);
	issues.push({ feature, missing });
}

/** 取出并清空本次会话累积的兼容性告警。 */
export function drainCompatIssues(): CompatIssue[] {
	const drained = [...issues];
	issues.length = 0;
	seenIssues.clear();
	lastIssues = drained;
	return drained;
}

/** 最近一次 drain 的兼容性告警（诊断用，不清空）。 */
export function getCompatIssueHistory(): readonly CompatIssue[] {
	return lastIssues;
}

/** 仅供测试：查看当前累积的告警，不清空。 */
export function peekCompatIssues(): readonly CompatIssue[] {
	return issues;
}

function prototypeWith(ctor: any, methods: readonly string[], feature: string): any | undefined {
	const prototype = ctor?.prototype;
	if (!prototype) {
		reportCompatIssue(feature, "prototype");
		return undefined;
	}
	for (const method of methods) {
		if (typeof prototype[method] !== "function") {
			reportCompatIssue(feature, `prototype.${method}`);
			return undefined;
		}
	}
	return prototype;
}

export function getToolExecutionPrototype(): any | undefined {
	return prototypeWith(ToolExecutionComponent, ["render", "updateDisplay"], "tool-execution");
}

/**
 * 单个方法存在性检查，供只在某一方法上打补丁的模块使用。
 * 返回原型；方法缺失时记录 issue 并返回 undefined，调用方直接放弃补丁。
 */
export function getMethodPrototype(ctor: any, method: string, feature: string): any | undefined {
	const prototype = ctor?.prototype;
	if (!prototype) {
		reportCompatIssue(feature, "prototype");
		return undefined;
	}
	if (typeof prototype[method] !== "function") {
		reportCompatIssue(feature, `prototype.${method}`);
		return undefined;
	}
	return prototype;
}

export function getAssistantMessagePrototype(): any | undefined {
	return prototypeWith(AssistantMessageComponent, ["updateContent"], "assistant-message");
}

export function getMarkdownPrototype(): any | undefined {
	return prototypeWith(Markdown, ["render"], "markdown");
}

export function getContainerPrototype(): any | undefined {
	return prototypeWith(Container, ["addChild", "removeChild", "clear"], "container");
}

/** 工具卡外壳容器（contentBox）是 Pi 内部字段；鼠标命中与背景补丁都依赖它。 */
export function toolContentBox(tool: any): any | undefined {
	return tool?.contentBox;
}

export function toolChildren(tool: any): any[] | undefined {
	return Array.isArray(tool?.children) ? tool.children : undefined;
}

/** 扩展定义 / 内置定义：`preservesOriginalRenderer` 用它决定是否让位原生渲染。 */
export function toolDefinitions(tool: any): { extension: any; builtIn: any } {
	return {
		extension: tool?.toolDefinition,
		builtIn: tool?.builtInToolDefinition,
	};
}

/** 主屏差分渲染的视口起点；缺失时按 0 处理（坐标系退化为整缓冲）。 */
export function tuiViewportTop(tui: any): number {
	const value = Number(tui?.previousViewportTop);
	return Number.isFinite(value) ? value : 0;
}

/** 主屏上一帧的渲染行；test harness 可能没有。 */
export function tuiPreviousLines(tui: any): string[] | undefined {
	return Array.isArray(tui?.previousLines) ? (tui.previousLines as string[]) : undefined;
}

/** 终端尺寸；缺失时回落到 80×24。 */
export function tuiTerminalSize(tui: any): { columns: number; rows: number } {
	const columns = Math.max(1, Number(tui?.terminal?.columns) || 80);
	const rows = Math.max(1, Number(tui?.terminal?.rows) || Number.POSITIVE_INFINITY);
	return { columns, rows };
}
