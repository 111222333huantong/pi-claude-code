/**
 * Shiki 高亮基准：冷启动 / 热 miss / 热 hit / 超限降级 / LRU 压力。
 * 用法：node scripts/benchmark-highlight.ts（type-stripping 直跑，无需构建）。
 * 改渲染相关代码前后各跑一次，对比耗时。
 */
import { performance } from "node:perf_hooks";
import { highlightCode, initTheme } from "@earendil-works/pi-coding-agent";
import {
	MAX_CACHE_ENTRIES,
	MAX_HL_CHARS,
	ShikiHighlightCache,
} from "../extensions/renderer/tool/diff/shiki-highlight.ts";

// Pi 原生 fallback 高亮需要先初始化主题（与测试 harness 一致）。
initTheme("dark");

/** 确定性语料：重复但多变的真实感代码，避免压缩/缓存失真。 */
function makeDoc(lang: "ts" | "md" | "json", targetChars: number): string {
	const chunks: string[] = [];
	let i = 0;
	while (chunks.join("\n").length < targetChars) {
		i++;
		if (lang === "ts") {
			chunks.push(
				`// section ${i}: helper with generics, strings, numbers and comments`,
				`export function compute${i}<T extends Record<string, unknown>>(input: T, flag = true): string | null {`,
				`  const label = \`result-${i}-\${flag ? "on" : "off"}\`;`,
				`  if (!input || typeof input.count !== "number") return null;`,
				`  return label + ":" + String(input.count * ${1000 + i});`,
				`}`,
				``,
			);
		} else if (lang === "md") {
			chunks.push(
				`## Section ${i} — overview & details`,
				``,
				`This paragraph links [docs](https://example.com/${i}) and shows \`inline_${i}\` code,`,
				`plus a fenced block:`,
				``,
				"```ts",
				`const value${i} = await load(${i * 7});`,
				"```",
				``,
				`- item ${i}a`,
				`- item ${i}b`,
				``,
			);
		} else {
			chunks.push(
				`  "entry_${i}": {`,
				`    "id": ${i},`,
				`    "name": "name-${i}",`,
				`    "tags": ["a${i}", "b${i}", "c${i}"],`,
				`    "enabled": ${i % 2 === 0},`,
				`    "score": ${(i * 1.5).toFixed(2)}`,
				`  },`,
			);
		}
	}
	if (lang === "json") return `{\n${chunks.join("\n").replace(/,\s*$/, "")}\n}`;
	return chunks.join("\n");
}

const LANG_OF = { ts: "typescript", md: "markdown", json: "json" } as const;
const THEME = "github-dark";

function fmt(ms: number): string {
	if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
	if (ms < 1000) return `${ms.toFixed(1)}ms`;
	return `${(ms / 1000).toFixed(2)}s`;
}

/** miss：等 invalidate 回调；超限同步跳过（无回调），返回 null。 */
async function timeMiss(
	cache: ShikiHighlightCache,
	code: string,
	lang: string,
): Promise<number | null> {
	if (code.length > MAX_HL_CHARS) return null;
	const t0 = performance.now();
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("highlight timeout 60s")), 60_000);
		const got = cache.get(code, lang, THEME, [""], () => {
			clearTimeout(timer);
			resolve();
		});
		if (got !== undefined) {
			clearTimeout(timer);
			resolve();
		}
	});
	return performance.now() - t0;
}

function timeHit(cache: ShikiHighlightCache, code: string, lang: string): number {
	const t0 = performance.now();
	const got = cache.get(code, lang, THEME, [""]);
	if (got === undefined) throw new Error("expected cache hit");
	return performance.now() - t0;
}

function timeNative(code: string, lang: string): number {
	const t0 = performance.now();
	highlightCode(code, lang);
	return performance.now() - t0;
}

const row = (cells: Array<string | number>) => console.log(cells.join(" | "));

async function main(): Promise<void> {
	console.log(`MAX_HL_CHARS=${MAX_HL_CHARS}`);
	console.log("");
	row(["case", "chars", "cold miss", "warm miss", "hit", "native sync"]);
	let first = true;
	for (const lang of ["ts", "md", "json"] as const) {
		for (const [name, size] of [
			["small", 3_000],
			["medium", 30_000],
			// large 必须落在降级线内（留 2k 裕量），否则测到的是跳过快路径。
			["large", MAX_HL_CHARS - 2_000],
			["xlarge", 500_000],
		] as const) {
			const code = makeDoc(lang, size);
			const cache = new ShikiHighlightCache();
			// 真 cold 只有全进程第一次（动态 import + WASM + 主题）；之后 loader 已暖。
			const cold = first ? await timeMiss(cache, code, LANG_OF[lang]) : null;
			first = false;
			const warm = await timeMiss(cache, `${code}\n// v2-${name}`, LANG_OF[lang]);
			let hit: string;
			try {
				const key = `${code}\n// v2-${name}`;
				hit = key.length > MAX_HL_CHARS ? "over-limit" : fmt(timeHit(cache, key, LANG_OF[lang]));
			} catch {
				hit = "n/a (evicted/skipped)";
			}
			let native: string;
			try {
				native = size > 80_000 ? "skipped" : fmt(timeNative(code, LANG_OF[lang]));
			} catch {
				native = "error";
			}
			row([
				`${lang}/${name}`,
				code.length,
				cold === null ? "— (loader warm)" : fmt(cold),
				warm === null ? "over-limit (sync skip)" : fmt(warm),
				hit,
				native,
			]);
		}
	}

	// 超限快路径：应同步返回 undefined（微秒级）。
	{
		const cache = new ShikiHighlightCache();
		const big = makeDoc("ts", MAX_HL_CHARS + 10_000);
		const t0 = performance.now();
		const got = cache.get(big, "typescript", THEME, [""]);
	 const dt = performance.now() - t0;
		console.log("");
		console.log(`oversize fast-path: got=${got === undefined ? "undefined" : "VALUE!"} in ${fmt(dt)}`);
	}

	// LRU 压力：插入 cap+30 个小文档后，前 10 个应被淘汰（证明有界，不无限增长）。
	{
		const cache = new ShikiHighlightCache();
		const total = MAX_CACHE_ENTRIES + 30;
		const docs = Array.from({ length: total }, (_, i) => makeDoc("ts", 500) + `\n// doc-${i}`);
		for (const doc of docs) {
			// eslint-disable-next-line no-await-in-loop
			await timeMiss(cache, doc, "typescript");
		}
		let hits = 0;
		for (const doc of docs.slice(0, 10)) {
			if (cache.get(doc, "typescript", THEME, [""]) !== undefined) hits++;
		}
		console.log(`lru pressure: first-10 hits ${hits}/10 after ${total} inserts (cap ${MAX_CACHE_ENTRIES})`);
	}
}

await main();
