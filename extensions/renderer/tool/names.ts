import { posix, win32 } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { config } from "../../config/config.ts";
import { resolveAgentTitle } from "../../feature/reference/agent-titles.ts";
import { oneLine } from "../../utils/format.ts";

function clip(value: unknown): string {
	return oneLine(value, config.inputClip);
}

/**
 * 工具名/标签人性化：与 default-mode 的 humanizeToolLabel、grouping 的 humanizeToolName
 * 逐字相同，收敛为一个共享实现。
 */
export function humanizeToolLabel(label: string): string {
	return label
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.replace(/\b\w/g, (char) => char.toUpperCase());
}

const AGENT_FAMILY_TOOL_NAMES = new Set([
	// tintinweb/pi-subagents（已卸载，保留防回切）
	"Agent",
	"Agents",
	"get_subagent_result",
	// @arhen/pi-core-subagent（7 工具；steer_subagent 与 tintinweb 重名，下方按实参兼容）
	"steer_subagent",
	"subagent",
	"subagent_status",
	"subagent_result",
	"await_subagent",
	"reply_subagent",
	"subagent_cancel",
]);

/** agent 家族 ID 型工具的取值键（tintinweb agent_id / arhen runId+taskId 兼容；首个命中进标题）。 */
const AGENT_ID_KEYS: Record<string, readonly string[]> = {
	Agent: ["agent_id"],
	Agents: ["agent_id"],
	get_subagent_result: ["agent_id"],
	subagent_status: ["runId"],
	subagent_result: ["runId", "taskId"],
	await_subagent: ["runId"],
	reply_subagent: ["taskId", "runId"],
	steer_subagent: ["agent_id", "taskId", "runId"],
	subagent_cancel: ["runId"],
};

/** agent 家族 ID 型摘要；无 ID 回 undefined 走后续通用逻辑。 */
function agentIdSummary(
	title: string,
	toolName: string,
	args: any,
): { main: string; detail: string } | undefined {
	const keys = AGENT_ID_KEYS[toolName];
	if (!keys) return undefined;
	const ids = keys
		.map((key) => args?.[key])
		.filter((value): value is string => typeof value === "string" && value.length > 0);
	if (ids.length === 0) return undefined;
	const [first, second] = ids;
	// tintinweb agent_id：优先换 subagent 标题（subagents:created 映射），
	// 不要裸 UUID；无映射回 8 位短 ID。
	if (toolName !== "subagent" && args?.agent_id === first) {
		const resolved = resolveAgentTitle(first);
		if (resolved) return { main: `${title} ${clip(resolved)}`, detail: "" };
		return { main: `${title} ${clip(shortAgentId(first))}`, detail: "" };
	}
	return {
		main: `${title} ${clip(first)}`,
		detail: second && second !== first ? clip(second) : "",
	};
}

/** 长 ID 只留前 8 位（tintinweb agent_id 17 位；短 ID 原样）。 */
function shortAgentId(id: string): string {
	return id.length > 12 ? id.slice(0, 8) : id;
}

/**
 * arhen `subagent` 派生摘要：人名优先，无 UUID。
 * `single api-reviewer` / `parallel 3 · api-mapper` / `graph 2` / `chain 2`。
 */
function subagentSpawnPlan(args: any): string {
	if (Array.isArray(args?.chain)) return `chain ${args.chain.length}`;
	const tasks = Array.isArray(args?.tasks) ? args.tasks : [];
	if (tasks.length > 0) {
		if (tasks.length === 1) {
			const only = tasks[0];
			if (only && typeof only.agent === "string" && only.agent) return `single ${only.agent}`;
			return "single task";
		}
		const hasEdges = tasks.some((task: any) => Array.isArray(task?.needs) && task.needs.length > 0);
		const first = tasks.find((task: any) => typeof task?.agent === "string" && task.agent);
		return `${hasEdges ? "graph" : "parallel"} ${tasks.length}${first ? ` · ${first.agent}` : ""}`;
	}
	if (typeof args?.agent === "string" && args.agent) return `single ${args.agent}`;
	return "launch";
}

/** default-mode（单工具卡）与 grouping（分组卡）在 agent/bash/grep/find/read/fallback 文案上不同。 */
export type ToolCallSummaryVariant = "default" | "grouping";

export type ToolCallSummaryOptions = {
	/** 已解析标题；缺省为 humanizeToolLabel(toolName)。 */
	title?: string;
	/** 文案变体；缺省 "default"。 */
	variant?: ToolCallSummaryVariant;
	/** 工具执行目录；仅用于生成展示路径，不修改调用参数。 */
	cwd?: string;
};

export type ToolCallSummary = {
	main: string;
	detail: string;
	/** 路径摘要保留结构，供最终渲染按实际宽度优先保留文件名。 */
	path?: { prefix: string; value: string };
};

function pathApi(value: string) {
	if (win32.isAbsolute(value)) return win32;
	if (posix.isAbsolute(value)) return posix;
	return undefined;
}

/** cwd 内绝对路径转相对路径；cwd 外路径保持不变。 */
export function displayPath(value: unknown, cwd?: string): string {
	const text = oneLine(value, 4096);
	const base = cwd ? oneLine(cwd, 4096) : "";
	const api = pathApi(text);
	if (!api || !base || !api.isAbsolute(base)) return text;
	const relative = api.relative(base, text);
	if (!relative) return api.basename(text) || ".";
	if (relative === ".." || relative.startsWith(`..${api.sep}`) || api.isAbsolute(relative)) {
		return text;
	}
	return relative;
}

function headToWidth(text: string, width: number, ellipsis = ""): string {
	if (visibleWidth(text) <= width) return text;
	if (width <= 0) return "";
	const suffix = visibleWidth(ellipsis) <= width ? ellipsis : "";
	const contentWidth = width - visibleWidth(suffix);
	let head = "";
	for (const char of Array.from(text)) {
		if (visibleWidth(head + char) > contentWidth) break;
		head += char;
	}
	return head + suffix;
}

function tailToWidth(text: string, width: number): string {
	if (width <= 0) return "";
	let tail = "";
	for (const char of Array.from(text).reverse()) {
		if (visibleWidth(char + tail) > width) break;
		tail = char + tail;
	}
	return tail;
}

/** 中间截断路径：目录保留开头，末尾优先完整保留文件名。 */
export function truncatePathToWidth(path: string, width: number): string {
	if (visibleWidth(path) <= width) return path;
	if (width <= 1) return width === 1 ? "…" : "";
	const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	const filename = separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
	const filenameWidth = visibleWidth(filename);
	if (separatorIndex >= 0 && filenameWidth + 1 <= width) {
		const separator = path[separatorIndex]!;
		const suffix = `${separator}${filename}`;
		const prefixWidth = width - visibleWidth(suffix) - 1;
		const prefix = headToWidth(path.slice(0, separatorIndex), Math.max(0, prefixWidth));
		return `${prefix}…${prefix ? suffix : filename}`;
	}
	const leftWidth = Math.max(1, Math.floor((width - 1) * 0.45));
	const rightWidth = Math.max(0, width - leftWidth - 1);
	return `${headToWidth(filename, leftWidth)}…${tailToWidth(filename, rightWidth)}`;
}

/** 路径展示的统一入口：相对化后按配置和当前可用宽度截断。 */
export function formatDisplayPath(value: unknown, cwd: string | undefined, width: number): string {
	return truncatePathToWidth(displayPath(value, cwd), Math.min(width, config.inputClip));
}

/** 按最终终端宽度渲染摘要；路径摘要不会再被整行头部截断。 */
export function fitToolCallSummary(summary: ToolCallSummary, width: number): string {
	if (!summary.path) return headToWidth(summary.main, width, "…");
	const prefix = summary.path.prefix;
	const pathWidth = Math.max(0, width - visibleWidth(prefix) - 1);
	if (pathWidth <= 0) return headToWidth(prefix, width, "…");
	return `${prefix} ${truncatePathToWidth(summary.path.value, Math.min(pathWidth, config.inputClip))}`;
}

function pathSummary(
	prefix: string,
	value: unknown,
	cwd: string | undefined,
	detail = "",
): ToolCallSummary {
	const path = displayPath(value, cwd);
	return {
		main: `${prefix} ${truncatePathToWidth(path, config.inputClip)}`,
		detail,
		path: { prefix, value: path },
	};
}

/**
 * 单工具调用摘要（{ main, detail }）。
 *
 * default-mode 与 grouping 共用；opts.variant 保留两处各自逐字一致的输出，
 * 不改动任何现有渲染字符串。
 */
export function toolCallSummary(
	toolName: string,
	args: any,
	opts: ToolCallSummaryOptions = {},
): ToolCallSummary {
	const title = opts.title ?? humanizeToolLabel(toolName);
	const variant = opts.variant ?? "default";
	if (!args || typeof args !== "object") return { main: title, detail: "" };
	const name = toolName.toLowerCase();
	const value = (fallback: string, ...keys: string[]) => {
		const found = keys.map((key) => args[key]).find((item) => typeof item === "string" && item);
		return `${title} ${clip(found || fallback)}`;
	};

	if (variant === "default" && AGENT_FAMILY_TOOL_NAMES.has(toolName)) {
		if (name === "subagent") return { main: `${title} ${subagentSpawnPlan(args)}`, detail: "" };
		const idSummary = agentIdSummary(title, toolName, args);
		if (idSummary) return idSummary;
	}
	if (variant === "grouping" && (name === "agent" || name === "agents")) {
		const displayName = args.subagent_type ?? args.agent_type ?? args.agent;
		if (typeof displayName === "string" && displayName) {
			return { main: `${title} ${displayName}`, detail: "" };
		}
		return {
			main: value(name === "agent" ? "launch agent" : "launch agents", "description", "prompt"),
			detail: "",
		};
	}
	if (variant === "grouping" && name === "subagent") {
		return { main: `${title} ${subagentSpawnPlan(args)}`, detail: "" };
	}
	if (variant === "grouping" && AGENT_FAMILY_TOOL_NAMES.has(toolName)) {
		return (
			agentIdSummary(title, toolName, args) ?? {
				main: value("agent task", "runId", "agent_id", "taskId"),
				detail: "",
			}
		);
	}
	if (variant === "default" && name === "agents") {
		return { main: value("launch agents", "description", "prompt"), detail: "" };
	}
	if (name === "skill") return { main: value("run skill", "name"), detail: "" };
	if (name === "enterplanmode" || name === "enter_plan_mode") {
		return { main: `${title} enable read-only planning`, detail: "" };
	}
	if (name === "exitplanmode" || name === "exit_plan_mode") {
		return { main: `${title} present plan`, detail: "" };
	}
	if (name === "taskcreate") return { main: value("create task", "subject"), detail: "" };
	if (name === "tasklist") return { main: `${title} task list`, detail: "" };
	if (name === "taskget" || name === "taskupdate") {
		return { main: value("task", "taskId", "task_id"), detail: "" };
	}
	if (name === "taskoutput" || name === "taskstop") {
		return { main: value("background task", "task_id", "taskId"), detail: "" };
	}
	if (name === "taskexecute") {
		const ids = Array.isArray(args.task_ids)
			? args.task_ids
			: Array.isArray(args.taskIds)
				? args.taskIds
				: [];
		const summary = ids.length
			? `${ids[0]}${ids.length > 1 ? ` (+${ids.length - 1} tasks)` : ""}`
			: "start tasks";
		return { main: `${title} ${summary}`, detail: "" };
	}
	if (toolName === "read") {
		const details = [
			args.offset !== undefined ? `offset=${args.offset}` : "",
			args.limit !== undefined ? `limit=${args.limit}` : "",
		].filter(Boolean);
		const detail = details.length ? ` (${details.join(", ")})` : "";
		if (typeof args.path === "string" && args.path) {
			return pathSummary(variant === "grouping" ? "Read" : title, args.path, opts.cwd, detail);
		}
		return {
			main: variant === "grouping" ? "Read ..." : title,
			detail,
		};
	}
	if (variant === "grouping") {
		if (toolName === "bash") return { main: `Bash ${clip(args.command || "...")}`, detail: "" };
		if (toolName === "grep") {
			const pattern = clip(args.pattern || "...");
			return {
				main: `Grep ${JSON.stringify(pattern)}${args.path ? ` in ${clip(args.path)}` : ""}`,
				detail: "",
			};
		}
		if (toolName === "find") {
			const pattern = clip(args.pattern || "...");
			return {
				main: `Find ${JSON.stringify(pattern)}${args.path ? ` in ${clip(args.path)}` : ""}`,
				detail: "",
			};
		}
	}
	if (variant === "default") {
		const preferredPath = args.path ?? args.file_path;
		if (typeof preferredPath === "string" && preferredPath) {
			return pathSummary(title, preferredPath, opts.cwd);
		}
		const preferred =
			args.command ??
			args.query ??
			args.question ??
			args.pattern ??
			args.url ??
			args.name ??
			args.tool_use_id ??
			args.toolCallId ??
			args.id ??
			args.message;
		return {
			main:
				preferred !== undefined && preferred !== null && typeof preferred !== "object"
					? `${title} ${clip(preferred)}`
					: title,
			detail: "",
		};
	}
	const preferred =
		args.agent_id ??
		args.path ??
		args.file_path ??
		args.url ??
		args.description ??
		args.query ??
		args.name ??
		args.prompt;
	return {
		main: `${title}${preferred === undefined ? "" : ` ${clip(preferred)}`}`,
		detail: "",
	};
}
