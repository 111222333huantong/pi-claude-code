import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { config } from "./config/config.ts";

// shell
import piAliases from "./feature/shell/aliases.ts";
import { installFlushDockedBash } from "./feature/shell/flush-docked-bash.ts";
import piStartupHeader from "./feature/shell/startup-header.ts";
import { registerLoadedCommand } from "./feature/shell/loaded-stats.ts";
import workingMessage from "./feature/shell/working-message.ts";
import workingRow from "./feature/shell/working-row.ts";

// feature
import agentAutocomplete from "./feature/reference/subagent.ts";
import agentSummary from "./feature/agent-summary/index.ts";
import context from "./feature/context.ts";
import sessionReference from "./feature/reference/index.ts";
import { installCompactThinking } from "./feature/compact-thinking.ts";

// renderer
import claudeCodeStyle, { getCompactThinkingConfig } from "./renderer/index.ts";
import markdownEnhance from "./renderer/markdown-enhance.ts";

export default function (pi: ExtensionAPI): void {
	// shell chrome
	if (config.enableAliases) piAliases(pi);
	installFlushDockedBash();
	piStartupHeader(pi);
	// /loaded 常驻（与 header 开关无关，resume 进来的旧会话也要能查）。
	registerLoadedCommand(pi);
	if (config.enableWorkingMessage) {
		workingMessage(pi);
		// 0.85+ 把 spinner 塞进 editor 边框；关掉内嵌回到 0.84 独立行。
		workingRow(pi);
	}

	// render stack：thinking controller 直接交给 style 作 query
	markdownEnhance(pi);
	claudeCodeStyle(pi, undefined, installCompactThinking(pi, getCompactThinkingConfig()));

	// features
	if (config.enableContextCommand) context(pi);
	if (config.enableSessionReference) sessionReference(pi);
	if (config.enableSubagentAutocomplete) agentAutocomplete(pi);
	if (config.enableAgentSummary) agentSummary(pi);
}
