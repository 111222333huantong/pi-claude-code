import { isAbsolute, posix, resolve, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { getKeybindings, hyperlink, visibleWidth } from "@earendil-works/pi-tui";
import { config } from "../../config/config.ts";
import { resolveAgentTitle } from "../../feature/reference/agent-titles.ts";
import { oneLine } from "../../utils/format.ts";
import { sanitizeToolResultText } from "../../utils/tool-result-sanitize.ts";
import { headTruncateToWidth } from "./result.ts";

/** toolLabelClip=0 时不设字符上限，交给渲染时的实际宽度截断。 */
function clipLimit(): number {
	return config.toolLabelClip > 0 ? config.toolLabelClip : Number.POSITIVE_INFINITY;
}

function clip(value: unknown): string {
	return oneLine(value, clipLimit());
}

/** 载荷（入参 JSON / 脚本代码 / 路径值）至少留出这么多宽度才显示，否则整段省略（避免只剩一个孤零零的 " {…"）。 */
const MIN_PAYLOAD_WIDTH = 10;

/** 品牌大小写固定写法；humanize 推导不出来的工具名写在这里。 */
const TOOL_LABEL_OVERRIDES: Readonly<Record<string, string>> = {
	powershell: "PowerShell",
	// MCP 入口两个没有具体工具名，跟普通工具一样人性化；缩写固定大写
	mcp: "MCP",
	mcpscript: "MCP Script",
	// pi-subagents 的 Agent 工具标题写 Subagent，与结束通知的 Subagent Finished 叫法一致。
	agent: "Subagent",
	agents: "Subagents",
};

/**
 * 工具名/标签人性化：与 default-mode 的 humanizeToolLabel、grouping 的 humanizeToolName
 * 逐字相同，收敛为一个共享实现。
 */
export function humanizeToolLabel(label: string): string {
	const brand = TOOL_LABEL_OVERRIDES[label.toLowerCase()];
	if (brand) return brand;
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
 * MCP 工具名人性化（与 default-mode 同名函数同实现，收敛到此共享）。
 * 去 mcp 前缀分段后 Title Case；无有效分段回 "MCP"。
 */
export function humanizeMcpToolName(toolName: string): string {
	const words = toolName
		.replace(/^mcp(?:[_:-]+)+/i, "")
		.split(/[_:-]+/)
		.filter(Boolean);
	return words.length
		? words.map((word) => word[0]!.toUpperCase() + word.slice(1)).join(" ")
		: "MCP";
}

/** 仅凭名字/title 的 MCP 判定（definition 版见 default-mode isMcpToolDefinition）。 */
export function isMcpToolName(toolName: string, title?: string): boolean {
	if (toolName === "mcp" || /^mcp[_:-]/i.test(toolName) || /[_:-]mcp[_:-]/i.test(toolName)) {
		return true;
	}
	if (toolName.includes(":")) return true;
	if (/^ctx_/i.test(toolName)) return true;
	if (title && /^MCP(?::|\s)/.test(title.trim())) return true;
	return false;
}

function mcpArgText(value: unknown): string {
	return typeof value === "string" && value ? value : "";
}

/** name==="mcp" 代理工具按实参解析调用目标（思想重写自 pi-tool-display）。 */
function mcpProxyTarget(args: any): string {
	const tool = mcpArgText(args?.tool);
	const connect = mcpArgText(args?.connect);
	const describe = mcpArgText(args?.describe);
	const search = mcpArgText(args?.search);
	const server = mcpArgText(args?.server);
	if (tool) return server ? `call ${server}:${tool}` : `call ${tool}`;
	if (connect) return `connect ${connect}`;
	if (describe) return server ? `describe ${describe} @${server}` : `describe ${describe}`;
	if (search) return server ? `search "${search}" @${server}` : `search "${search}"`;
	if (server) return `tools ${server}`;
	return "status";
}

function mcpWithArgCount(main: string, args: any): ToolCallSummary {
	const count = args && typeof args === "object" ? Object.keys(args).length : 0;
	// detail 自带前导空格：标题行直接拼接 main + detail（与 read 的 offset detail 同约定）。
	return { main, detail: count === 0 ? " (no args)" : ` (${count} arg${count === 1 ? "" : "s"})` };
}

/**
 * MCP 调用摘要（`MCP <target> + (N args)`），非 MCP 回 undefined。
 * target 优先代理实参解析，其次名字人性化，最后回落 "MCP " 标题去前缀。
 */
export function mcpCallSummary(
	toolName: string,
	title: string,
	args: any,
): ToolCallSummary | undefined {
	if (toolName === "mcp" && args && typeof args === "object") {
		return mcpWithArgCount(`MCP ${mcpProxyTarget(args)}`, args);
	}
	if (
		/^mcp[_:-]/i.test(toolName) ||
		/[_:-]mcp[_:-]/i.test(toolName) ||
		toolName.includes(":") ||
		/^ctx_/i.test(toolName)
	) {
		// 单卡调用方已用 mcpToolTitle 解析出真实工具名（与传入 title 原样相等），直接用；
		// 分组行等没传标题的才走人性化。
		const resolved = title === toolName ? title : `MCP ${humanizeMcpToolName(toolName)}`;
		return mcpWithArgCount(resolved, args);
	}
	const bareTitle = title.replace(/^MCP(?::|\s)+/i, "").trim();
	if (bareTitle !== title.trim()) {
		return mcpWithArgCount(`MCP ${bareTitle || "MCP"}`, args);
	}
	return undefined;
}

/** 首个实操行判定：跳过注释/set/cd/export/赋值/块关键字（思想重写自 pi-cc-tools）。 */
const BASH_HEADLINE_SKIP_RE =
	/^(?:#|set(?:\s|$)|cd(?:\s|$)|export(?:\s|$)|(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=|(?:\{|\}|\bdo\b|\bdone\b|\bthen\b|\bfi\b|\besac\b)$)/;

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
	path?: { prefix: string; value: string; absolute?: string };
	/** 标题之外的原始载荷（完整入参 JSON、脚本代码…），已压成单行，渲染时用 muted 接在标题后。 */
	payload?: string;
};

function pathApi(value: string) {
	if (posix.isAbsolute(value)) return posix;
	if (win32.isAbsolute(value)) return win32;
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
	return truncatePathToWidth(displayPath(value, cwd), Math.min(width, clipLimit()));
}

/** 头尾保留式摘要（65% 头 + … + 尾），CJK 按列宽算。 */
function summarizeHeadTail(text: string, max: number): string {
	if (visibleWidth(text) <= max) return text;
	if (max <= 1) return "…";
	const headWidth = Math.max(1, Math.ceil(((max - 1) * 65) / 100));
	const tailWidth = Math.max(0, max - 1 - headWidth);
	return `${headToWidth(text, headWidth)}…${tailToWidth(text, tailWidth)}`;
}

/**
 * bash 标题 headline：去控制字符/多空白后取首个实操行，超长头尾保留；
 * 多行脚本缀 `· N lines`。空命令回 undefined（调用方回落默认标题）。
 */
export function bashHeadline(command: unknown): string | undefined {
	if (typeof command !== "string" || !command.trim()) return undefined;
	const lines = command
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => sanitizeToolResultText(line, 4096).replace(/\s+/g, " ").trim())
		.filter((line) => line.length > 0);
	if (lines.length === 0) return undefined;
	const operative = lines.find((line) => !BASH_HEADLINE_SKIP_RE.test(line)) ?? lines[0]!;
	const head = summarizeHeadTail(operative, clipLimit());
	return lines.length > 1 ? `${head} · ${lines.length} lines` : head;
}

/**
 * 大概率无输出的命令前缀（cd/mkdir/安装类…；含 PowerShell 同义 cmdlet）。
 * 落定无输出时收敛为 `command completed (no output)`（思想重写自 pi-tool-display）。
 */
const QUIET_COMMAND_PREFIXES = [
	"cd",
	"mkdir",
	"rmdir",
	"rm",
	"mv",
	"cp",
	"touch",
	"chmod",
	"chown",
	"git add",
	"git checkout",
	"git switch",
	"git restore",
	"git reset",
	"git clean",
	"npm install",
	"pnpm install",
	"yarn install",
	"bun install",
	"pip install",
	"poetry install",
	"cargo fetch",
	"go mod tidy",
	"Set-Location",
	"New-Item",
	"Remove-Item",
	"Move-Item",
	"Copy-Item",
] as const;

/** 首个 && / || / ; 分段命中 quiet 前缀即判 quiet（大小写不敏感）。 */
export function isLikelyQuietCommand(command: unknown): boolean {
	if (typeof command !== "string") return false;
	const normalized = command.trim().toLowerCase();
	if (!normalized) return false;
	const primary =
		normalized
			.split(/&&|\|\||;/)
			.map((segment) => segment.trim())
			.find((segment) => segment.length > 0) ?? "";
	if (!primary) return false;
	return QUIET_COMMAND_PREFIXES.some(
		(prefix) => primary === prefix.toLowerCase() || primary.startsWith(`${prefix.toLowerCase()} `),
	);
}

/** 按最终终端宽度渲染摘要；路径摘要不会再被整行头部截断。 */
export function fitToolCallSummary(summary: ToolCallSummary, width: number): string {
	if (!summary.path) return headToWidth(summary.main, width, "…");
	const prefix = summary.path.prefix;
	const pathWidth = Math.max(0, width - visibleWidth(prefix) - 1);
	if (pathWidth <= 0) return headToWidth(prefix, width, "…");
	const shown = truncatePathToWidth(summary.path.value, Math.min(pathWidth, clipLimit()));
	return `${prefix} ${linkPath(shown, summary.path.absolute)}`;
}

/** OSC8 文件超链接：先截断再包（序列零宽，不断行）；关开关或无绝对路径时原文。 */
function linkPath(display: string, absolute: string | undefined): string {
	if (!config.enablePathHyperlinks || !absolute) return display;
	try {
		return hyperlink(display, pathToFileURL(absolute).toString());
	} catch {
		return display;
	}
}

/** 展示路径对应的绝对路径（相对路径按 cwd 解析），解析失败回 undefined。 */
function absoluteOf(value: unknown, cwd: string | undefined): string | undefined {
	if (typeof value !== "string" || !value) return undefined;
	try {
		if (isAbsolute(value)) return value;
		return resolve(cwd || process.cwd(), value);
	} catch {
		return undefined;
	}
}

function pathSummary(
	prefix: string,
	value: unknown,
	cwd: string | undefined,
	detail = "",
): ToolCallSummary {
	const path = displayPath(value, cwd);
	// main 只留标题：渲染时 prefix 用标题色、路径值用次级色，截断按 path 结构走中间省略。
	return { main: prefix, detail, path: { prefix, value: path, absolute: absoluteOf(value, cwd) } };
}

/** 入参是 shell 命令的工具。 */
export const SHELL_TOOL_NAMES = new Set(["bash", "powershell", "pwsh", "sh", "zsh", "cmd"]);

/** 内置检索工具：pattern 缺失（无效调用）时保留 "…" 占位。 */
const SEARCH_TOOL_NAMES = new Set(["grep", "find"]);

/**
 * 通用摘要字段优先级：default 与 grouping 共用同一份取值链。
 * 两处曾各自维护，grouping 因此漏掉 command（powershell）和数组型入参；
 * 路径不在链上，由 pathSummary 兜底，以便按 cwd 相对化并中间截断。
 */
const GENERIC_SUMMARY_FIELDS = [
	"agent_id",
	"command",
	"query",
	"queries",
	"claim",
	"question",
	"questions",
	"url",
	"urls",
	"responseId",
	"findText",
	"name",
	"tool_use_id",
	"toolCallId",
	"id",
	"subject",
	"taskId",
	"task_id",
	"message",
	"description",
	"prompt",
] as const;

/** 通用字段链取值：字符串直接用；数组取首个可展示项并标注剩余条数。 */
type SummaryValue = { text: string; more: number; input: boolean };

function arrayItemText(item: unknown): string | undefined {
	if (typeof item === "string" && item) return item;
	if (!item || typeof item !== "object") return undefined;
	for (const key of ["query", "url", "question", "header", "name"] as const) {
		const text = (item as Record<string, unknown>)[key];
		if (typeof text === "string" && text) return text;
	}
	return undefined;
}

function summaryFieldValue(value: unknown): SummaryValue | undefined {
	if (typeof value === "string" && value) return { text: value, more: 0, input: true };
	if (!Array.isArray(value)) return undefined;
	let first: string | undefined;
	let count = 0;
	for (const item of value) {
		const text = arrayItemText(item);
		if (!text) continue;
		count += 1;
		first ??= text;
	}
	return first === undefined ? undefined : { text: first, more: count - 1, input: true };
}

/** 通用字段链取值；无可用字段时返回 undefined，交给调用方继续降级。 */
function genericSummary(title: string, args: any): ToolCallSummary | undefined {
	for (const key of GENERIC_SUMMARY_FIELDS) {
		const found = summaryFieldValue(args[key]);
		if (!found) continue;
		// (+N) 追加在截断之后，避免首个元素过长时把条数挤没
		const more = found.more > 0 ? ` (+${found.more})` : "";
		return { main: title, detail: "", payload: `${clip(found.text)}${more}` };
	}
	return undefined;
}

/**
 * 单工具调用摘要（{ main, detail }）。
 *
 * 两个变体共用同一份取值链，只有 read/agent/skill/task 等具名分支存在必要差异。
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

	// MCP 入口沿用 mcp-adapter 自己的标题风格（adapter 的 formatMcpProxyToolCallLines）：
	// `MCP <动作> <目标>` / `MCP Script <代码>`，比把整包参数摊成 JSON 好读
	if (name === "mcp") {
		const gateway = mcpGatewaySummary(title, args);
		if (gateway) return gateway;
	}
	if (name === "mcpscript") {
		const code = typeof args.code === "string" && args.code ? clip(args.code) : "";
		return code ? { main: title, detail: "", payload: code } : { main: title, detail: "" };
	}
	// 内置 codemode：标题只报工具名。脚本很长，塞进行首既挤又读不出重点；
	// 要看代码展开 Input，要看跑了什么看子调用行。
	if (name === "codemode") return { main: title, detail: "" };

	const value = (fallback: string, ...keys: string[]) => {
		const found = keys.map((key) => args[key]).find((item) => typeof item === "string" && item);
		return { main: title, detail: "", payload: clip(found || fallback) };
	};

	if (variant === "default" && AGENT_FAMILY_TOOL_NAMES.has(toolName)) {
		if (name === "subagent") return { main: `${title} ${subagentSpawnPlan(args)}`, detail: "" };
		const idSummary = agentIdSummary(title, toolName, args);
		if (idSummary) return idSummary;
	}
	if (name === "agent" || name === "agents") {
		const displayName = args.subagent_type ?? args.agent_type ?? args.agent;
		const description =
			typeof args.description === "string" ? oneLine(args.description, clipLimit()) : "";
		if (typeof displayName === "string" && displayName) {
			// 类型进标题，`·` 分隔后描述作灰色载荷：单卡与组内行同一写法。
			return {
				main: `${title} ${displayName}`,
				detail: "",
				payload: description ? `\u00b7 ${description}` : undefined,
			};
		}
		return value(name === "agent" ? "launch agent" : "launch agents", "description", "prompt");
	}
	if (variant === "grouping" && name === "subagent") {
		return { main: `${title} ${subagentSpawnPlan(args)}`, detail: "" };
	}
	if (variant === "grouping" && AGENT_FAMILY_TOOL_NAMES.has(toolName)) {
		return (
			agentIdSummary(title, toolName, args) ?? value("agent task", "runId", "agent_id", "taskId")
		);
	}
	if (name === "skill") return value("run skill", "name");
	if (name === "enterplanmode" || name === "enter_plan_mode") {
		return { main: title, detail: "", payload: "enable read-only planning" };
	}
	// MCP：单卡已由 mcpToolTitle 解析出真实名（opts.title 原样传入）则尊重；
	// 无显式标题时走本地人性化 MCP 行。
	if (opts.title === undefined) {
		const mcp = mcpCallSummary(toolName, title, args);
		if (mcp) return mcp;
	}
	if (name === "exitplanmode" || name === "exit_plan_mode") {
		return { main: title, detail: "", payload: "present plan" };
	}
	if (name === "taskcreate") return value("create task", "subject");
	if (name === "tasklist") return { main: title, detail: "", payload: "task list" };
	if (name === "taskget" || name === "taskupdate") {
		return value("task", "taskId", "task_id");
	}
	if (name === "taskoutput" || name === "taskstop") {
		return value("background task", "task_id", "taskId");
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
		return { main: title, detail: "", payload: summary };
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
			main: variant === "grouping" ? "Read" : title,
			detail,
			payload: variant === "grouping" ? "..." : undefined,
		};
	}
	if (variant === "grouping") {
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
	if (variant === "grouping" && SHELL_TOOL_NAMES.has(name)) {
		// 分组行缺 command 时保留占位，避免与单工具卡一样只剩标题
		return value("...", "command");
	}

	// 检索类：pattern 是正文，path 只是范围；两个变体同格式
	if (typeof args.pattern === "string" || SEARCH_TOOL_NAMES.has(name)) {
		const pattern = clip(args.pattern || "...");
		const scope = typeof args.path === "string" && args.path ? ` in ${clip(args.path)}` : "";
		return { main: title, detail: "", payload: `${JSON.stringify(pattern)}${scope}` };
	}

	const generic = genericSummary(title, args);
	if (generic) return generic;

	const preferredPath = args.path ?? args.file_path;
	if (typeof preferredPath === "string" && preferredPath) {
		return pathSummary(title, preferredPath, opts.cwd);
	}

	// 字段链认不出的参数（命名空间代理的 tool+args、第三方工具的自定义键…）展开完整入参 JSON，
	// 而不是只剩一个标题；网关与脚本的专属形状在上面处理
	const payload = jsonArgs(args);
	return payload ? { main: title, detail: "", payload } : { main: title, detail: "" };
}

/**
 * MCP 网关注解 `mcp <动作> <目标>`：动作与目标照搬 mcp-adapter 的 formatMcpProxyToolCallLines，
 * 人眼读起来比参数 JSON 快；`instructions` 是 adapter 自己漏掉的一档（它那里会落到 mcp status）。
 * 认不出的入参返回 undefined，交给通用 JSON 回退，不猜成 status。
 */
function mcpGatewaySummary(title: string, args: any): ToolCallSummary | undefined {
	const text = (value: unknown) => (typeof value === "string" && value ? value : "");
	const tool = text(args.tool);
	const connect = text(args.connect);
	const describe = text(args.describe);
	const instructions = text(args.instructions);
	const search = text(args.search);
	const server = text(args.server);
	const action = text(args.action);
	const scoped = (target: string) => (server ? `${target} @ ${server}` : target);

	if (action === "ui-messages") return { main: title, detail: "", payload: action };
	if (tool) {
		const argsPayload = innerArgsPayload(args.args);
		const payload = argsPayload ? `call ${scoped(tool)} ${argsPayload}` : `call ${scoped(tool)}`;
		return { main: title, detail: "", payload };
	}
	if (connect) return { main: title, detail: "", payload: `connect ${connect}` };
	if (describe) return { main: title, detail: "", payload: `describe ${scoped(describe)}` };
	if (instructions) return { main: title, detail: "", payload: `instructions ${instructions}` };
	if (search) {
		const flags = [
			args.regex === true ? "regex" : "",
			args.includeSchemas === false ? "schemas hidden" : "",
		].filter(Boolean);
		return {
			main: title,
			detail: flags.length ? ` (${flags.join(", ")})` : "",
			payload: `search ${scoped(search)}`,
		};
	}
	if (server) return { main: title, detail: "", payload: `list ${server}` };
	if (action) return { main: title, detail: "", payload: action };
	if (Object.keys(args).length === 0) return { main: title, detail: "", payload: "status" };
	return undefined;
}

/** 网关 call 的内层工具入参：对象转单行 JSON；网关允许传 JSON 字符串，就原样取用不再转义。 */
function innerArgsPayload(value: unknown): string {
	if (typeof value === "string") return value ? clip(value) : "";
	if (!value || typeof value !== "object") return "";
	return jsonArgs(value);
}

/** 入参序列化成单行 JSON；空对象或不可序列化时返回 ""。 */
function jsonArgs(args: any): string {
	try {
		const json = JSON.stringify(args);
		return json && json !== "{}" ? clip(json) : "";
	} catch {
		return "";
	}
}

/**
 * 标题行内容：main 是身份（工具名），用 toolTitle 色；路径值与载荷（入参 JSON、
 * 脚本代码、命令、查询…）是输入，单独用 muted。标题优先占宽，剩下的宽度给载荷；
 * 载荷超宽时尾部省略，连 MIN_PAYLOAD_WIDTH 都放不下时整段省略。
 */
export function renderToolSummary(
	summary: ToolCallSummary,
	width: number,
	fg: (color: ThemeColor, text: string) => string,
): string {
	const title = fitToolCallSummary(summary, width);
	const styledTitle = colorTitlePrefix(summary, title, fg);
	if (!summary.payload) return styledTitle;
	const room = width - visibleWidth(title);
	return room >= MIN_PAYLOAD_WIDTH
		? `${styledTitle}${fg("muted", headTruncateToWidth(` ${summary.payload}`, room))}`
		: styledTitle;
}

/**
 * CC 规则：工具名加粗强调，路径不着色（仅 OSC8 超链接）。
 * fitted 以 prefix 开头时只给 prefix 上色，余下原文（含 OSC8 序列）不动；
 * prefix 本身被截断时回落整行着色。
 */
function colorTitlePrefix(
	summary: ToolCallSummary,
	fitted: string,
	fg: (color: ThemeColor, text: string) => string,
): string {
	const prefix = summary.path?.prefix;
	if (!prefix || !fitted.startsWith(prefix)) return fg("toolTitle", fitted);
	return fg("toolTitle", prefix) + fitted.slice(prefix.length);
}

let toolTuiFullscreen: boolean | undefined;

export function setToolTuiFullscreen(value: boolean): void {
	toolTuiFullscreen = value;
}

export function isToolTuiFullscreen(): boolean {
	return toolTuiFullscreen !== false;
}

function formatKeyPart(part: string): string {
	// 与 pi 内置 keybinding-hints 一致：macOS 上 alt 显示为 option
	return process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part;
}

/** 默认展开快捷键（app.tools.expand）显示文本；未配置时回退 ctrl+o。 */
export function expandShortcutText(): string {
	const keys = getKeybindings().getKeys("app.tools.expand");
	if (keys.length === 0) return "ctrl+o";
	return keys
		.join("/")
		.split("/")
		.map((part) => part.split("+").map(formatKeyPart).join("+"))
		.join("/");
}

export function showMoreHintText(): string {
	return isToolTuiFullscreen() ? "click to show more" : `${expandShortcutText()} to show more`;
}

/** 展开卡的收起提示，与折叠态 showMoreHintText 同一位置对称。 */
export function collapseHintText(): string {
	return isToolTuiFullscreen() ? "↑ Collapse" : `${expandShortcutText()} to collapse`;
}

/** 该行是否带展开态收起提示（用于展开卡的 hint hover 命中）。 */
export function isCollapseHintLine(plainLine: string): boolean {
	return plainLine.includes(collapseHintText());
}
