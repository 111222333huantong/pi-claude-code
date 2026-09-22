import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { componentAtLocalRow } from "../extensions/renderer/mouse/layout.ts";
import {
	disposeTranscriptGutter,
	isTranscriptGutterContainer,
	refreshTranscriptGutter,
	TRANSCRIPT_RIGHT_GUTTER,
} from "../extensions/renderer/transcript-gutter.ts";

/**
 * 宽度敏感的假组件：行数 = ceil(width/2)、行宽 = width —— 宽度一变行高就变，
 * 用于暴露 render 与 handleMouse / 行高映射之间的宽度不一致（y 漂移）。
 */
function makeWidthSensitiveComponent(name: string, mouseEvents: any[], message = false): any {
	const component: any = message ? Object.create(AssistantMessageComponent.prototype) : {};
	component.children = [];
	component.render = (width: number) => {
		const height = Math.max(1, Math.ceil(width / 2));
		return Array.from({ length: height }, (_, row) => `${name}${row}`.padEnd(width, "."));
	};
	component.handleMouse = (event: any) => {
		mouseEvents.push({ name, ...event });
		return undefined;
	};
	component.invalidate = () => {};
	return component;
}

/** 宽度无关的普通消息桩：行宽恒等于收到的 width。 */
function makeLineComponent(width: number): string[] {
	return [`<${"x".repeat(Math.max(0, width - 1))}`];
}

test("transcript 容器 render 右缘内缩 2 列，左缘不动", () => {
	disposeTranscriptGutter();
	const msg: any = Object.create(AssistantMessageComponent.prototype);
	msg.children = [];
	msg.render = makeLineComponent;
	const chat: any = new Container();
	chat.addChild(msg);
	const root: any = new Container();
	root.addChild(chat);

	assert.equal(isTranscriptGutterContainer(chat), false);
	refreshTranscriptGutter(root);
	assert.equal(isTranscriptGutterContainer(chat), true);

	const lines = chat.render(100);
	assert.equal(lines.length, 1);
	assert.equal(lines[0].length, 100 - TRANSCRIPT_RIGHT_GUTTER);
	assert.equal(lines[0].startsWith("<"), true); // 左缘原位不动
});

test("用户消息组件同样触发容器识别", () => {
	disposeTranscriptGutter();
	const user: any = Object.create(UserMessageComponent.prototype);
	user.children = [];
	user.render = makeLineComponent;
	const chat: any = new Container();
	chat.addChild(user);

	refreshTranscriptGutter(chat); // root 即容器自身
	assert.equal(isTranscriptGutterContainer(chat), true);
	assert.equal(chat.render(80)[0].length, 80 - TRANSCRIPT_RIGHT_GUTTER);
});

test("空 transcript、非消息容器与 null root 安全 no-op", () => {
	disposeTranscriptGutter();
	const empty: any = new Container();
	refreshTranscriptGutter(empty);
	assert.equal(isTranscriptGutterContainer(empty), false);

	const filler = { children: [], render: (width: number) => ["f".repeat(width)] };
	const plain: any = new Container();
	plain.addChild(filler);
	refreshTranscriptGutter(plain);
	assert.equal(isTranscriptGutterContainer(plain), false);
	assert.equal(plain.render(100)[0].length, 100);

	assert.doesNotThrow(() => refreshTranscriptGutter(null));
});

test("重复扫描幂等，不叠加内缩", () => {
	disposeTranscriptGutter();
	const msg: any = Object.create(AssistantMessageComponent.prototype);
	msg.children = [];
	msg.render = makeLineComponent;
	const chat: any = new Container();
	chat.addChild(msg);

	refreshTranscriptGutter(chat);
	refreshTranscriptGutter(chat);
	refreshTranscriptGutter(chat);
	assert.equal(chat.render(100)[0].length, 100 - TRANSCRIPT_RIGHT_GUTTER);
});

test("handleMouse 宽度平移：行高与 render 一致，且不改写原事件", () => {
	disposeTranscriptGutter();
	const events: any[] = [];
	const a = makeWidthSensitiveComponent("a", events, true);
	const b = makeWidthSensitiveComponent("b", events);
	const chat: any = new Container();
	chat.addChild(a);
	chat.addChild(b);
	refreshTranscriptGutter(chat);

	// 显示侧：children 按 98 渲染 → 49 + 49 = 98 行。
	assert.equal(chat.render(100).length, 98);

	// 命中侧：官方派发给的是未平移的全宽事件，包装后按同一 98 宽算行高。
	const event = { width: 100, height: 98, x: 4, y: 60, button: 0 };
	chat.handleMouse(event);
	assert.equal(events.length, 1);
	assert.equal(events[0].name, "b");
	assert.equal(events[0].y, 11); // 60 − 49（缩后行高）
	assert.equal(events[0].width, 98); // 平移后的宽度
	assert.equal(event.width, 100); // 原事件不被原地改写
});

test("极窄宽度 clamp 到 1，不抛错", () => {
	disposeTranscriptGutter();
	const msg: any = Object.create(AssistantMessageComponent.prototype);
	msg.children = [];
	msg.render = (width: number) => [`w${width}`];
	const chat: any = new Container();
	chat.addChild(msg);
	refreshTranscriptGutter(chat);

	assert.doesNotThrow(() => chat.render(2));
	assert.doesNotThrow(() => chat.render(1));
});

test("dispose 后恢复原始 render / handleMouse", () => {
	disposeTranscriptGutter();
	const events: any[] = [];
	const a = makeWidthSensitiveComponent("a", events, true);
	const b = makeWidthSensitiveComponent("b", events);
	const chat: any = new Container();
	chat.addChild(a);
	chat.addChild(b);
	refreshTranscriptGutter(chat);
	assert.equal(isTranscriptGutterContainer(chat), true);

	disposeTranscriptGutter();
	assert.equal(isTranscriptGutterContainer(chat), false);
	assert.equal(chat.render(100).length, 100); // 50 + 50，全宽行高恢复
	chat.handleMouse({ width: 100, height: 100, x: 4, y: 60, button: 0 });
	assert.equal(events.length, 1);
	assert.equal(events[0].y, 10); // 60 − 50
	assert.equal(events[0].width, 100);
});

test("componentAtLocalRow：gutter 容器内按缩后宽度下钻，行高一致", () => {
	disposeTranscriptGutter();
	const events: any[] = [];
	const a = makeWidthSensitiveComponent("a", events, true);
	const b = makeWidthSensitiveComponent("b", events);
	const chat: any = new Container();
	chat.addChild(a);
	chat.addChild(b);
	refreshTranscriptGutter(chat);

	// 直接以 gutter 容器为入口：缩后两子各 49 行，row 49 落入第二个子组件
	//（未平移时 a 有 50 行，row 49 会误命中 a）。
	const direct = componentAtLocalRow(chat, 49, 100);
	assert.equal(direct?.component, b);

	// 从父容器进入：父按全宽量子（a/b 经包装后共 98 行），递归到 chat 再平移。
	const doc: any = new Container();
	const header = { children: [], render: () => ["H"] };
	doc.addChild(header);
	doc.addChild(chat);
	const viaParent = componentAtLocalRow(doc, 60, 100);
	assert.equal(viaParent?.component, b);
	assert.equal(viaParent?.row, 10); // 60 − 1(header) − 49(a)
});

test("未安装 gutter 的容器行高映射保持全宽不变", () => {
	const events: any[] = [];
	const p = makeWidthSensitiveComponent("p", events, true);
	const q = makeWidthSensitiveComponent("q", events);
	const plain: any = new Container();
	plain.addChild(p);
	plain.addChild(q);

	const hit = componentAtLocalRow(plain, 49, 100);
	assert.equal(hit?.component, p); // 全宽下 p 占 50 行
	assert.equal(hit?.row, 49);
});
