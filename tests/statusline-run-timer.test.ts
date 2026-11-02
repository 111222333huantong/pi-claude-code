import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import registerStatusline from "../extensions/feature/statusline/index.ts";

/**
 * run 计时必须覆盖整个 settled 周期：`turn_end` / `agent_end` 之后 Pi 仍可能
 * 重试、恢复或续跑；只有 `agent_settled` 才是最终空闲信号。
 */
test("statusline: run timer survives turn_end/agent_end until agent_settled", async (t) => {
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	const dir = mkdtempSync(join(tmpdir(), "pi-statusline-run-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	const realNow = Date.now;
	let now = 1_000_000;
	Date.now = () => now;

	const events = new Map<string, Function>();
	let footer!: { render: (width: number) => string[]; dispose: () => void };
	registerStatusline({
		registerCommand: () => {},
		getCommands: () => [],
		getThinkingLevel: () => null,
		on: (name: string, handler: Function) => events.set(name, handler),
	} as any);

	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: dir,
		thinkingLevel: null,
		getContextUsage: () => undefined,
		model: { id: "test", name: "test", contextWindow: 1_000 },
		sessionManager: {
			getLeafId: () => null,
			getEntry: () => undefined,
			getBranch: () => [],
			getEntries: () => [],
		},
		ui: {
			notify: () => {},
			setFooter: (factory: Function) => {
				footer = factory(
					{ requestRender: () => {} },
					{ fg: (_color: string, text: string) => text },
					{ getExtensionStatuses: () => new Map(), onBranchChange: () => () => {} },
				);
			},
		},
	} as any;

	t.after(async () => {
		await events.get("session_shutdown")?.({}, ctx);
		footer?.dispose();
		Date.now = realNow;
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	});

	await events.get("session_start")?.({}, ctx);
	const line = () => footer.render(200).join("\n");

	await events.get("agent_start")?.({}, ctx);
	now += 5_000;
	assert.match(line(), /run 5s/, "agent_start 起算");

	// 工具回合结束：不是最终空闲，停表会把长任务显示成最后一回合耗时。
	await events.get("turn_end")?.({}, ctx);
	now += 3_000;
	assert.match(line(), /run 8s/, "turn_end 不停表");

	// agent_end 后仍可能有自动重试/恢复/排队续跑。
	await events.get("agent_end")?.({}, ctx);
	now += 2_000;
	assert.match(line(), /run 10s/, "agent_end 不停表");

	// 续跑复用同一起点，不把 run 计时重置成 0。
	await events.get("agent_start")?.({}, ctx);
	now += 4_000;
	assert.match(line(), /run 14s/, "续跑不重置起点");

	await events.get("agent_settled")?.({}, ctx);
	assert.doesNotMatch(line(), /run \d/, "settled 后隐藏 run 段");
});
