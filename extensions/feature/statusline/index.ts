/**
 * 状态栏 footer：两行纯文字（无图标无进度条），跟随 Pi 主题。
 *
 * L1: `model (thinking) │ ctx pct · used/window │ $cost │ mcp │ ext`
 * L2: `cwd │ branch [ok] [↑a] [↓b] [⚠n] [+i -d] [PR #n] [wt name]`
 *
 * 数据：model/ctx/用量走 ctx（render 时活读）；git 走后台快照轮询；
 * 扩展/mcp 计数复用 loaded-stats 进程级单例（无额外扫描）。
 * 开关：独立 `~/.pi/agent/statusline.json` + `/statusline` 命令。
 */
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { stripAnsi } from "../../utils/ansi-text.ts";
import { shortenCwd } from "../../utils/format.ts";
import { collectLoadedStats, resolveAgentDir } from "../shell/loaded-stats.ts";
import { readStatuslineConfig, writeStatuslineConfig } from "./config.ts";
import {
	collectGitStatus,
	EMPTY_GIT_SNAPSHOT,
	type GitPoller,
	type GitSnapshot,
	startGitPoller,
} from "./git.ts";
import { getPrNumber } from "./pr.ts";
import { buildLines, type StatusSnapshot } from "./render.ts";
import { summarizeUsage } from "./usage.ts";

function shortCwd(cwd: string): string {
	return shortenCwd(cwd, homedir());
}

function modelLabel(model: ExtensionContext["model"]): string {
	const raw = model?.name ?? model?.id ?? "no-model";
	return raw.replace(/^[^/\s]+\//, "");
}

/**
 * adapter 的 extension status（`🔌 MCP: 3 servers` / `♆ MCP: 3 enabled`，
 * 自带主题 ANSI + 图标）→ `mcp 3 enabled`；解析不出回 null 走计数回退。
 */
export function normalizeMcpStatus(raw: string | undefined): string | null {
	if (!raw) return null;
	// 先剥 ANSI：CSI 里 `38;2;R;G;Bm` 的数字会被误判为 word 字符，
	// 直接正则会漏出 `38;2;177;185;249m` 这种残留。
	const plain = stripAnsi(raw);
	const count = plain.match(/(\d+)/)?.[1];
	if (count) return `mcp ${count} enabled`;
	const details = plain
		.replace(/^[^\w]*:?/u, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!details || /^mcp:?\s*$/i.test(details)) return "mcp";
	return `mcp ${details}`;
}

function hasMcpAdapter(pi: ExtensionAPI): boolean {
	try {
		return pi.getCommands().some((c) => c.name === "mcp");
	} catch {
		return false;
	}
}

export default function registerStatusline(pi: ExtensionAPI): void {
	pi.registerCommand("statusline", {
		description: "Toggle the custom statusline footer (on|off|status)",
		getArgumentCompletions: (prefix) =>
			["on", "off", "status"]
				.filter((v) => v.startsWith(prefix))
				.map((value) => ({
					value,
					label: value,
					description: `Statusline ${value}`,
				})),
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on" || arg === "off") {
				writeStatuslineConfig({ enabled: arg === "on" });
				ctx.ui.notify?.(
					`Statusline ${arg === "on" ? "enabled" : "disabled"} (takes effect next session, /reload)`,
					"info",
				);
				return;
			}
			const current = readStatuslineConfig();
			ctx.ui.notify?.(
				`Statusline: ${current.enabled ? "on" : "off"} · worktree ${current.showWorktree ? "on" : "off"}`,
				"info",
			);
		},
	});

	let stopPoller: GitPoller | null = null;
	let unsubscribeBranch: (() => void) | null = null;
	// 当前会话的 poller（工具结束事件驱动刷新用；session 切换时更新）。
	let activePoller: GitPoller | null = null;

	// 工具落定即刷 git 段（忙则丢弃，下拍补上；空闲 3s 拍不受影响）。
	pi.on("tool_execution_end", async () => {
		try {
			activePoller?.refreshIfIdle();
		} catch {
			// ignore
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		if (ctx?.mode !== "tui" || !ctx?.hasUI) return;
		if (!readStatuslineConfig().enabled) return;

		let git: GitSnapshot = { ...EMPTY_GIT_SNAPSHOT };
		let extTotal: number | null = null;
		let mcpCount = 0;
		let requestRender: (() => void) | null = null;
		const rerender = () => {
			try {
				requestRender?.();
			} catch {
				// ignore
			}
		};

		// git 快照：立即采一次 + 后台轮询。
		try {
			git = await collectGitStatus(ctx.cwd);
		} catch {
			// keep empty snapshot
		}
		stopPoller?.();
		stopPoller = startGitPoller(
			ctx.cwd,
			(snapshot) => {
				git = snapshot;
				rerender();
			},
			undefined,
			// 嵌入式会话 dispose 不发 session_shutdown：读一次 ctx 探活，
			// 失效即停表，避免拿旧 cwd 每 3s 起 git 进程（cc-my-pi #4）。
			() => {
				void ctx.mode;
				return true;
			},
		);
		activePoller = stopPoller;

		// 扩展/mcp 计数：复用 loaded-stats 单例，无额外扫描。
		collectLoadedStats(ctx.cwd, resolveAgentDir(), hasMcpAdapter(pi)).then(
			(stats) => {
				extTotal = stats.extensions.user + stats.extensions.project;
				mcpCount = stats.mcpServers;
				rerender();
			},
			() => {
				// counting failed → segments stay hidden
			},
		);

		ctx.ui.setFooter((tui, theme: Theme, footerData) => {
			requestRender = () => tui.requestRender();
			unsubscribeBranch?.();
			try {
				unsubscribeBranch = footerData.onBranchChange(() => rerender());
			} catch {
				unsubscribeBranch = null;
			}
			return {
				invalidate() {},
				dispose() {
					unsubscribeBranch?.();
					unsubscribeBranch = null;
					requestRender = null;
				},
				render(width: number) {
					const paint = (color: Parameters<Theme["fg"]>[0], text: string) => {
						try {
							return theme.fg(color, text);
						} catch {
							return text;
						}
					};
					let thinking: string | null = null;
					try {
						thinking = ctx.thinkingLevel ?? pi.getThinkingLevel() ?? null;
					} catch {
						thinking = ctx.thinkingLevel ?? null;
					}
					if (thinking === "off") thinking = null;

					let usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
					try {
						usage = summarizeUsage(ctx.sessionManager.getBranch());
					} catch {
						// keep zeros
					}
					const ctxUsage = (() => {
						try {
							return ctx.getContextUsage();
						} catch {
							return undefined;
						}
					})();

					let mcpText: string | null = null;
					try {
						mcpText = normalizeMcpStatus(footerData.getExtensionStatuses().get("mcp"));
					} catch {
						mcpText = null;
					}
					if (!mcpText && mcpCount > 0) mcpText = `mcp ${mcpCount} enabled`;

					const snapshot: StatusSnapshot = {
						model: modelLabel(ctx.model),
						thinking,
						cwd: shortCwd(ctx.cwd),
						ctxPct: ctxUsage?.percent ?? null,
						ctxTokens: ctxUsage?.tokens ?? null,
						ctxWindow: ctxUsage?.contextWindow ?? 0,
						cost: usage.cost,
						mcp: mcpText,
						extTotal,
						branch: git.branch,
						changedFiles: git.changedFiles,
						hasConflicts: git.hasConflicts,
						conflictFiles: git.conflictFiles,
						ahead: git.ahead,
						behind: git.behind,
						insertions: git.insertions,
						deletions: git.deletions,
						pr: getPrNumber(ctx.cwd, git.branch !== null, undefined, Date.now(), git.branch),
						worktree: git.worktree,
						showWorktree: readStatuslineConfig().showWorktree,
					};
					const safeWidth = Math.max(20, Math.floor(width) || 80);
					return buildLines(snapshot, safeWidth, paint)
						.map((line) => truncateToWidth(line, safeWidth))
						.filter((line) => line.length > 0);
				},
			};
		});
	});

	pi.on("session_shutdown", async () => {
		stopPoller?.();
		stopPoller = null;
		activePoller = null;
		unsubscribeBranch?.();
		unsubscribeBranch = null;
	});
}
