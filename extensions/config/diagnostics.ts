/**
 * `/ccstyle diag`：把排查渲染问题需要的一次性信息集中成一份可复制的文本。
 *
 * 只读诊断，不修改任何状态：
 * - 版本 / 运行环境
 * - `updateContent` 补丁链顺序（谁在最外层）
 * - 各补丁槽位是否安装
 * - compat 层最近一次漂移
 * - footer 归属与配置文件路径
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AssistantMessageComponent, VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { getCompatIssueHistory } from "../compat/pi-internals.ts";
import { defaultStatuslinePath, readStatuslineConfig } from "../feature/statusline/config.ts";
import {
	ASSISTANT_DOTTED_PATCH,
	CODE_BLOCK_PATCH,
	COMPACT_MODE_PATCH_KEY,
	COMPACT_THINKING_PATCH_KEY,
	GLOBAL_TOOL_RENDER_PATCH,
	MAIN_SCREEN_DO_RENDER_PATCH,
	MESSAGE_DISPLAY_PATCH,
	PATCH_NAME_KEY,
	PROTOTYPE_ORIGINAL_KEY,
	patchRegistry,
	STREAM_THROTTLE_PATCH,
	SUBAGENT_NOTIFICATION_RENDERER_PATCH,
	TOOL_EXPANDED_BACKGROUND_PATCH,
	TOOL_GROUPING_PATCH_KEY,
	TOOL_MOUSE_OWNER_KEY,
	TRANSCRIPT_GUTTER_PATCH_KEY,
	USER_MESSAGE_PATCH,
	WRITE_OWNERSHIP_SLOT,
} from "../utils/patch-keys.ts";
import { CONFIG_PATH, config } from "./config.ts";

function extensionVersion(): string {
	try {
		const path = fileURLToPath(new URL("../../package.json", import.meta.url));
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
		return typeof parsed.version === "string" ? parsed.version : "unknown";
	} catch {
		return "unknown";
	}
}

/** 沿 `PROTOTYPE_ORIGINAL_KEY` 走出当前 assistant updateContent 的包装顺序。 */
function assistantPatchChain(): string[] {
	const names: string[] = [];
	const seen = new Set<unknown>();
	let current: any = (AssistantMessageComponent.prototype as any).updateContent;
	while (typeof current === "function" && !seen.has(current) && names.length < 16) {
		seen.add(current);
		const name = current[PATCH_NAME_KEY];
		if (typeof name === "string") names.push(name);
		const next = current[PROTOTYPE_ORIGINAL_KEY];
		if (typeof next !== "function" || next === current) break;
		current = next;
	}
	if (names.length === 0) return ["native"];
	names.push("native");
	return names;
}

const PATCH_SLOTS: ReadonlyArray<readonly [string, symbol]> = [
	["compact mode", COMPACT_MODE_PATCH_KEY],
	["compact thinking", COMPACT_THINKING_PATCH_KEY],
	["dotted paragraphs", ASSISTANT_DOTTED_PATCH],
	["stream throttle", STREAM_THROTTLE_PATCH],
	["tool grouping", TOOL_GROUPING_PATCH_KEY],
	["tool render", GLOBAL_TOOL_RENDER_PATCH],
	["message display", MESSAGE_DISPLAY_PATCH],
	["subagent notification", SUBAGENT_NOTIFICATION_RENDERER_PATCH],
	["user message", USER_MESSAGE_PATCH],
	["tool expanded background", TOOL_EXPANDED_BACKGROUND_PATCH],
	["code block", CODE_BLOCK_PATCH],
	["transcript gutter", TRANSCRIPT_GUTTER_PATCH_KEY],
	["main screen do-render", MAIN_SCREEN_DO_RENDER_PATCH],
	["tool mouse owner", TOOL_MOUSE_OWNER_KEY],
	["write ownership", WRITE_OWNERSHIP_SLOT],
];

function footerOwner(): string {
	const statusline = readStatuslineConfig();
	if (statusline.enabled) {
		return config.enableCustomFooter
			? "statusline (enableCustomFooter is shadowed; run /statusline off to use it)"
			: "statusline";
	}
	if (config.enableCustomFooter) return "custom footer";
	return "Pi native";
}

function fileState(path: string): string {
	return existsSync(path) ? path : `${path} (missing)`;
}

export function formatDiagnostics(): string {
	const terminalWidth = process.stdout.columns ?? 0;
	const terminalHeight = process.stdout.rows ?? 0;
	const compat = getCompatIssueHistory();
	const lines: string[] = [
		"# ccstyle diag",
		"",
		"## Runtime",
		`- pi-claude-code: ${extensionVersion()}`,
		`- pi-coding-agent: ${PI_VERSION}`,
		`- node: ${process.version}`,
		`- platform: ${process.platform} ${process.arch}`,
		`- terminal: ${terminalWidth || "?"}×${terminalHeight || "?"}`,
		"",
		"## Routing",
		`- style mode: ${config.mode}`,
		`- footer: ${footerOwner()}`,
		`- assistant patch chain: ${assistantPatchChain().join(" → ")}`,
		"",
		"## Config",
		`- main: ${fileState(CONFIG_PATH)}`,
		`- statusline: ${fileState(defaultStatuslinePath())} (${
			readStatuslineConfig().enabled ? "enabled" : "disabled"
		})`,
		`- streamThrottleMs: ${config.streamThrottleMs}${config.streamThrottleMs > 0 ? "" : " (off)"}`,
		`- liveToolPreview: ${config.liveToolPreview ? `${config.liveToolPreviewLines} lines` : "off"}`,
		`- diff: ${config.diffViewMode} · ${config.diffIndicatorMode} · ${config.diffPalette}`,
		`- compact thinking: preview ${config.previewLines} lines · summary ${
			config.thinkingLiveSummary ? "on" : "off"
		}`,
		"",
		"## Patches",
	];
	for (const [label, key] of PATCH_SLOTS) {
		lines.push(`- ${label}: ${patchRegistry.get(key) === undefined ? "—" : "installed"}`);
	}
	lines.push("");
	lines.push("## Compatibility");
	if (compat.length === 0) {
		lines.push("- no compat issues reported this session");
	} else {
		for (const issue of compat) lines.push(`- ${issue.feature}: missing ${issue.missing}`);
	}
	return `${lines.join("\n")}\n`;
}
