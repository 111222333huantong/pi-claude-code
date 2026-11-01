/**
 * Golden（落盘快照）测试工具。
 *
 * 与 `node:test` 的 inline 断言互补：inline 断言证明「某个片段存在」，
 * golden 证明「整屏布局没变」——拆文件、调间距、升级 Pi 时，后者才是护栏。
 *
 * 更新方式：UPDATE_GOLDEN=1 npm run test:golden
 * 只更新自己改过的场景时，可直接跑单个用例名过滤：
 *   UPDATE_GOLDEN=1 node --test --test-name-pattern="diff unified" tests/render-golden.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GOLDEN_DIR = dirname(fileURLToPath(import.meta.url));

/** ANSI 只影响颜色；布局与对齐由纯文本决定，golden 统一剥离。 */
export function stripAnsi(text: string): string {
	return text
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}

/** 归一化一行：剥 ANSI、去行尾空白（Box 会按宽度补空格）。 */
export function normalizeLines(lines: readonly string[]): string[] {
	return lines.map((line) => stripAnsi(String(line)).replace(/\s+$/, ""));
}

export function normalizeText(text: string): string {
	return normalizeLines(text.split("\n")).join("\n").replace(/\n+$/, "");
}

function goldenPath(name: string): string {
	return join(GOLDEN_DIR, `${name}.txt`);
}

/**
 * 断言整段文本与 golden 文件一致；`UPDATE_GOLDEN=1` 时改为写入。
 * 失败信息里带逐行 diff，终端里能直接看到哪一列开始漂移。
 */
export function assertGolden(name: string, actualLines: readonly string[]): void {
	const actual = `${normalizeLines(actualLines).join("\n")}\n`;
	const path = goldenPath(name);
	const update = process.env.UPDATE_GOLDEN === "1";

	if (update) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, actual, "utf8");
		return;
	}

	if (!existsSync(path)) {
		assert.fail(
			`missing golden: ${path}\n` +
				`首次生成请运行 UPDATE_GOLDEN=1 npm run test:golden\n\n` +
				`--- actual ---\n${actual}`,
		);
	}

	const expected = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
	if (actual === expected) return;

	const actualLinesNormalized = actual.split("\n");
	const expectedLines = expected.split("\n");
	const max = Math.max(actualLinesNormalized.length, expectedLines.length);
	const diff: string[] = [];
	for (let index = 0; index < max; index++) {
		const left = expectedLines[index];
		const right = actualLinesNormalized[index];
		if (left === right) continue;
		diff.push(`line ${index + 1}:`);
		diff.push(`  - ${JSON.stringify(left)}`);
		diff.push(`  + ${JSON.stringify(right)}`);
	}
	assert.fail(
		`golden mismatch: ${path}\n` +
			`若确认新布局正确，运行 UPDATE_GOLDEN=1 npm run test:golden\n\n` +
			diff.slice(0, 80).join("\n"),
	);
}
