import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { config } from "../extensions/config/config.ts";
import {
	_setStreamThrottleClock,
	_setStreamThrottleEnabledForTests,
	installStreamThrottle,
} from "../extensions/renderer/stream-throttle.ts";

initTheme("dark");

function message(text: string, timestamp = 1): any {
	return { role: "assistant", timestamp, content: [{ type: "text", text }] };
}

/**
 * 节流只合并 `isStreaming === true` 的中间帧；最终帧、hover/展开直通。
 * 用 `component.lastMessage` 观察下游是否真的被调用。
 */
test("stream-throttle: 合并中间帧，最终帧直通", async () => {
	const previous = config.streamThrottleMs;
	config.streamThrottleMs = 40;
	_setStreamThrottleEnabledForTests(true);
	let clock = 0;
	_setStreamThrottleClock(() => clock);
	const throttle = installStreamThrottle();
	try {
		const component: any = new AssistantMessageComponent(message("first"), true);
		// 第一次流式帧立即渲染。
		component.updateContent(message("first"), true);
		assert.equal(component.lastMessage.content[0].text, "first");

		// 同一毫秒内的后续帧全部合并，只保留最新内容。
		component.updateContent(message("second"), true);
		component.updateContent(message("third"), true);
		assert.equal(component.lastMessage.content[0].text, "first");

		// 推进时钟到下一帧窗口：立即渲染最新的 pending 内容。
		clock = 40;
		component.updateContent(message("fourth"), true);
		assert.equal(component.lastMessage.content[0].text, "fourth");

		// 最终帧（message_end）无论间隔多短都必须直通。
		component.updateContent(message("final", 2), false);
		assert.equal(component.lastMessage.content[0].text, "final");
	} finally {
		throttle.dispose();
		_setStreamThrottleClock(null);
		_setStreamThrottleEnabledForTests(false);
		config.streamThrottleMs = previous;
	}
});

test("stream-throttle: 尾帧 timer 补渲染，非流式调用会取消 pending", async () => {
	const previous = config.streamThrottleMs;
	config.streamThrottleMs = 30;
	_setStreamThrottleEnabledForTests(true);
	let clock = 0;
	_setStreamThrottleClock(() => clock);
	const throttle = installStreamThrottle();
	try {
		const component: any = new AssistantMessageComponent(message("a"), true);
		component.updateContent(message("a"), true);
		component.updateContent(message("b"), true);
		// 还没到窗口：只有首帧。
		assert.equal(component.lastMessage.content[0].text, "a");

		// 到点后 timer 把最新 pending 补上（不依赖新的 message_update）。
		await new Promise((resolve) => setTimeout(resolve, 80));
		assert.equal(component.lastMessage.content[0].text, "b");

		// 非流式帧立即生效，并取消任何 pending。
		clock = 35;
		component.updateContent(message("c"), true);
		component.updateContent(message("done", 2), false);
		assert.equal(component.lastMessage.content[0].text, "done");
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(component.lastMessage.content[0].text, "done");
	} finally {
		throttle.dispose();
		_setStreamThrottleClock(null);
		_setStreamThrottleEnabledForTests(false);
		config.streamThrottleMs = previous;
	}
});

test("stream-throttle: 积压超过阈值时进入 catch-up 立即补帧", () => {
	const previous = config.streamThrottleMs;
	config.streamThrottleMs = 100;
	_setStreamThrottleEnabledForTests(true);
	const clock = 0;
	_setStreamThrottleClock(() => clock);
	const throttle = installStreamThrottle();
	try {
		const component: any = new AssistantMessageComponent(message("a"), true);
		component.updateContent(message("a"), true);
		// 同一时刻连续 9 帧：前 8 帧合并，第 9 帧触发 catch-up。
		for (let index = 1; index <= 9; index++) {
			component.updateContent(message(`b${index}`), true);
		}
		assert.equal(component.lastMessage.content[0].text, "b9", "backlog drains immediately");

		// catch-up 窗口内继续来帧也立即渲染。
		component.updateContent(message("c1"), true);
		component.updateContent(message("c2"), true);
		assert.equal(component.lastMessage.content[0].text, "c2");

		// 非流式帧直通并清空 catch-up 状态。
		component.updateContent(message("done", 2), false);
		assert.equal(component.lastMessage.content[0].text, "done");
	} finally {
		throttle.dispose();
		_setStreamThrottleClock(null);
		_setStreamThrottleEnabledForTests(false);
		config.streamThrottleMs = previous;
	}
});

test("stream-throttle: 关闭时直通，dispose 后恢复原方法", () => {
	const previous = config.streamThrottleMs;
	config.streamThrottleMs = 100;
	_setStreamThrottleEnabledForTests(true);
	const throttle = installStreamThrottle();
	try {
		const component: any = new AssistantMessageComponent(message("x"), true);
		config.streamThrottleMs = 0;
		component.updateContent(message("y"), true);
		assert.equal(component.lastMessage.content[0].text, "y");
	} finally {
		throttle.dispose();
		_setStreamThrottleEnabledForTests(false);
		config.streamThrottleMs = previous;
	}
});
