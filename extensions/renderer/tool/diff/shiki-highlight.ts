/**
 * 超限降级线（字符数）：基准 78k 文档异步约 160ms（占位符覆盖），
 * scripts/benchmark-highlight.ts 实测，勿拍脑袋。
 */
export const MAX_HL_CHARS = 80_000;
/**
 * LRU 上限：基准显示 60 个文档即淘汰（48 时前 10 全灭）。128 条 ×
 * 平均 30k 文档 ≈ 8MB 最坏内存，长会话可接受。benchmark 定数。
 * （导出供基准脚本按 cap 自适应加压；生产代码勿依赖具体数值。）
 */
export const MAX_CACHE_ENTRIES = 128;

type CodeToAnsi = (code: string, lang: any, theme: any) => Promise<string>;
/** 可注入的 shiki 加载器（测试用假 loader，生产走动态 import）。 */
export type ShikiLoader = () => Promise<CodeToAnsi>;
type Loader = ShikiLoader;
type Subscriber = { fallback: readonly string[]; invalidate: () => void };
type Pending = { work: Promise<void>; subscribers: Set<Subscriber> };

let defaultLoad: Promise<CodeToAnsi> | undefined;
const loadDefault: Loader = () => {
	if (!defaultLoad) {
		defaultLoad = import("@shikijs/cli")
			.then((module) => module.codeToANSI as CodeToAnsi)
			.catch((error) => {
				defaultLoad = undefined;
				throw error;
			});
	}
	return defaultLoad;
};

function differs(lines: readonly string[], fallback: readonly string[]): boolean {
	return lines.length !== fallback.length || lines.some((line, index) => line !== fallback[index]);
}

export class ShikiHighlightCache {
	private readonly cache = new Map<string, string[]>();
	private readonly pending = new Map<string, Pending>();
	private readonly loader: Loader;

	constructor(loader: Loader = loadDefault) {
		this.loader = loader;
	}

	get(
		code: string,
		lang: string | undefined,
		theme: string,
		fallback: readonly string[],
		invalidate?: () => void,
	): string[] | undefined {
		if (!lang || code.length > MAX_HL_CHARS) return undefined;
		const key = `${theme}\0${lang}\0${code}`;
		const cached = this.cache.get(key);
		if (cached) {
			this.cache.delete(key);
			this.cache.set(key, cached);
			return cached;
		}

		const existing = this.pending.get(key);
		if (existing) {
			if (invalidate && ![...existing.subscribers].some((item) => item.invalidate === invalidate)) {
				existing.subscribers.add({ fallback, invalidate });
			}
			return undefined;
		}

		const pending: Pending = { work: undefined as never, subscribers: new Set() };
		if (invalidate) pending.subscribers.add({ fallback, invalidate });
		pending.work = this.loader()
			.then((highlight) => highlight(code, lang, theme))
			.then((ansi) => {
				const lines = ansi.replace(/\r/g, "").replace(/\n$/, "").split("\n");
				this.cache.set(key, lines);
				while (this.cache.size > MAX_CACHE_ENTRIES) {
					const oldest = this.cache.keys().next().value;
					if (oldest !== undefined) this.cache.delete(oldest);
				}
				for (const subscriber of pending.subscribers) {
					if (!differs(lines, subscriber.fallback)) continue;
					try {
						subscriber.invalidate();
					} catch {
						// One component must not prevent the other subscribers from repainting.
					}
				}
			})
			.catch(() => {})
			.finally(() => this.pending.delete(key));
		this.pending.set(key, pending);
		return undefined;
	}

	clear(): void {
		this.cache.clear();
	}
}

export const shikiHighlightCache = new ShikiHighlightCache();

/** 预热语言 × shiki 主题：与 resolveShikiTheme 的 github-dark/light 对齐。 */
const PREWARM_LANGS = [
	"typescript",
	"tsx",
	"javascript",
	"markdown",
	"json",
	"python",
	"rust",
	"go",
];
const PREWARM_THEMES = ["github-dark", "github-light"];

let prewarmed = false;

/**
 * 安装时空跑一次：动态 import + WASM + 主题只加载一次（基准约 200ms），
 * 后面首次展开 diff 不再顿。幂等；失败静默（get 的懒加载兜底仍在）。
 */
export function prewarmShikiHighlight(): void {
	if (prewarmed) return;
	prewarmed = true;
	for (const theme of PREWARM_THEMES) {
		for (const lang of PREWARM_LANGS) {
			try {
				shikiHighlightCache.get("", lang, theme, []);
			} catch {
				// 失败走后续真实调用的懒加载。
			}
		}
	}
}
