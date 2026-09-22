/**
 * 状态栏纯渲染：格式化 + 两级降级（long→short 再剔除）+ 两行组装。
 *
 * 无 Pi 组件依赖：颜色经 `paint(color, text)` 注入；列宽用 pi-tui 纯函数
 * `visibleWidth`（CJK 计 2 列），调用方（index.ts）再用 `truncateToWidth` 做最终兜底。
 * 定稿样式：无图标纯文字；ctx 进度条填充段随占比分 tone（≥70 warning / ≥90 error），
 * 告警靠整段变色 + `!!`。
 */
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { formatTokens, truncateByWidth } from "../../utils/format.ts";

export type Paint = (color: ThemeColor, text: string) => string;

/** L1/L2 组装输入（index.ts 从 ctx/footerData/git 快照拼出）。 */
export interface StatusSnapshot {
	model: string;
	thinking: string | null;
	cwd: string;
	ctxPct: number | null;
	ctxTokens: number | null;
	ctxWindow: number;
	cost: number;
	/** 已归一化的 mcp 文案（如 `mcp 3 enabled`），无则 null。 */
	mcp: string | null;
	/** 扩展总数，无（未加载完）则 null。 */
	extTotal: number | null;
	branch: string | null;
	changedFiles: number;
	hasConflicts: boolean;
	conflictFiles: number;
	ahead: number | null;
	behind: number | null;
	insertions: number;
	deletions: number;
	/** 当前分支关联 PR 号；无 gh / 无 PR / 非仓库为 null（整段省略）。 */
	pr: number | null;
	worktree: string | null;
	showWorktree: boolean;
}

export const SEPARATOR = " │ ";

/** 与 working-message 一致的紧凑 token 计数：18 / 1.4k / 12k（收口自 utils/format）。 */
export { formatTokens };

/** `$1.23` 两位小数；订阅制零成本由调用方整段隐藏。 */
export function formatCost(cost: number): string {
	return `$${cost.toFixed(2)}`;
}

/** ctx 段颜色：≥90 error，≥70 warning，否则 dim；null 按 dim。 */
export function ctxColor(pct: number | null): ThemeColor {
	if (pct !== null && pct >= 90) return "error";
	if (pct !== null && pct >= 70) return "warning";
	return "dim";
}

/** thinking 等级 → 主题 thinking* 色键；未知回 dim。 */
export function thinkingColor(level: string): ThemeColor {
	const key =
		`thinking${level.charAt(0).toUpperCase()}${level.slice(1).toLowerCase()}` as ThemeColor;
	const known: readonly string[] = [
		"thinkingOff",
		"thinkingMinimal",
		"thinkingLow",
		"thinkingMedium",
		"thinkingHigh",
		"thinkingXhigh",
		"thinkingMax",
	];
	return (known as readonly string[]).includes(key) ? key : "dim";
}

export interface FitSegment {
	/** 可见宽度估算用纯文本。 */
	plain: string;
	/** 已着色文本。 */
	painted: string;
	/** 越大越先保留（抄 narumitw 保留优先级思想）。 */
	priority: number;
	/** 第一级降级文案（long → short）：放不下先整体换短形，仍放不下才整段剔除。 */
	shortPlain?: string;
	/** 短形的着色文本；缺省沿用 painted（仅适合单色段）。 */
	shortPainted?: string;
	/** 降级顺序：数字小的先换短形（思想重写自 mcode status-line-items shrinkPriority）。 */
	shrinkPriority?: number;
}

function plainWidth(text: string): number {
	return visibleWidth(text);
}

/**
 * 两级降级装配（思想重写自 mcode status-line-items 两层降级）：
 * ① 全形放不下 → 按 shrinkPriority 逐段换成 short 文案，任一档放下即返回；
 * ② 仍放不下 → 从最低优先级起整段剔除。
 * 显示顺序保持传入顺序；全部剔光返回空串。
 */
export function fitSegments(segments: FitSegment[], width: number): string {
	if (width <= 0) return "";
	let current = segments.filter((s) => s.plain.length > 0);
	const fits = (list: FitSegment[]): boolean =>
		plainWidth(list.map((s) => s.plain).join(SEPARATOR)) <= width;
	const emit = (list: FitSegment[]): string => list.map((s) => s.painted).join(SEPARATOR);
	if (fits(current)) return emit(current);

	// ① 整段降级：短形优先级小的先换，换一档试一次（未轮到的段保留全形）。
	const shrinkables = current
		.map((segment, index) => ({ segment, index }))
		.filter(({ segment }) => segment.shortPlain !== undefined)
		.sort(
			(a, b) =>
				(a.segment.shrinkPriority ?? 999) - (b.segment.shrinkPriority ?? 999) || a.index - b.index,
		);
	for (const { segment } of shrinkables) {
		if (!fits(current)) {
			current = current
				.map((s) =>
					s === segment
						? { ...s, plain: s.shortPlain as string, painted: s.shortPainted ?? s.painted }
						: s,
				)
				.filter((s) => s.plain.length > 0);
		}
		if (fits(current)) return emit(current);
	}

	// ② 剔除阶段（以降级后的文案为准）。
	while (current.length > 0) {
		if (fits(current)) return emit(current);
		let dropIndex = 0;
		for (let i = 1; i < current.length; i++) {
			if (current[i]!.priority < current[dropIndex]!.priority) dropIndex = i;
		}
		current.splice(dropIndex, 1);
	}
	return "";
}

function fitSingle(text: string, width: number): string {
	return truncateByWidth(text, width);
}

/** ctx 进度条填充格数（8 格）；null/越界钳制。渲染分 tone 用。 */
export function ctxBarCells(pct: number | null, cells = 8): { filled: number; empty: number } {
	const ratio = pct === null ? 0 : Math.max(0, Math.min(1, pct / 100));
	const filled = Math.round(ratio * cells);
	return { filled, empty: Math.max(0, cells - filled) };
}

/** ctx 进度条（8 格 `█░`）；null 按空条。 */
export function ctxBar(pct: number | null, cells = 8): string {
	const { filled, empty } = ctxBarCells(pct, cells);
	return "█".repeat(filled) + "░".repeat(empty);
}

/**
 * ctx 段两级装配：plain 与旧版逐字一致；painted 里进度条填充段随占比走
 * ctxColor（≥70 warning / ≥90 error），空槽固定 dim——分 tone 而非整段一色。
 */
function ctxSegment(snapshot: StatusSnapshot, paint: Paint): FitSegment {
	const pct = snapshot.ctxPct;
	const tone = ctxColor(pct);
	const { filled, empty } = ctxBarCells(pct);
	const barFilled = "█".repeat(filled);
	const barEmpty = "░".repeat(empty);
	const danger = pct !== null && pct >= 90;
	const detailShort = pct === null ? "—" : `${Math.round(pct)}%`;
	const detailFull =
		pct === null
			? "—"
			: `${Math.round(pct)}% · ${snapshot.ctxTokens === null ? "?" : formatTokens(snapshot.ctxTokens)}/${snapshot.ctxWindow > 0 ? formatTokens(snapshot.ctxWindow) : "?"}`;
	const wrap = (detail: string): { plain: string; painted: string } => {
		const innerPlain = `ctx ${barFilled}${barEmpty} ${detail}`;
		const innerPainted =
			paint(tone, `ctx ${barFilled}`) + paint("dim", barEmpty) + paint(tone, ` ${detail}`);
		return danger
			? {
					plain: `!! ${innerPlain} !!`,
					painted: paint("error", "!! ") + innerPainted + paint("error", " !!"),
				}
			: { plain: innerPlain, painted: innerPainted };
	};
	const full = wrap(detailFull);
	const short = detailFull === detailShort ? undefined : wrap(detailShort);
	return {
		plain: full.plain,
		painted: full.painted,
		priority: 120,
		shortPlain: short?.plain,
		shortPainted: short?.painted,
		shrinkPriority: 30,
	};
}

/** L1 段：`model (thinking) │ ctx bar pct · used/window │ $cost │ mcp │ ext`。 */
function line1Segments(snapshot: StatusSnapshot, paint: Paint): FitSegment[] {
	const segments: FitSegment[] = [];
	const thinking = snapshot.thinking ? ` (${snapshot.thinking})` : "";
	segments.push({
		plain: `${snapshot.model}${thinking}`,
		painted:
			paint("text", snapshot.model) +
			(snapshot.thinking
				? paint("dim", " (") +
					paint(thinkingColor(snapshot.thinking), snapshot.thinking) +
					paint("dim", ")")
				: ""),
		priority: 110,
		// 短形丢 thinking 档位，保住模型名本身。
		shortPlain: snapshot.model,
		shortPainted: paint("text", snapshot.model),
		shrinkPriority: 40,
	});

	segments.push(ctxSegment(snapshot, paint));

	if (snapshot.cost > 0) {
		const costText = formatCost(snapshot.cost);
		segments.push({ plain: costText, painted: paint("text", costText), priority: 60 });
	}
	if (snapshot.mcp) {
		const mcpShort = snapshot.mcp.replace(/\s+enabled$/, "");
		segments.push({
			plain: snapshot.mcp,
			painted: paint("muted", snapshot.mcp),
			priority: 50,
			shortPlain: mcpShort !== snapshot.mcp ? mcpShort : undefined,
			shortPainted: mcpShort !== snapshot.mcp ? paint("muted", mcpShort) : undefined,
			shrinkPriority: 10,
		});
	}
	if (snapshot.extTotal !== null) {
		const extText = `ext ${snapshot.extTotal} on`;
		const extShort = `ext ${snapshot.extTotal}`;
		segments.push({
			plain: extText,
			painted: paint("muted", extText),
			priority: 40,
			shortPlain: extShort,
			shortPainted: paint("muted", extShort),
			shrinkPriority: 20,
		});
	}
	return segments;
}

/** L1：`model (thinking) │ ctx bar pct · used/window │ $cost │ mcp │ ext`。 */
export function buildLine1(snapshot: StatusSnapshot, width: number, paint: Paint): string {
	return fitSegments(line1Segments(snapshot, paint), width);
}

/** L2 段：`cwd │ branch … │ wt name`。 */
function line2Segments(snapshot: StatusSnapshot, paint: Paint): FitSegment[] {
	const segments: FitSegment[] = [];
	segments.push({
		plain: snapshot.cwd,
		painted: paint("dim", snapshot.cwd),
		priority: 80,
		...(shortenCwdTail(snapshot.cwd) !== undefined
			? {
					shortPlain: shortenCwdTail(snapshot.cwd),
					shortPainted: paint("dim", shortenCwdTail(snapshot.cwd) as string),
				}
			: {}),
		shrinkPriority: 50,
	});

	if (snapshot.branch) {
		const dirty = snapshot.changedFiles > 0 || snapshot.hasConflicts;
		const sync =
			snapshot.ahead !== null && snapshot.behind !== null
				? snapshot.ahead === 0 && snapshot.behind === 0
					? " ok"
					: `${snapshot.ahead > 0 ? ` ↑${snapshot.ahead}` : ""}${snapshot.behind > 0 ? ` ↓${snapshot.behind}` : ""}`
				: "";
		const diff =
			snapshot.insertions > 0 || snapshot.deletions > 0
				? ` +${snapshot.insertions} -${snapshot.deletions}`
				: "";
		const conflicts = snapshot.conflictFiles > 0 ? ` ⚠${snapshot.conflictFiles}` : "";
		const plain = `${snapshot.branch}${sync}${conflicts}${diff}`;
		const branchColor: ThemeColor = dirty ? "warning" : "success";
		const basePainted =
			paint(branchColor, snapshot.branch) +
			paint(dirty ? "warning" : "dim", sync) +
			(snapshot.conflictFiles > 0 ? paint("warning", conflicts) : "");
		const diffPainted =
			snapshot.insertions > 0 || snapshot.deletions > 0
				? ` ${paint("success", `+${snapshot.insertions}`)} ${paint("error", `-${snapshot.deletions}`)}`
				: "";
		segments.push({
			plain,
			painted: basePainted + diffPainted,
			priority: 100,
			// 短形先丢 diffstat（冲突 ⚠ 保留——安全信息不让位）。
			shortPlain: `${snapshot.branch}${sync}${conflicts}`,
			shortPainted: basePainted,
			shrinkPriority: 60,
		});
	}

	if (snapshot.pr !== null) {
		const prText = `PR #${snapshot.pr}`;
		const prShort = `#${snapshot.pr}`;
		segments.push({
			plain: prText,
			painted: paint("dim", prText),
			priority: 65,
			shortPlain: prShort,
			shortPainted: paint("dim", prShort),
			shrinkPriority: 15,
		});
	}

	if (snapshot.showWorktree && snapshot.worktree) {
		const wtText = `wt ${snapshot.worktree}`;
		segments.push({
			plain: wtText,
			painted: paint("dim", wtText),
			priority: 30,
			shortPlain: snapshot.worktree,
			shortPainted: paint("dim", snapshot.worktree),
			shrinkPriority: 45,
		});
	}
	return segments;
}

/** cwd 短形：≥3 段时保留末两段（`…/fork/repo`）；≤2 段无短形。 */
function shortenCwdTail(cwd: string): string | undefined {
	const parts = cwd.split(/[\\/]+/).filter(Boolean);
	if (parts.length <= 2) return undefined;
	return `…/${parts.slice(-2).join("/")}`;
}

/** L2：`cwd │ branch [ok] [↑a] [↓b] [⚠n] [+i -d] [wt name]`；非仓库时只有 cwd。 */
export function buildLine2(snapshot: StatusSnapshot, width: number, paint: Paint): string {
	const line = fitSegments(line2Segments(snapshot, paint), width);
	return line || fitSingle(snapshot.cwd, width);
}

/** 窄屏塌单行的阈值列宽；低于此只拼一行（优先级合并，各段按原优先级取舍）。 */
export const SINGLE_LINE_MAX_WIDTH = 60;

/** 两行组装；窄屏塌单行；空行由调用方过滤（至少保留一行避免 footer 空闪）。 */
export function buildLines(snapshot: StatusSnapshot, width: number, paint: Paint): string[] {
	const safeWidth = Math.max(10, Math.floor(width) || 80);
	if (safeWidth < SINGLE_LINE_MAX_WIDTH) {
		const single = fitSegments(
			[...line1Segments(snapshot, paint), ...line2Segments(snapshot, paint)],
			safeWidth,
		);
		return [single || fitSingle(snapshot.cwd, safeWidth)];
	}
	return [buildLine1(snapshot, safeWidth, paint), buildLine2(snapshot, safeWidth, paint)];
}
