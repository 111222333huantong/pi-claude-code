import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { toolIconColor } from "../extensions/renderer/tool/tool-state.ts";
import { pendingDotColor } from "../extensions/utils/tool-loading-icon.ts";

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

test("toolIconColor follows visual state without time-based breathing", () => {
	const running: any = { executionStarted: true, isPartial: true, state: {} };
	assert.equal(toolIconColor(running), "dim");
	// 排队未起跑：muted 常亮，不随时间变。
	const queued: any = { state: {} };
	assert.equal(toolIconColor(queued), "muted");
	// 落定态：error 红 / success 绿。
	assert.equal(toolIconColor({ isError: true, state: {} }), "error");
	assert.equal(toolIconColor({ state: { ccstyleToolVisualState: "success" } }), "success");
});
