import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * agent_id → 派生信息，供工具卡标题把 UUID 换成 subagent 标题。
 *
 * 数据源（三路，精度递减）：
 * 1. `subagents:created` 事件 `{ id, type, description }`（tintinweb 系；fork 保留该协议）；
 * 2. session_start 回填：扫历史 toolResult（Agent 派生结果正文必带相邻的
 *    `Agent ID:` / `Description:` 行，details 里更是有结构化字段）——覆盖
 *    resume 回来的旧会话，那些 spawn 早于本进程，无事件可接。
 * 不做 transcript 组件扫描：事件即精确映射，回填兜底。
 * 进程级缓存 + 上限，无需随会话清理（ID 全局唯一，旧条目无害）。
 */

export type AgentSpawnInfo = {
	type: string;
	description: string;
};

const byId = new Map<string, AgentSpawnInfo>();
const MAX_ENTRIES = 300;

export function recordAgentSpawn(id: unknown, type: unknown, description: unknown): void {
	if (typeof id !== "string" || id.length === 0) return;
	if (byId.size >= MAX_ENTRIES) {
		const oldest = byId.keys().next();
		if (!oldest.done) byId.delete(oldest.value);
	}
	byId.set(id, {
		type: typeof type === "string" ? type : "",
		description: typeof description === "string" ? description : "",
	});
}

/** 有映射回标题（description 优先，其次 type），无映射回 undefined 走短 ID 回退。 */
export function resolveAgentTitle(agentId: string): string | undefined {
	const info = byId.get(agentId);
	if (!info) return undefined;
	return info.description || info.type || undefined;
}

/** 测试/重载用；正常流程不清（resume 会话的旧 ID 仍需映射）。 */
export function clearAgentTitles(): void {
	byId.clear();
}

const AGENT_ID_RE = /Agent ID:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{3})/i;
const DESCRIPTION_RE = /Description:\s*([^\n]+)/;
const MAX_BACKFILL_ENTRIES = 3000;
const MAX_BACKFILL_CHARS = 500_000;

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

/** 从 Agent 派生结果正文提 (id, description)：相邻两行，缺一不可。 */
function parseSpawnResultText(text: string): { id: string; description: string } | undefined {
	if (!nonEmptyString(text)) return undefined;
	const id = AGENT_ID_RE.exec(text)?.[1];
	const description = DESCRIPTION_RE.exec(text)?.[1]?.trim();
	if (!id || !description) return undefined;
	return { id, description };
}

function textItemsOf(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const item of value) {
		if (item && typeof item === "object" && (item as any).type === "text") {
			const text = (item as any).text;
			if (typeof text === "string" && text) out.push(text);
		}
	}
	return out;
}

/**
 * 回填：扫会话 entries，把历史 Agent 派生结果里的映射捡回来。
 * 纯函数 + 全程容错（形状漂移就跳过）；调用方控制条目上限。
 */
export function backfillAgentTitles(entries: readonly unknown[]): number {
	let found = 0;
	let chars = 0;
	const scanned =
		entries.length > MAX_BACKFILL_ENTRIES ? entries.slice(-MAX_BACKFILL_ENTRIES) : entries;
	for (const raw of scanned) {
		if (!raw || typeof raw !== "object") continue;
		const entry = raw as any;
		const message = entry.message ?? entry;
		if (message?.role !== undefined && message.role !== "toolResult") continue;
		// 首选结构化 details（displayName/description/agentId 与正文同源）。
		const details = message?.details;
		if (details && typeof details === "object") {
			const id = details.agentId;
			const description =
				(typeof details.description === "string" && details.description) ||
				(typeof details.displayName === "string" && details.displayName) ||
				"";
			if (typeof id === "string" && id && description) {
				if (!byId.has(id)) {
					recordAgentSpawn(id, details.subagentType, description);
					found++;
				}
				continue;
			}
		}
		for (const text of textItemsOf(message?.content)) {
			if (chars + text.length > MAX_BACKFILL_CHARS) return found;
			chars += text.length;
			const parsed = parseSpawnResultText(text);
			if (parsed && !byId.has(parsed.id)) {
				recordAgentSpawn(parsed.id, undefined, parsed.description);
				found++;
			}
		}
	}
	return found;
}

export function registerAgentTitles(pi: ExtensionAPI): void {
	(pi.on as (name: string, handler: (event: any) => void) => void)("subagents:created", (event) => {
		recordAgentSpawn(event?.id, event?.type, event?.description);
	});
	(pi.on as (name: string, handler: (event: any, ctx: any) => void) => void)(
		"session_start",
		(_event, ctx) => {
			try {
				const branch = ctx?.sessionManager?.getBranch?.();
				if (Array.isArray(branch)) backfillAgentTitles(branch);
			} catch {
				// 拿不到分支就靠事件流；标题回退短 ID。
			}
		},
	);
}
