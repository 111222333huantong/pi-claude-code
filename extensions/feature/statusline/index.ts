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
import { collectUsage, EMPTY_USAGE_TOTALS, type UsageCache, type UsageTotals } from "./usage.ts";

/** ctx.getContextUsage() 的返回形状（可能 undefined）。 */
type ContextUsage = ReturnType<ExtensionContext["getContextUsage"]>;

/** 上下文统计兜底刷新间隔：leaf/模型不变时最多沿用 5s。 */
const CONTEXT_USAGE_TTL_MS = 5_000;

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
				renderConfig = null;
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

	// 运行中回合的计时：turn_start 起算，turn_end / agent_end 停；footer 每秒重绘一次。
	let rerenderCurrent: (() => void) | null = null;
	let turnStartedAt: number | null = null;
	let turnTicker: ReturnType<typeof setInterval> | null = null;
	// 用量累计只在会话叶子变化时重算：run timer 每秒重绘，不能再每秒扫全分支。
	let usageCache: UsageCache | null = null;
	// ctx.getContextUsage() 会重建 session projection 并扫全消息；按叶子 + 模型缓存，
	// 另加 5s TTL：工具集/系统提示变化不一定产生新 leaf，兜底刷新一次。
	let contextUsageCache: { key: string; at: number; value: ContextUsage } | null = null;
	// 状态栏配置只在启动/命令写入时读一次，渲染路径不碰文件。
	let renderConfig: ReturnType<typeof readStatuslineConfig> | null = null;

	const stopTurnTicker = () => {
		if (turnTicker) clearInterval(turnTicker);
		turnTicker = null;
	};
	const startTurnTicker = () => {
		if (!rerenderCurrent || turnTicker) return;
		turnTicker = setInterval(() => {
			try {
				rerenderCurrent?.();
			} catch {
				// ignore
			}
		}, 1_000);
		turnTicker.unref?.();
	};
	const finishTurn = () => {
		turnStartedAt = null;
		stopTurnTicker();
		try {
			rerenderCurrent?.();
		} catch {
			// ignore
		}
	};

	pi.on("turn_start", async (_event, ctx) => {
		if (ctx?.mode !== "tui" || !ctx?.hasUI) return;
		turnStartedAt = Date.now();
		startTurnTicker();
		try {
			rerenderCurrent?.();
		} catch {
			// ignore
		}
	});
	pi.on("turn_end", async (_event, ctx) => {
		if (ctx?.mode !== "tui" || !ctx?.hasUI) return;
		finishTurn();
	});
	pi.on("agent_end", async (_event, ctx) => {
		if (ctx?.mode !== "tui" || !ctx?.hasUI) return;
		finishTurn();
	});

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
		// 配置在这里读一次，渲染路径只读内存（外部改文件需 /reload 或新会话）。
		renderConfig = readStatuslineConfig();
		if (!renderConfig.enabled) return;

		// 换会话时清掉上一会话可能残留的回合计时与用量缓存。
		turnStartedAt = null;
		stopTurnTicker();
		usageCache = null;
		contextUsageCache = null;

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
		rerenderCurrent = rerender;

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
					rerenderCurrent = null;
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

					let usage: UsageTotals = { ...EMPTY_USAGE_TOTALS };
					let leafId: string | null = null;
					try {
						const result = collectUsage(ctx.sessionManager, usageCache);
						usage = result.totals;
						usageCache = result.cache;
						leafId = result.cache?.leafId ?? null;
					} catch {
						usageCache = null;
					}
					// 叶子 + 模型都没变时复用；避免 run 计时每秒重建 projection。
					let ctxUsage: ContextUsage;
					try {
						const model = ctx.model;
						const key = `${leafId ?? ""}\0${model?.id ?? ""}\0${model?.name ?? ""}\0${model?.contextWindow ?? 0}`;
						const now = Date.now();
						if (
							contextUsageCache?.key === key &&
							now - contextUsageCache.at < CONTEXT_USAGE_TTL_MS
						) {
							ctxUsage = contextUsageCache.value;
						} else {
							ctxUsage = ctx.getContextUsage();
							contextUsageCache = { key, at: now, value: ctxUsage };
						}
					} catch {
						contextUsageCache = null;
						ctxUsage = undefined;
					}

					let mcpText: string | null = null;
					try {
						mcpText = normalizeMcpStatus(footerData.getExtensionStatuses().get("mcp"));
					} catch {
						mcpText = null;
					}
					if (!mcpText && mcpCount > 0) mcpText = `mcp ${mcpCount} enabled`;
					if (!renderConfig) renderConfig = readStatuslineConfig();
					const statusConfig = renderConfig;

					const snapshot: StatusSnapshot = {
						model: modelLabel(ctx.model),
						thinking,
						cwd: shortCwd(ctx.cwd),
						ctxPct: ctxUsage?.percent ?? null,
						ctxTokens: ctxUsage?.tokens ?? null,
						ctxWindow: ctxUsage?.contextWindow ?? 0,
						cost: usage.cost,
						turnElapsedMs: turnStartedAt === null ? null : Date.now() - turnStartedAt,
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
						showWorktree: statusConfig.showWorktree,
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
		rerenderCurrent = null;
		usageCache = null;
		contextUsageCache = null;
		renderConfig = null;
		finishTurn();
	});
}
