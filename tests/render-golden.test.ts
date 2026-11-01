import test from "node:test";
import { assertGolden } from "./golden/harness.ts";
import { renderGoldenCases } from "./golden/render-cases.ts";

/**
 * 整屏布局快照：diff 宽度梯度、工具卡状态、工具分组。
 *
 * 这些用例的断言在 tests/golden/*.txt，更新方式见 harness.ts。
 * 颜色不在快照里（已统一剥 ANSI）；颜色槽位由 tests/tool-diff*.test.ts 等
 * 现有用例的 SGR 断言覆盖。
 */
test("golden: diff 与工具卡布局", async (t) => {
	const cases = await renderGoldenCases();
	// 防呆：场景被误删时不要静默通过。
	if (cases.length < 12) {
		throw new Error(`expected at least 12 golden cases, got ${cases.length}`);
	}
	for (const testCase of cases) {
		await t.test(testCase.name, () => {
			assertGolden(testCase.name, testCase.lines);
		});
	}
});
