import type { Stats } from "node:fs";
import { lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createWriteToolDefinition, type WriteOperations } from "@earendil-works/pi-coding-agent";

export const MAX_COMPARABLE_WRITE_BYTES = 512_000;
export const MAX_WRITE_METADATA_ENTRIES = 100;

export type WriteExecutionMeta = {
	fileExistedBeforeWrite: boolean;
	previousContent?: string;
	diffUnavailableReason?: string;
	/** 工具执行耗时（毫秒，含队列等待+落盘）；缺失表示未知，不展示。 */
	elapsedMs?: number;
	/** 官方解析后的绝对路径（undo 回滚用）；缺失表示快照时未记录。 */
	absolutePath?: string;
	/** 快照时间戳；undo 时用于「最近 write」判定。 */
	capturedAt?: number;
};

export class WriteExecutionMetadataStore {
	readonly entries = new Map<string, WriteExecutionMeta>();

	set(toolCallId: string, metadata: WriteExecutionMeta): void {
		this.entries.delete(toolCallId);
		this.entries.set(toolCallId, metadata);
		while (this.entries.size > MAX_WRITE_METADATA_ENTRIES) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) break;
			this.entries.delete(oldest);
		}
	}

	get(toolCallId: unknown): WriteExecutionMeta | undefined {
		return typeof toolCallId === "string" ? this.entries.get(toolCallId) : undefined;
	}

	delete(toolCallId: string): void {
		this.entries.delete(toolCallId);
	}

	clear(): void {
		this.entries.clear();
	}

	/**
	 * 最近一次有快照的 write（capturedAt 最大且带 absolutePath）。
	 * undo 命令据此定位回滚目标；无快照返回 undefined。
	 */
	latestSnapshot(): { toolCallId: string; meta: WriteExecutionMeta } | undefined {
		let latest: { toolCallId: string; meta: WriteExecutionMeta } | undefined;
		for (const [toolCallId, meta] of this.entries) {
			if (typeof meta.absolutePath !== "string" || meta.absolutePath.length === 0) continue;
			if (
				!latest ||
				(meta.capturedAt ?? 0) > (latest.meta.capturedAt ?? 0) ||
				(meta.capturedAt === latest.meta.capturedAt && toolCallId > latest.toolCallId)
			) {
				latest = { toolCallId, meta };
			}
		}
		return latest;
	}

	/**
	 * 回滚最近一次 write：恢复快照内容；写入前不存在的文件按删除处理。
	 * 返回 { path, restoredBytes } 供调用方提示；失败抛错。
	 */
	async undoLatest(): Promise<{ path: string; restoredBytes: number } | undefined> {
		const latest = this.latestSnapshot();
		if (!latest) return undefined;
		const { toolCallId, meta } = latest;
		const path = meta.absolutePath!;
		if (meta.fileExistedBeforeWrite === false) {
			// 快照时文件不存在：write 新建的文件 → undo 即删除。
			await unlink(path);
			this.entries.delete(toolCallId);
			return { path, restoredBytes: 0 };
		}
		if (typeof meta.previousContent !== "string") {
			// 无快照内容（diffUnavailableReason 分支）：不回滚，防止丢数据。
			return undefined;
		}
		await writeFile(path, meta.previousContent, "utf8");
		this.entries.delete(toolCallId);
		return { path, restoredBytes: Buffer.byteLength(meta.previousContent, "utf8") };
	}
}

async function capturePreviousContent(absolutePath: string): Promise<WriteExecutionMeta> {
	let info: Stats;
	try {
		info = await lstat(absolutePath);
	} catch (error: any) {
		if (error?.code === "ENOENT") return { fileExistedBeforeWrite: false };
		return {
			fileExistedBeforeWrite: true,
			diffUnavailableReason: "unable to inspect the previous file",
		};
	}

	if (!info.isFile()) {
		return {
			fileExistedBeforeWrite: true,
			diffUnavailableReason: "previous path is not a regular file",
		};
	}
	if (info.size > MAX_COMPARABLE_WRITE_BYTES) {
		return {
			fileExistedBeforeWrite: true,
			diffUnavailableReason: `previous file exceeds ${MAX_COMPARABLE_WRITE_BYTES} bytes`,
		};
	}

	try {
		const bytes = await readFile(absolutePath);
		const previousContent = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return { fileExistedBeforeWrite: true, previousContent };
	} catch {
		return {
			fileExistedBeforeWrite: true,
			diffUnavailableReason: "previous file is not comparable UTF-8 text",
		};
	}
}

export async function executeWriteWithMetadata(
	store: WriteExecutionMetadataStore,
	toolCallId: string,
	params: { path: string; content: string },
	signal: AbortSignal | undefined,
	cwd: string,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: undefined }> {
	store.delete(toolCallId);
	// 覆盖层只揽写前快照：路径解析（含 Windows 下 /mnt/<drive>、/cygdrive/<drive> 转换）、
	// 目录创建、mutation queue 与错误文案全交回 pi 官方 write，参数与官方逐字一致。
	const startedAt = performance.now();
	// fork：官方写回后补记耗时（写流式头展示用；覆盖层不重写落盘路径）。
	const noteElapsed = () => {
		const meta = store.get(toolCallId);
		if (meta) meta.elapsedMs = performance.now() - startedAt;
	};
	const definition = createWriteToolDefinition(cwd, {
		operations: writeSnapshotOperations(store, toolCallId, signal),
	}) as any;
	try {
		await definition.execute(toolCallId, params, signal, undefined, { cwd });
		noteElapsed();
		return writeSuccessResult(params);
	} catch (error) {
		// 文件已落盘，只是官方写后那次 abort 检查抦了错：保持「文件已改即成功」。
		if (store.get(toolCallId) && signal?.aborted) {
			noteElapsed();
			return writeSuccessResult(params);
		}
		store.delete(toolCallId);
		throw error;
	}
}

/** 官方 write 的落盘操作：拿到的是官方解析后的绝对路径，快照才跟真实落盘一致。 */
function writeSnapshotOperations(
	store: WriteExecutionMetadataStore,
	toolCallId: string,
	signal: AbortSignal | undefined,
): WriteOperations {
	return {
		mkdir: (dir) => mkdir(dir, { recursive: true }).then(() => {}),
		writeFile: async (absolutePath, content) => {
			store.delete(toolCallId);
			const metadata = await capturePreviousContent(absolutePath);
			// 官方只在进 operations 之前查 abort（紧接着这次调用，中间没有 await），
			// 快照读盘期间的取消只能在这里补：抛错，不写文件，也不留 metadata。
			if (signal?.aborted) throw new Error("Operation aborted");
			await writeFile(absolutePath, content, "utf8");
			// 写已生效：后续 abort 不得把这次写报成失败，快照先落下。
			// absolutePath + capturedAt 补记：undo 命令据此找回「最近一次 write」回滚。
			store.set(toolCallId, {
				...metadata,
				absolutePath,
				capturedAt: Date.now(),
			});
		},
	};
}

function writeSuccessResult(params: { path: string; content: string }): {
	content: Array<{ type: "text"; text: string }>;
	details: undefined;
} {
	return {
		content: [
			{
				type: "text",
				text: `Successfully wrote ${Buffer.byteLength(params.content, "utf8")} bytes to ${params.path}`,
			},
		],
		details: undefined,
	};
}
