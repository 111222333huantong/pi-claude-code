import assert from "node:assert/strict";
import test from "node:test";
import { ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { pendingDotColor } from "../extensions/utils/tool-loading-icon.ts";
import { clearAllAnimations, toolIconColor } from "../extensions/renderer/tool/result.ts";
import { config } from "../extensions/config/config.ts";
import { installDefaultMode } from "../extensions/renderer/default-mode.ts";
import { installCompactMode } from "../extensions/renderer/compact-mode.ts";
import {
	getMessageDisplayTheme,
	setMessageDisplayTheme,
} from "../extensions/renderer/tool/message-display.ts";
import { WriteExecutionMetadataStore } from "../extensions/renderer/tool/diff/write-execution.ts";

initTheme("dark");

function withNow<T>(now: number, fn: () => T): T {
	const realNow = Date.now;
	Date.now = () => now;
	try {
		return fn();
	} finally {
		Date.now = realNow;
	}
}

const tagTheme = {
	fg: (color: string, text: string) => `<${color}>${text}`,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as any;

const BRAILLE = "[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]";

test("pendingDotColor breathes accent/dim on a 800ms phase", () => {
	assert.equal(
		withNow(0, () => pendingDotColor()),
		"accent",
	);
	assert.equal(
		withNow(100, () => pendingDotColor()),
		"accent",
	);
	assert.equal(
		withNow(799, () => pendingDotColor()),
		"accent",
	);
	assert.equal(
		withNow(800, () => pendingDotColor()),
		"dim",
	);
	assert.equal(
		withNow(900, () => pendingDotColor()),
		"dim",
	);
	assert.equal(
		withNow(1599, () => pendingDotColor()),
		"dim",
	);
	assert.equal(
		withNow(1600, () => pendingDotColor()),
		"accent",
	);
});

test("toolIconColor breathes while executing, stays put otherwise", () => {
	const running: any = { executionStarted: true, isPartial: true, state: {} };
	assert.equal(
		withNow(100, () => toolIconColor(running)),
		"accent",
	);
	assert.equal(
		withNow(900, () => toolIconColor(running)),
		"dim",
	);
	// 排队未起跑：muted 常亮，不随时间变。
	const queued: any = { state: {} };
	assert.equal(
		withNow(100, () => toolIconColor(queued)),
		"muted",
	);
	assert.equal(
		withNow(700, () => toolIconColor(queued)),
		"muted",
	);
	// 落定态不受呼吸影响。
	assert.equal(
		withNow(700, () => toolIconColor({ isError: true, state: {} })),
		"error",
	);
	assert.equal(
		withNow(700, () => toolIconColor({ state: { ccstyleToolVisualState: "success" } })),
		"success",
	);
});

test("default-mode pending icon breathes while a command runs", () => {
	const previousMode = config.mode;
	config.mode = "on";
	const hooks = installDefaultMode(new WriteExecutionMetadataStore());
	// Pi 渲染用的是全局主题而非构造器 ui 主题：不断言具体色名，只断言首个
	// SGR（pending 图标色）随时间变化，且图标仍是盲文 loader。
	const firstSgr = (line: string) => line.match(/^\n? (\x1B\[[0-9;]+m)/)?.[1] ?? "";
	try {
		const bash = new ToolExecutionComponent(
			"bash",
			"bash-breath",
			{ command: "sleep 10" },
			{},
			undefined,
			{ theme: tagTheme, requestRender() {}, setStatus() {} } as any,
			process.cwd(),
		) as any;
		bash.markExecutionStarted();
		// renderCall 返回带闭包缓存的 view：桩时间内先 updateDisplay 重建，
		// 否则两次 render 命中同一缓存（生产环境由动画 tick 驱动重建）。
		const bright = withNow(100, () => {
			bash.updateDisplay();
			return bash.render(100).join("\n");
		});
		const dimmed = withNow(900, () => {
			bash.updateDisplay();
			return bash.render(100).join("\n");
		});
		assert.match(bright, new RegExp(BRAILLE), "pending shows the loader");
		assert.match(dimmed, new RegExp(BRAILLE), "pending shows the loader");
		assert.ok(firstSgr(bright), "pending icon is colored");
		assert.notEqual(firstSgr(bright), firstSgr(dimmed), "pending icon color breathes");
	} finally {
		config.mode = previousMode;
		clearAllAnimations();
		hooks.shutdown();
	}
});

test("compact edit line breathes while the edit runs", () => {
	const previousMode = config.mode;
	const previousTheme = getMessageDisplayTheme();
	config.mode = "compact";
	const hooks = installCompactMode({ writeMetadata: new WriteExecutionMetadataStore() });
	setMessageDisplayTheme(tagTheme);
	try {
		const edit = new ToolExecutionComponent(
			"edit",
			"edit-breath",
			{ path: "a.ts" },
			{},
			undefined,
			{ theme: tagTheme, requestRender() {} } as any,
			process.cwd(),
		) as any;
		edit.markExecutionStarted();
		const bright = withNow(100, () => edit.render(120).join("\n"));
		const dimmed = withNow(900, () => edit.render(120).join("\n"));
		assert.match(bright, new RegExp(`<accent>${BRAILLE}`));
		assert.match(dimmed, new RegExp(`<dim>${BRAILLE}`));
	} finally {
		config.mode = previousMode;
		setMessageDisplayTheme(previousTheme);
		clearAllAnimations();
		hooks.shutdown();
	}
});
