import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { config } from "./config/config.ts";
import agentSummary from "./feature/agent-summary/index.ts";
import clipboardPaste from "./feature/clipboard-paste.ts";
import { installCompactThinking } from "./feature/compact-thinking.ts";
import compactionProgress from "./feature/compaction-progress.ts";
import context from "./feature/context.ts";
import registerDoubleEscClear from "./feature/double-esc-clear.ts";
import registerEscSteer from "./feature/esc-steer.ts";
import imagePaster from "./feature/image-paster.ts";
import { registerAgentTitles } from "./feature/reference/agent-titles.ts";
import sessionReference from "./feature/reference/index.ts";
// feature
import agentAutocomplete from "./feature/reference/subagent.ts";
// shell
import piAliases from "./feature/shell/aliases.ts";
import { installFlushDockedBash } from "./feature/shell/flush-docked-bash.ts";
import customFooter from "./feature/shell/footer.ts";
import { registerLoadedCommand } from "./feature/shell/loaded-stats.ts";
import { applyPromptEditor } from "./feature/shell/prompt-editor.ts";
import piStartupHeader, { installEarlyStartupHeader } from "./feature/shell/startup-header.ts";
import workingMessage from "./feature/shell/working-message.ts";
import workingRow from "./feature/shell/working-row.ts";
import { readStatuslineConfig } from "./feature/statusline/config.ts";
import registerStatusline from "./feature/statusline/index.ts";

// renderer
import claudeCodeStyle, { getCompactThinkingConfig } from "./renderer/index.ts";
import { MARKDOWN_ENHANCE_MESSAGE_TYPES, transformMarkdown } from "./renderer/markdown-enhance.ts";
import tableCopy from "./renderer/table-copy.ts";

/** One registration per extension: table provenance must not replace enhancement. */
export function configureMarkdownRendering(
	pi: ExtensionAPI,
	{
		enableMarkdownEnhance,
		enableTableCopy,
	}: { enableMarkdownEnhance: boolean; enableTableCopy: boolean },
): void {
	const copy = enableTableCopy ? tableCopy(pi) : undefined;
	if (!enableMarkdownEnhance && !copy) return;
	pi.registerMarkdownTransformer(
		(markdown, context) => {
			copy?.noteSource(context);
			return enableMarkdownEnhance ? transformMarkdown(markdown, context) : markdown;
		},
		// @ts-expect-error pi ≥1.5.x 支持第二参 messageTypes；类型声明未跟进。
		{ messageTypes: enableMarkdownEnhance ? MARKDOWN_ENHANCE_MESSAGE_TYPES : ["assistant"] },
	);
}

export default function (pi: ExtensionAPI): void {
	// shell chrome
	if (config.enableAliases) piAliases(pi);
	installFlushDockedBash();
	installEarlyStartupHeader();
	piStartupHeader(pi);
	// /loaded 常驻（与 header 开关无关，resume 进来的旧会话也要能查）。
	registerLoadedCommand(pi);
	// 图片粘贴先于 working-row 注册：paster 在 session_start 整体替换 editor
	// 工厂，working-row 是链式包裹，后注册才能包在外层（见 working-row.ts）。
	imagePaster(pi);
	// Windows Ctrl+V 双通道：无 editor 工厂操作，注册顺序无关。
	clipboardPaste(pi);
	registerStatusline(pi);
	if (config.enableWorkingMessage) {
		workingMessage(pi);
		// 0.85+ 把 spinner 塞进 editor 边框；关掉内嵌回到 0.84 独立行。
		workingRow(pi);
	}
	// Esc 双件套：链式包裹 handleInput，注册在 working-row 之后；
	// 两者按草稿空/非空互斥，顺序无关。
	if (config.enableEscSteer) registerEscSteer(pi);
	if (config.enableDoubleEscClear) registerDoubleEscClear(pi);
	// compaction 进度条 + 结果规模回填（working-row 之后，Loader patch 链外层）。
	if (config.enableCompactionProgress) compactionProgress(pi);
	// 上游 footer 与本 fork 状态栏互斥：状态栏开则用状态栏（默认），
	// 关了才回退到上游 footer（再关则 Pi 原生 footer）。
	if (!readStatuslineConfig().enabled && config.enableCustomFooter) customFooter(pi);

	// 输入框 ❯ 提示符：session_start 时按配置应用；setEditorComponent 是一次性替换。
	pi.on("session_start", (_event, ctx) => {
		applyPromptEditor(ctx);
	});

	// render stack：thinking controller 直接交给 style 作 query
	// 两个功能独立开关，但共享同一个 transformer 注册槽位。
	configureMarkdownRendering(pi, config);
	claudeCodeStyle(pi, undefined, installCompactThinking(pi, getCompactThinkingConfig()));

	// features
	if (config.enableContextCommand) context(pi);
	if (config.enableSessionReference) sessionReference(pi);
	if (config.enableSubagentAutocomplete) agentAutocomplete(pi);
	// agent_id → 标题映射（工具卡不再显示裸 UUID；无开关，常驻但仅内存 Map）。
	registerAgentTitles(pi);
	if (config.enableAgentSummary) agentSummary(pi);
}
