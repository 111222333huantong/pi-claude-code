import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CompactionSummaryMessageComponent,
	getMarkdownTheme,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import { Loader } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG, normalizeConfig, setConfig } from "../extensions/config/config.ts";
import {
	barFrame,
	estimateSummaryTokens,
	lookupTokensAfter,
	recordCompactionResult,
} from "../extensions/feature/compaction-progress.ts";
import {
	installMessageDisplayRendering,
	setMessageDisplayTheme,
} from "../extensions/renderer/tool/message-display.ts";

initTheme("dark");
function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}
const fakeTheme = { fg: (_c: string, t: string) => t };

test("compaction-progress: tokensAfter 回填进折叠标题", () => {
	setConfig(normalizeConfig({ ...DEFAULT_CONFIG, mode: "on" }));
	const dispose = installMessageDisplayRendering();
	setMessageDisplayTheme(fakeTheme);
	recordCompactionResult(48231, 6100);
	const component = new CompactionSummaryMessageComponent(
		{ summary: "s", tokensBefore: 48231 } as any,
		getMarkdownTheme(),
	);
	const line = stripAnsi(component.render(120).join("\n"));
	assert.match(line, /Compacted from 48,231 tokens → 6.1k · −87%/);
	// 未记录的 before 保持原样
	const other = new CompactionSummaryMessageComponent(
		{ summary: "s", tokensBefore: 999 } as any,
		getMarkdownTheme(),
	);
	assert.match(stripAnsi(other.render(120).join("\n")), /Compacted from 999 tokens( ·|$)/);
	dispose();
});

test("compaction-progress: estimateSummaryTokens 按 4 字符/token 粗估", () => {
	assert.equal(estimateSummaryTokens(""), 0);
	assert.equal(estimateSummaryTokens("abcd"), 1);
	assert.equal(estimateSummaryTokens("x".repeat(400)), 100);
});

test("compaction-progress: lookupTokensAfter 未命中返回 undefined", () => {
	assert.equal(lookupTokensAfter(123456789), undefined);
});

test("compaction-progress: correctedBefore 显著超过 reported 时用修正值显示", () => {
	setConfig(normalizeConfig({ ...DEFAULT_CONFIG, mode: "on" }));
	const dispose = installMessageDisplayRendering();
	setMessageDisplayTheme(fakeTheme);
	// swe-2 漏报场景：reported=1.3k、corrected=80k、after=6k
	recordCompactionResult(1300, 6000, 80_000);
	const component = new CompactionSummaryMessageComponent(
		{ summary: "s", tokensBefore: 1300 } as any,
		getMarkdownTheme(),
	);
	const line = stripAnsi(component.render(120).join("\n"));
	// 显示修正后的 before（不是文件里的错值），saved% 用修正值算
	assert.match(line, /Compacted from 80,000 tokens → 6\.0k · −93%/);
	// correctedBefore 不显著超过 reported（<1.5×）时保留原值
	recordCompactionResult(10_000, 2000, 12_000);
	const c2 = new CompactionSummaryMessageComponent(
		{ summary: "s", tokensBefore: 10_000 } as any,
		getMarkdownTheme(),
	);
	assert.match(stripAnsi(c2.render(120).join("\n")), /Compacted from 10,000 tokens → 2\.0k · −80%/);
	dispose();
});

test("compaction-progress: barFrame 时间渐近条——前期走快、尾部逼近 95% 上限", () => {
	// 缺省 expected=30s：1-exp(-t/30) × 95%
	const p = (t: number) => Number(/(\d+)%$/.exec(barFrame(t))?.[1] ?? -1);
	// t=0 → 0%
	assert.equal(p(0), 0);
	// 早期快速推进：t=5s → 1-e^(-1/6) ≈ 15.4% × 0.95 ≈ 15%
	assert.ok(p(5_000) >= 12 && p(5_000) <= 18, `t=5s: ${p(5_000)}`);
	// 中点：t=15s → 1-e^(-0.5) ≈ 39.3% × 0.95 ≈ 37%
	assert.ok(p(15_000) >= 33 && p(15_000) <= 42, `t=15s: ${p(15_000)}`);
	// 到 expected：t=30s → 1-e^-1 ≈ 63% × 0.95 ≈ 60%
	assert.ok(p(30_000) >= 55 && p(30_000) <= 65, `t=30s: ${p(30_000)}`);
	// 超时仍在爬：t=90s → 1-e^-3 ≈ 95% × 0.95 ≈ 90%
	assert.ok(p(90_000) >= 88 && p(90_000) <= 92, `t=90s: ${p(90_000)}`);
	// 永不越过 95% 硬上限（哪怕 t 很大）
	assert.ok(p(300_000) <= 95, `t=300s 封顶: ${p(300_000)}`);
	// 条面形态：■□ + 空格 + 百分比
	assert.match(barFrame(15_000), /^[■□]+ \d+%$/);
	assert.equal(barFrame(15_000).split(" ")[0].length, 14);
	// 单调不减
	assert.ok(p(10_000) <= p(20_000) && p(20_000) <= p(40_000), "单调递增");
});

test("compaction-progress: Loader patch 链安全——kind 非 compaction 不受影响", () => {
	// 模拟一个非 compaction Loader：patch 安装后 updateDisplay 仍渲染原 message
	const loader: any = Object.create(Loader.prototype);
	loader.kind = "working";
	loader.frames = ["·"];
	loader.currentFrame = 0;
	loader.intervalId = null;
	loader.message = "Working...";
	loader.spinnerColorFn = (t: string) => t;
	loader.messageColorFn = (t: string) => t;
	loader.setText = function (t: string) {
		this.text = t;
	};
	loader.invalidate = () => {};
	loader.ui = null;
	loader.updateDisplay();
	assert.equal(loader.text, "· Working...");
});
