import assert from "node:assert/strict";
import test from "node:test";
import { CustomMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/index.ts";

initTheme("dark");

// 单独成文件：入口会装各模块的全局补丁，不能污染其他渲染测试。
test("the extension entry registers its own subagent-notification renderer", () => {
	const renderers = new Map<string, unknown>();
	const pi: any = new Proxy(
		{},
		{
			get(_target, prop) {
				if (prop === "events") return { on: () => () => {}, emit() {} };
				if (prop === "registerMessageRenderer") {
					return (customType: string, renderer: unknown) => renderers.set(customType, renderer);
				}
				return () => {};
			},
		},
	);
	extension(pi);
	const renderer = renderers.get("subagent-notification");
	assert.equal(typeof renderer, "function");
	const component = new CustomMessageComponent(
		{
			role: "custom",
			customType: "subagent-notification",
			content: "<task-notification>…</task-notification>",
			display: true,
			details: { id: "6dae0e11-9341-43b", status: "completed", toolUses: 2 },
			timestamp: 1,
		} as any,
		renderer as any,
	);
	const rows = component
		.render(120)
		.map((line) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""))
		.filter((line) => line.trim());
	assert.match(rows[0]!, /^ ✓ Subagent Completion 6dae0e11-9341-43b · 2 tool uses · /);
});
