/**
 * 流式渲染节流。
 *
 * Pi 1.4 的交互层在每个 `message_update` 都调用
 * `AssistantMessageComponent.updateContent()`，而该方法会 `clear()` 内容容器并
 * `new Markdown(...)`；Markdown 的实例级缓存因此永远不命中，整段文本每个 token
 * 都重新 lex/wrap/measure（上游 issue #6665）。扩展侧最安全的兜底是把中间帧
 * 合并到 ~10fps：
 *
 * - `isStreaming !== true` 一律直通（`message_end` 会无条件做最终渲染）；
 * - 流式中间帧按 `config.streamThrottleMs` 合并，尾帧用 timer 补一次，
 *   避免模型停顿或流结束时停在旧内容；
 * - 只合并 `updateContent`，工具调用识别在 Pi 的 `message_update` 分支里，
 *   不经过这里，因此不会漏工具。
 *
 * 这是上游修复前的 stopgap：`streamThrottleMs = 0` 可完全关闭。
 */

import { getAssistantMessagePrototype } from "../compat/pi-internals.ts";
import { config } from "../config/config.ts";
import {
	PATCH_NAME_KEY,
	PROTOTYPE_ORIGINAL_KEY,
	patchRegistry,
	STREAM_THROTTLE_PATCH,
} from "../utils/patch-keys.ts";

type UpdateContent = (message: any, isStreaming?: boolean) => void;

type ThrottleState = {
	/** 上一次真正渲染的时间（合成时钟下由测试推进）。 */
	last: number;
	initialized: boolean;
	timer: ReturnType<typeof setTimeout> | null;
	pending: any;
};

const states = new WeakMap<object, ThrottleState>();
let now: () => number = () => performance.now();
/** node:test 默认关闭，避免改动既有流式用例的时序；单测/基准显式开启。 */
let forceEnabledForTests = false;

/** 仅供测试/基准：替换时钟（传 null 恢复 performance.now）。 */
export function _setStreamThrottleClock(fn: (() => number) | null): void {
	now = fn ?? (() => performance.now());
}

/** 仅供测试/基准：测试环境默认关闭，显式开启后再安装补丁。 */
export function _setStreamThrottleEnabledForTests(value: boolean): void {
	forceEnabledForTests = value;
}

function throttleMs(): number {
	if (!forceEnabledForTests && process.env.NODE_TEST_CONTEXT !== undefined) return 0;
	const value = config.streamThrottleMs;
	return Number.isFinite(value) && value > 0 ? value : 0;
}

function stateOf(component: object): ThrottleState {
	let state = states.get(component);
	if (!state) {
		state = { last: 0, initialized: false, timer: null, pending: undefined };
		states.set(component, state);
	}
	return state;
}

function cancelPending(state: ThrottleState): void {
	if (state.timer) clearTimeout(state.timer);
	state.timer = null;
	state.pending = undefined;
}

export type StreamThrottleHooks = { dispose(): void };

/**
 * 安装节流包装。必须晚于 compact-mode / compact-thinking / 打点段落，
 * 保证包装在最外层；重复安装会先拆掉旧包装，避免套娃。
 */
export function installStreamThrottle(): StreamThrottleHooks {
	const prototype = getAssistantMessagePrototype();
	if (!prototype) return { dispose() {} };

	const previous = patchRegistry.get<StreamThrottleHooks & { active: boolean }>(
		STREAM_THROTTLE_PATCH,
	);
	if (previous) previous.dispose();

	const downstream = prototype.updateContent as UpdateContent;
	if (typeof downstream !== "function") {
		return { dispose() {} };
	}

	const patch: StreamThrottleHooks & { active: boolean } = {
		active: true,
		dispose() {
			patch.active = false;
			if (prototype.updateContent === installed) prototype.updateContent = downstream;
			patchRegistry.dispose(STREAM_THROTTLE_PATCH, patch);
		},
	};

	const installed = function (this: any, message: any, isStreaming?: boolean): void {
		if (!patch.active) {
			downstream.call(this, message, isStreaming);
			return;
		}

		// 非流式（最终帧、hover/展开、主题切换）必须立即渲染。
		if (isStreaming !== true) {
			const state = states.get(this);
			if (state) cancelPending(state);
			downstream.call(this, message, isStreaming);
			return;
		}

		const interval = throttleMs();
		if (interval <= 0) {
			downstream.call(this, message, true);
			return;
		}

		const state = stateOf(this);
		const at = now();
		// 第一次调用立即渲染；之后按间隔合并。
		if (!state.initialized || at - state.last >= interval) {
			cancelPending(state);
			state.initialized = true;
			state.last = at;
			downstream.call(this, message, true);
			return;
		}

		// 中间帧：只保留最新内容，到点补一帧。
		state.pending = message;
		if (state.timer) return;
		const delay = Math.max(0, interval - (at - state.last));
		state.timer = setTimeout(() => {
			state.timer = null;
			const pending = state.pending;
			state.pending = undefined;
			if (!patch.active || pending === undefined) return;
			state.last = now();
			downstream.call(this, pending, true);
		}, delay);
		state.timer.unref?.();
	};

	prototype.updateContent = installed;
	// 与打点段落一致：后装的 compact-thinking 经此键直达原生，避免 shutdown
	// 恢复时停在节流包装器上（它已不再属于当前链）。
	(installed as any)[PROTOTYPE_ORIGINAL_KEY] =
		(downstream as any)?.[PROTOTYPE_ORIGINAL_KEY] ?? downstream;
	(installed as any)[PATCH_NAME_KEY] = "stream-throttle";
	patchRegistry.install(STREAM_THROTTLE_PATCH, patch);
	return patch;
}
