/**
 * 流式 pending diff 预览：edit/write 执行中（args 已完整、结果 partial）
 * 即显示内存投影的 diff，不等落盘。
 *
 * 做法（对标 pi-tool-display pending preview）：
 * - 仅当 `argsComplete && isPartial` 进入；参数缺块/文件超限/投影失败
 *   一律回 reason，由调用方降级为原 Pending 行。
 * - edit：`edits[].oldText` 逐条在**原始文件**中恰好命中一次且互不重叠
 *   （与原生 edit 语义一致），由后向前应用得到 newContent。
 * - write：`args.content` 即 newContent；文件不存在视为新建预览。
 * - 渲染复用 `renderWriteDiffResult(previousContent/newContent)`，
 *   与最终态同一套 LCS/预算/布局。
 * - 文件读经 `statSync` 限 1MB + UTF-8 解码 + mtime 内容缓存；
 *   组件按 `args 指纹 + expanded` 缓存在 `context.state`，流式同参复用。
 */
import { existsSync, readFileSync, realpathSync, type Stats, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { DisplayConfigInput } from "./diff-renderer.ts";
import { renderWriteDiffResult } from "./diff-write-render.ts";

/** 预览可读的源文件上限（与 write-execution 512KB  comparable 档位区分，预览放宽到 1MB）。 */
export const MAX_PENDING_PREVIEW_BYTES = 1_000_000;

/** 文件内容缓存条目上限（按 path + mtime 键控）。 */
const MAX_PREVIEW_FILE_CACHE = 20;

type FileCacheEntry = { mtimeMs: number; size: number; content: string };
const fileCache = new Map<string, FileCacheEntry>();

function readPreviewFile(absolutePath: string): { content: string } | { reason: string } {
	let stat: Stats;
	try {
		stat = statSync(absolutePath);
	} catch (error: any) {
		return { reason: error?.code === "ENOENT" ? "file not found" : "unable to stat file" };
	}
	if (!stat.isFile()) return { reason: "not a regular file" };
	if (stat.size > MAX_PENDING_PREVIEW_BYTES) {
		return { reason: `file exceeds ${MAX_PENDING_PREVIEW_BYTES} bytes` };
	}
	const cached = fileCache.get(absolutePath);
	if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
		return { content: cached.content };
	}
	let content: string;
	try {
		content = readFileSync(absolutePath, "utf8");
	} catch {
		return { reason: "unable to read file as UTF-8 text" };
	}
	// BOM 去除：否则首行 diff 会带上不可见字符（上游 pi-tool-display 同处理）。
	if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
	fileCache.set(absolutePath, { mtimeMs: stat.mtimeMs, size: stat.size, content });
	while (fileCache.size > MAX_PREVIEW_FILE_CACHE) {
		const oldest = fileCache.keys().next().value;
		if (oldest === undefined) break;
		fileCache.delete(oldest);
	}
	return { content };
}

/** 测试/低频路径清理文件缓存。 */
export function clearPendingPreviewFileCache(): void {
	fileCache.clear();
}

/** `~` 家目录展开（上游 pi-tool-display 同处理）。 */
function expandHome(rawPath: string): string {
	if (rawPath === "~") return homedir();
	if (rawPath.startsWith("~/") || rawPath.startsWith("~\\")) {
		return resolve(homedir(), rawPath.slice(2));
	}
	return rawPath;
}

function resolvePreviewPath(
	rawPath: unknown,
	cwd: string,
): { absolute: string } | { reason: string } {
	if (typeof rawPath !== "string" || !rawPath) return { reason: "missing path" };
	const expanded = expandHome(rawPath);
	const absolute = isAbsolute(expanded) ? expanded : resolve(cwd || process.cwd(), expanded);
	// 符号链接逃逸检查：解析后必须落在工作区内（不存在的文件查父目录，
	// 覆盖写新建场景；解析失败不拦截，后续按缺文件降级）。
	try {
		const root = realpathSync(cwd || process.cwd());
		let probe = absolute;
		try {
			probe = realpathSync(absolute);
		} catch {
			probe = realpathSync(dirname(absolute));
		}
		const rel = relative(root, probe);
		if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
			return { reason: "path escapes workspace" };
		}
	} catch {
		// 解析失败不断言：缺文件/无权限等走后续 reason 降级。
	}
	return { absolute };
}

/**
 * 按原生 edit 语义投影：每条 oldText 在原始内容中恰好出现一次，
 * 且区间互不重叠；由后向前应用。失败返回 reason。
 */
function projectEdits(
	previousContent: string,
	edits: unknown,
): { content: string } | { reason: string } {
	if (!Array.isArray(edits) || edits.length === 0) return { reason: "missing edits" };
	const spans: Array<{ start: number; end: number; newText: string }> = [];
	for (const edit of edits) {
		const oldText = (edit as any)?.oldText;
		const newText = (edit as any)?.newText;
		if (typeof oldText !== "string" || !oldText || typeof newText !== "string") {
			return { reason: "incomplete edit block" };
		}
		const first = previousContent.indexOf(oldText);
		if (first < 0) return { reason: "oldText does not match file" };
		if (previousContent.indexOf(oldText, first + oldText.length) >= 0) {
			return { reason: "oldText matches more than once" };
		}
		spans.push({ start: first, end: first + oldText.length, newText });
	}
	spans.sort((a, b) => a.start - b.start);
	for (let i = 1; i < spans.length; i++) {
		if (spans[i]!.start < spans[i - 1]!.end) return { reason: "edits overlap" };
	}
	let content = previousContent;
	for (let i = spans.length - 1; i >= 0; i--) {
		const span = spans[i]!;
		content = content.slice(0, span.start) + span.newText + content.slice(span.end);
	}
	return { content };
}

export type PendingPreviewPlan =
	| {
			filePath: string;
			previousContent: string;
			fileExistedBefore: boolean;
			newContent: string;
	  }
	| { reason: string };

/** 由工具名 + 参数 + 工作区文件算出预览计划；任何一步失败回 reason。 */
export function planPendingPreview(toolName: string, args: any, cwd: string): PendingPreviewPlan {
	const pathResult = resolvePreviewPath(args?.path ?? args?.file_path, cwd);
	if ("reason" in pathResult) return pathResult;
	const { absolute } = pathResult;

	if (toolName === "write") {
		if (typeof args?.content !== "string") return { reason: "missing content" };
		if (!existsSync(absolute)) {
			return {
				filePath: absolute,
				previousContent: "",
				fileExistedBefore: false,
				newContent: args.content,
			};
		}
		const read = readPreviewFile(absolute);
		if ("reason" in read) return read;
		return {
			filePath: absolute,
			previousContent: read.content,
			fileExistedBefore: true,
			newContent: args.content,
		};
	}

	if (toolName === "edit") {
		const read = readPreviewFile(absolute);
		if ("reason" in read) return read;
		const projected = projectEdits(read.content, args?.edits);
		if ("reason" in projected) return projected;
		return {
			filePath: absolute,
			previousContent: read.content,
			fileExistedBefore: true,
			newContent: projected.content,
		};
	}

	return { reason: `unsupported tool ${toolName}` };
}

/** FNV-1a 同步 hash（抄 cc-tools `hashText`）：指纹用长度+hash，不 stringify 全文。 */
export function hashPreviewText(text: string): string {
	let hash = 2166136261;
	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36);
}

export type PendingPreviewRenderInput = {
	expanded: boolean;
	isHovered?: () => boolean;
	invalidate?: () => void;
	displayConfig: DisplayConfigInput;
	theme: any;
};

/**
 * 流式防抖窗口：指纹连变时两次重算的最小间隔。只影响流式中的中间帧
 * （预告片最多滞后这么久），首帧/慢速流/落定态行为与原来逐像素一致。
 */
export const PENDING_PREVIEW_DEBOUNCE_MS = 150;

const DEBOUNCE_KEY = "__ccPendingPreviewDebounce";

type DebounceRecord = {
	timer: ReturnType<typeof setTimeout> | null;
	computedAt: number;
};

function getDebounceRecord(state: Record<string, any>): DebounceRecord {
	const record = state[DEBOUNCE_KEY] as DebounceRecord | undefined;
	if (record) return record;
	const fresh: DebounceRecord = { timer: null, computedAt: 0 };
	state[DEBOUNCE_KEY] = fresh;
	return fresh;
}

function clearDebounceTimer(record: DebounceRecord): void {
	if (record.timer) {
		clearTimeout(record.timer);
		record.timer = null;
	}
}

/**
 * 流式预览组件：`Pending…` 动画行 + 内存投影 diff。
 * 参数指纹（含 expanded）命中 `context.state` 缓存即复用，不重跑 Myers。
 * 指纹未命中且距上次重算不足窗口时返回旧组件（若有），并单飞起一个
 * trailing 定时器促发重算——流式停下后屏上一定是最新内容。
 * 失败返回 undefined，由调用方降级为原 Pending 行。
 */
export function renderPendingDiffPreview(
	toolName: string,
	context: any,
	input: PendingPreviewRenderInput,
): any | undefined {
	const args = context?.args;
	if (!args || typeof args !== "object") return undefined;
	// write content 可能很大：指纹用长度+hash，不 JSON 全文（省每帧一次大分配）。
	const writeContent = toolName === "write" ? args.content : undefined;
	const fingerprint = JSON.stringify({
		tool: toolName,
		path: args.path ?? args.file_path ?? null,
		edits: toolName === "edit" ? (args.edits ?? null) : undefined,
		content:
			typeof writeContent === "string"
				? `len:${writeContent.length}:${hashPreviewText(writeContent)}`
				: (writeContent ?? null),
		expanded: input.expanded,
	});
	const state = (context.state ?? {}) as Record<string, any>;
	context.state = state;
	const cacheKey = "__ccPendingPreview";
	const cached = state[cacheKey];
	if (cached && cached.fingerprint === fingerprint && cached.component) return cached.component;

	const debounce = getDebounceRecord(state);
	const now = Date.now();
	if (cached?.component && now - debounce.computedAt < PENDING_PREVIEW_DEBOUNCE_MS) {
		// 流式风暴中：返回旧组件，单飞 trailing 定时器促发重算。
		// 显示效果不变：最终停下来的那一帧一定是最新内容（见测试“最终一致”）。
		clearDebounceTimer(debounce);
		if (typeof input.invalidate === "function") {
			const invalidate = input.invalidate;
			debounce.timer = setTimeout(() => {
				debounce.timer = null;
				try {
					invalidate();
				} catch {
					/* 组件已卸载时空转，不干扰 */
				}
			}, PENDING_PREVIEW_DEBOUNCE_MS);
			(debounce.timer as any)?.unref?.();
		}
		return cached.component;
	}

	const plan = planPendingPreview(toolName, args, context?.cwd);
	if ("reason" in plan) return undefined;
	const component = renderWriteDiffResult(
		plan.newContent,
		{
			expanded: input.expanded,
			filePath: plan.filePath,
			// edit 折叠头显示文件名（与最终态 edit 渲染一致），write 沿用 overwritten/created。
			headerLabel: toolName === "edit" ? basename(plan.filePath) : undefined,
			previousContent: plan.previousContent,
			fileExistedBeforeWrite: plan.fileExistedBefore,
			isHovered: input.isHovered,
			invalidate: input.invalidate,
		},
		input.displayConfig,
		input.theme,
		"",
	);
	state[cacheKey] = { fingerprint, component };
	debounce.computedAt = Date.now();
	clearDebounceTimer(debounce);
	return component;
}
