import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeAnsiForThemedOutput } from "./ansi-utils.ts";
import type { RenderedRow } from "./diff-layout.ts";
import { clampDiffLineToWidth } from "./diff-limits.ts";
import { type DiffTheme, emphasis, stabilizeBackgroundResets } from "./diff-palette.ts";
import type { DiffMetaEntry, DiffStats } from "./diff-parse.ts";
import type { DiffPresentationMode } from "./diff-presentation.ts";
import { normalizeCodeWhitespace, wrapToWidth } from "./diff-text.ts";

export function formatMetaEntryRows(
	entry: DiffMetaEntry,
	width: number,
	theme: DiffTheme,
	wordWrap: boolean,
): RenderedRow[] {
	const normalized = sanitizeAnsiForThemedOutput(normalizeCodeWhitespace(entry.raw));
	const lines = wordWrap
		? wrapToWidth(normalized, width, true)
		: [truncateToWidth(normalized, width)];

	const mapColor = (line: string): string => {
		if (entry.kind === "hunk") {
			return stabilizeBackgroundResets(theme.fg("accent", line));
		}
		if (entry.kind === "file") {
			return stabilizeBackgroundResets(theme.fg("muted", line));
		}
		return stabilizeBackgroundResets(theme.fg("toolDiffContext", line));
	};

	return lines.map((line) => ({
		text: mapColor(line),
		hunkIndex: entry.kind === "file" ? null : entry.hunkIndex || null,
	}));
}

function renderDiffStatBar(stats: DiffStats, width: number, theme: DiffTheme): string | null {
	const totalChanges = stats.added + stats.removed;
	if (totalChanges === 0 || width < 20) {
		return null;
	}

	const barSlots = Math.max(8, Math.min(24, Math.floor(width / 12)));
	let addedSlots = Math.max(
		0,
		Math.min(barSlots, Math.round((stats.added / totalChanges) * barSlots)),
	);
	if (stats.added > 0 && addedSlots === 0) {
		addedSlots = 1;
	}
	if (stats.removed > 0 && addedSlots >= barSlots) {
		addedSlots = barSlots - 1;
	}
	const removedSlots = Math.max(0, barSlots - addedSlots);

	const addedBar = addedSlots > 0 ? theme.fg("success", "━".repeat(addedSlots)) : "";
	const removedBar = removedSlots > 0 ? theme.fg("error", "━".repeat(removedSlots)) : "";
	return stabilizeBackgroundResets(
		`${theme.fg("dim", "[")}${addedBar}${removedBar}${theme.fg("dim", "]")}`,
	);
}

/**
 * 小 diff 只留 `↳ +2 -1`：标题上方已经知道是哪个文件、做了什么，
 * 再挂 `diff · unified [━━━━]` 只会把真正要看的内容往下挤。
 */
const METER_MIN_CHANGES = 10;

function buildDiffSummaryLine(stats: DiffStats, theme: DiffTheme): string {
	return [
		theme.fg("toolOutput", "↳"),
		theme.fg("success", `+${stats.added}`),
		theme.fg("error", `-${stats.removed}`),
	].join(" ");
}

export function renderHeaderRows(
	stats: DiffStats,
	mode: Exclude<DiffPresentationMode, "summary">,
	width: number,
	theme: DiffTheme,
): RenderedRow[] {
	const summary = buildDiffSummaryLine(stats, theme);
	// compact 正文本来就只有一行；再塞 meter 会把代码挤没。
	if (mode === "compact" || stats.added + stats.removed < METER_MIN_CHANGES) {
		return [{ text: stabilizeBackgroundResets(truncateToWidth(summary, width)), hunkIndex: null }];
	}

	const meter = renderDiffStatBar(stats, width, theme);
	if (!meter) {
		return [{ text: stabilizeBackgroundResets(truncateToWidth(summary, width)), hunkIndex: null }];
	}

	// 右侧 `unified [━━━━━━━━]`：模式与比例只在大 diff 时出现，靠右放，扫读时不会打断 `+A -D`。
	const right = `${theme.fg("muted", mode)} ${meter}`;
	const gap = width - visibleWidth(summary) - visibleWidth(right);
	if (gap < 1) {
		return [
			{
				text: stabilizeBackgroundResets(truncateToWidth(`${summary} ${right}`, width)),
				hunkIndex: null,
			},
		];
	}

	return [
		{
			text: stabilizeBackgroundResets(`${summary}${" ".repeat(gap)}${right}`),
			hunkIndex: null,
		},
	];
}

export function renderDiffFrameLine(width: number, theme: DiffTheme): string {
	const frameWidth = Math.max(0, width);
	if (frameWidth === 0) {
		return "";
	}
	return stabilizeBackgroundResets(theme.fg("dim", "─".repeat(frameWidth)));
}

export function renderSingleDiffRow(
	text: string,
	color: string,
	width: number,
	theme: DiffTheme,
): string[] {
	if (width <= 0) {
		return [""];
	}
	return [clampDiffLineToWidth(stabilizeBackgroundResets(theme.fg(color, text)), width)];
}

export function renderWriteHeader(
	wasOverwrite: boolean,
	width: number,
	theme: DiffTheme,
	headerLabel?: string,
): string {
	const actionLabel = headerLabel?.trim() || (wasOverwrite ? "overwritten" : "created");
	return stabilizeBackgroundResets(
		truncateToWidth(theme.fg("toolOutput", `↳ ${emphasis(theme, actionLabel)}`), width),
	);
}
