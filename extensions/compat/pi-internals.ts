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

const issues: CompatIssue[] = [];
const seenIssues = new Set<string>();

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
	return drained;
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
