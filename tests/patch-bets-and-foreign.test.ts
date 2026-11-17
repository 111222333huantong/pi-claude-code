import assert from "node:assert/strict";
import test from "node:test";

import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { PATCH_BETS, patchBetFor } from "../extensions/compat/pi-internals.ts";
import { foreignPatchOnAssistant } from "../extensions/config/diagnostics.ts";
import {
	isOwnPatch,
	OWN_PATCH_NAMES,
	PATCH_NAME_KEY,
	patchRegistry,
	STREAM_THROTTLE_PATCH,
} from "../extensions/utils/patch-keys.ts";

initTheme("dark");

const prototype = AssistantMessageComponent.prototype as any;
const native = prototype.updateContent;

function fakePatch(name: string, downstream: Function): Function {
	const installed: any = function (this: any, ...args: any[]) {
		return downstream.apply(this, args);
	};
	installed[PATCH_NAME_KEY] = name;
	return installed;
}

test.afterEach(() => {
	prototype.updateContent = native;
	patchRegistry.delete(STREAM_THROTTLE_PATCH);
});

test("patch bets cover the major patch surfaces and are addressable", () => {
	const features = PATCH_BETS.map((bet) => bet.feature);
	for (const expected of [
		"tool-execution",
		"assistant-message",
		"markdown",
		"container",
		"tool-grouping",
		"tool-mouse",
	]) {
		assert.ok(features.includes(expected), `missing bet for ${expected}`);
	}
	for (const bet of PATCH_BETS) {
		assert.ok(bet.source.startsWith("packages/"), `${bet.feature}: source not a repo path`);
		assert.match(bet.since, /^\d+\.\d+\.\d+$/, `${bet.feature}: bad version`);
	}
	assert.equal(patchBetFor("tool-execution")?.feature, "tool-execution");
	assert.equal(patchBetFor("nonexistent"), undefined);
});

test("isOwnPatch recognizes named wrappers only", () => {
	assert.equal(isOwnPatch(fakePatch("stream-throttle", native)), true);
	assert.equal(isOwnPatch(fakePatch("compact", native)), true);
	assert.equal(isOwnPatch(native), false);
	assert.equal(
		isOwnPatch(() => {}),
		false,
	);
	assert.equal(isOwnPatch(fakePatch("evil-extension", native)), false);
	// 所有登记的名字都在链名集合内，防止漏登记。
	for (const name of ["stream-throttle", "dotted", "compact", "compact-thinking"]) {
		assert.ok(OWN_PATCH_NAMES.has(name));
	}
});

test("foreignPatchOnAssistant: native top means ours absent, not foreign", () => {
	// 没装补丁（slot 空）且顶层是原生：不算外部覆盖。
	assert.equal(foreignPatchOnAssistant(), false);
});

test("foreignPatchOnAssistant: own named top is not foreign", () => {
	prototype.updateContent = fakePatch("stream-throttle", native);
	patchRegistry.install(STREAM_THROTTLE_PATCH, {});
	assert.equal(foreignPatchOnAssistant(), false);
});

test("foreignPatchOnAssistant: unnamed top with our patch installed is foreign", () => {
	// 模拟另一个 UI 扩展后加载：在我们的链上再压一层无名字 wrapper。
	const ours = fakePatch("stream-throttle", native);
	prototype.updateContent = function (this: any, ...args: any[]) {
		return (ours as any).apply(this, args);
	};
	patchRegistry.install(STREAM_THROTTLE_PATCH, {});
	assert.equal(foreignPatchOnAssistant(), true);
});
