import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ToolDisplayConfig } from "../../../config/config.ts";
import { pluralize } from "./diff-text.ts";

export interface DiffSummaryStats {
	added: number;
	removed: number;
	hunks: number;
	files: number;
}

export type DiffPresentationMode = "split" | "unified" | "compact" | "summary";

const MIN_COMPACT_DIFF_WIDTH = 8;
const MIN_UNIFIED_DIFF_WIDTH = 18;

export function normalizeDiffRenderWidth(width: number): number {
	if (!Number.isFinite(width)) {
		return 0;
	}
	return Math.max(0, Math.floor(width));
}

export function resolveDiffPresentationMode(
	config: Pick<ToolDisplayConfig, "diffViewMode" | "diffSplitMinWidth">,
	width: number,
	canRenderSplitLayout: boolean,
): DiffPresentationMode {
	const safeWidth = normalizeDiffRenderWidth(width);
	if (safeWidth < MIN_COMPACT_DIFF_WIDTH) {
		return "summary";
	}
	if (safeWidth < MIN_UNIFIED_DIFF_WIDTH) {
		return "compact";
	}

	if (config.diffViewMode === "split") {
		return canRenderSplitLayout ? "split" : "unified";
	}
	if (config.diffViewMode === "unified") {
		return "unified";
	}
	// "auto" 及未知模式：够宽且可分栏走 split，否则 unified。
	return safeWidth >= config.diffSplitMinWidth && canRenderSplitLayout ? "split" : "unified";
}

export function buildDiffSummaryText(stats: DiffSummaryStats, width: number): string {
	const safeWidth = normalizeDiffRenderWidth(width);
	if (safeWidth === 0) {
		return "";
	}

	const summaryCandidates = [
		`↳ diff +${stats.added} -${stats.removed} • ${stats.hunks} ${pluralize(stats.hunks, "hunk")} • ${stats.files} ${pluralize(stats.files, "file")}`,
		`↳ diff +${stats.added} -${stats.removed} • ${stats.hunks}h • ${stats.files}f`,
		`↳ diff +${stats.added} -${stats.removed}`,
		`+${stats.added} -${stats.removed}`,
		"diff",
		"…",
	];

	for (const candidate of summaryCandidates) {
		if (visibleWidth(candidate) <= safeWidth) {
			return candidate;
		}
	}

	return truncateToWidth(summaryCandidates[summaryCandidates.length - 1] ?? "", safeWidth, "");
}
