import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { config } from "./config/config.ts";
import agentSummary from "./feature/agent-summary/index.ts";
import clipboardPaste from "./feature/clipboard-paste.ts";
import { installCompactThinking } from "./feature/compact-thinking.ts";
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
import { registerLoadedCommand } from "./feature/shell/loaded-stats.ts";
import piStartupHeader from "./feature/shell/startup-header.ts";
import workingMessage from "./feature/shell/working-message.ts";
import workingRow from "./feature/shell/working-row.ts";
import registerStatusline from "./feature/statusline/index.ts";

// renderer
import claudeCodeStyle, { getCompactThinkingConfig } from "./renderer/index.ts";
import markdownEnhance from "./renderer/markdown-enhance.ts";
import { registerPromptGlyph } from "./renderer/user-message.ts";

export default function (pi: ExtensionAPI): void {
	// shell chrome
	if (config.enableAliases) piAliases(pi);
	installFlushDockedBash();
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
	// Esc 双件套：链式包裹 handleInput，注册在 working-row 之后、
	// promptGlyph（纯 render）之前；两者按草稿空/非空互斥，顺序无关。
	if (config.enableEscSteer) registerEscSteer(pi);
	if (config.enableDoubleEscClear) registerDoubleEscClear(pi);
	// 输入框 ❯ 包最外层：working-row 等链式包裹先注册，本 handler 后执行。
	registerPromptGlyph(pi);

	// render stack：thinking controller 直接交给 style 作 query
	markdownEnhance(pi);
	claudeCodeStyle(pi, undefined, installCompactThinking(pi, getCompactThinkingConfig()));

	// features
	if (config.enableContextCommand) context(pi);
	if (config.enableSessionReference) sessionReference(pi);
	if (config.enableSubagentAutocomplete) agentAutocomplete(pi);
	// agent_id → 标题映射（工具卡不再显示裸 UUID；无开关，常驻但仅内存 Map）。
	registerAgentTitles(pi);
	if (config.enableAgentSummary) agentSummary(pi);
}
