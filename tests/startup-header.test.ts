import assert from "node:assert/strict";
import test from "node:test";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import {
	renderHeaderLines,
	applyStartupHeader,
} from "../extensions/feature/shell/startup-header.ts";
import {
	headerAnimState,
	ensureHeaderAnimTick,
	resetHeaderAnimation,
} from "../extensions/feature/shell/startup-header.ts";
import type { LoadedStats } from "../extensions/feature/shell/loaded-stats.ts";

// 模拟 pi 运行时：注册 app.* 键绑定（默认与 pi 内置一致）
setKeybindings(
	new KeybindingsManager({
		...TUI_KEYBINDINGS,
		"app.interrupt": { defaultKeys: "escape" },
		"app.clear": { defaultKeys: "ctrl+c" },
		"app.exit": { defaultKeys: "ctrl+d" },
		"app.tools.expand": { defaultKeys: "ctrl+o" },
	} as never),
);

// 无 ANSI 的 mock 主题：宽度即可见宽度，便于断言布局
const theme = {
	getFgAnsi: () => "",
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");
const visibleWidth = (line: string) => [...stripAnsi(line)].length;

const meta = {
	model: { provider: "test", id: "model-x" },
	thinkingLevel: "medium",
	cwd: "/home/u/proj",
};

const fakeStats: LoadedStats = {
	skills: { user: 8, project: 4 },
	prompts: { user: 3, project: 2 },
	extensions: { user: 7, project: 2 },
	themes: { user: 1, project: 0 },
	mcpServers: 3,
	detail: {
		skills: { global: [], project: [] },
		prompts: { global: [], project: [] },
		extensions: { global: [], project: [] },
		themes: { global: [], project: [] },
		mcp: { global: [], project: [] },
	},
};

test("盒线布局：顶边标题 + 双栏 + 底边", () => {
	const lines = renderHeaderLines(120, theme, 12, fakeStats, meta);
	// 顶边 + 7 行正文 + 底边
	assert.equal(lines.length, 9);
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 120, "所有行不超宽");
	}
	assert.ok(stripAnsi(lines[0]!).startsWith("╭─── Pi"));
	assert.ok(stripAnsi(lines[0]!).includes(`v${VERSION}`));
	assert.ok(stripAnsi(lines[0]!).endsWith("╮"));
	assert.ok(stripAnsi(lines[8]!).startsWith("╰"));
	const body = lines.map(stripAnsi).join("\n");
	assert.ok(body.includes("Getting started"));
	assert.ok(body.includes("Loaded"));
	assert.ok(body.includes("pi-cc"), "左栏项目标题");
	assert.ok(body.includes("test/model-x · medium effort"));
	assert.ok(body.includes("│"), "双栏分隔线");
	assert.ok(!body.includes("Pi can explain its own features"));
});

test("Loaded 盘点行：扫描中省略号，有数据即计数", () => {
	const pending = renderHeaderLines(120, theme, 12, undefined, meta);
	const pendingText = pending.map(stripAnsi).join("\n");
	assert.ok(pendingText.includes("Loaded"));
	assert.ok(!pendingText.includes("skills"), "扫描中无计数");
	const settled = renderHeaderLines(120, theme, 12, fakeStats, meta);
	const text = settled.map(stripAnsi).join("\n");
	assert.ok(text.includes("12 skills · 5 prompts · 9 extensions · 3 mcp servers"));
	assert.ok(text.includes("18 global · 8 project"));
	assert.ok(text.includes("/loaded for details"));
	assert.ok(!text.includes("Loaded: 12 skills"), "双栏不加 Loaded: 前缀");
});

test("首末帧不同：动画有过程", () => {
	const first = renderHeaderLines(120, theme, 0, undefined, meta).map(stripAnsi).join("\n");
	const last = renderHeaderLines(120, theme, 12, undefined, meta).map(stripAnsi).join("\n");
	assert.notEqual(first, last);
});

test("窄屏回退：单栏盒子垂直堆叠", () => {
	const lines = renderHeaderLines(40, theme, 12, fakeStats, meta);
	assert.equal(lines.length, 11); // 顶边+标题+4 mascot+模型+目录+counts+aggregate+底边
	assert.ok(lines.every((line) => visibleWidth(line) <= 40));
	assert.ok(stripAnsi(lines[0]!).startsWith("╭"));
	assert.ok(lines.some((line) => line.includes("Loaded: 12 skills")));
	assert.ok(!lines.some((line) => line.includes(" │ ")), "单栏无双栏分隔符");
});

test("右栏与参考一致：无多余提示行", () => {
	const lines = renderHeaderLines(120, theme, 12, fakeStats, meta);
	const body = lines.map(stripAnsi).join("\n");
	assert.ok(!body.includes("/context to view"), "无 context 提示行");
	assert.ok(!body.includes("interrupt"), "无按键提示行");
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function stubCtx(captured: { factory?: (tui: any, theme: any) => any }) {
	return {
		hasUI: true,
		cwd: process.cwd(),
		ui: {
			setHeader: (factory: any) => {
				captured.factory = factory;
			},
			theme,
		},
	};
}

const fakeTui = () => ({ requestRender: () => {} });

test("共享动画：后挂载的实例从当前帧续播而非从 0 重来", async () => {
	resetHeaderAnimation();
	const first: { factory?: (tui: any, theme: any) => any } = {};
	applyStartupHeader(stubCtx(first) as any);
	const compA = first.factory!(fakeTui(), theme);
	await sleep(350);
	const mid = headerAnimState().frame;
	assert.ok(mid >= 2 && mid <= 12, `动画在跑（frame=${mid}）`);

	// 第二次挂载（模拟 /reload 或双实例重入）：直接看到当前帧，不是 frame 0
	const second: { factory?: (tui: any, theme: any) => any } = {};
	applyStartupHeader(stubCtx(second) as any);
	const compB = second.factory!(fakeTui(), theme);
	const textA = compA.render(120).map(stripAnsi).join("\n");
	const textB = compB.render(120).map(stripAnsi).join("\n");
	assert.equal(textA, textB, "同帧渲染一致");
	assert.ok(textB.includes("▐██▌"), "已有腿，不是 frame 0（frame 0 除横杠全空）");
	compA.dispose?.();
	compB.dispose?.();
	resetHeaderAnimation();
});

test("共享动画：单一定时器跑到末帧自停并标记完成", async () => {
	resetHeaderAnimation();
	ensureHeaderAnimTick();
	ensureHeaderAnimTick(); // 重复调用不产生第二个定时器
	await sleep(350);
	const mid = headerAnimState().frame;
	assert.ok(mid >= 1 && mid <= 5, `单速推进（frame=${mid}），无双倍速`);
	await sleep(1600);
	const state = headerAnimState();
	assert.equal(state.frame, 12);
	assert.equal(state.done, true);
	assert.equal(state.timer, undefined);
	resetHeaderAnimation();
});
