import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf-8"));
const themePaths: string[] = pkg.pi.themes;
assert.ok(Array.isArray(themePaths) && themePaths.length > 0, "pi.themes 非空");

const HEX = /^#[0-9a-fA-F]{6}$/;
const baseline = JSON.parse(
	await readFile(resolve(root, themePaths[0]!.replace(/^\.\//, "")), "utf-8"),
);

for (const rel of themePaths) {
	test(`主题可用：${rel}`, async () => {
		const theme = JSON.parse(await readFile(resolve(root, rel.replace(/^\.\//, "")), "utf-8"));
		// 与基线同键： renderer 取槽位不踩空。
		assert.deepEqual(Object.keys(theme.vars).sort(), Object.keys(baseline.vars).sort());
		assert.deepEqual(Object.keys(theme.colors).sort(), Object.keys(baseline.colors).sort());
		// vars 全 hex；colors 引用 var 或 hex。
		for (const [k, v] of Object.entries<string>(theme.vars)) {
			assert.match(v, HEX, `vars.${k} 为 hex`);
		}
		for (const [k, v] of Object.entries<string>(theme.colors)) {
			assert.ok(v.startsWith("#") ? HEX.test(v) : v in theme.vars, `colors.${k} 可解析`);
		}
		for (const [k, v] of Object.entries<string>(theme.export)) {
			assert.ok(v in theme.vars, `export.${k} 可解析`);
		}
	});
}

test("Catppuccin 两套：Mocha 暗 + Latte 亮", async () => {
	const mocha = JSON.parse(await readFile(join(root, "themes/catppuccin-mocha.json"), "utf-8"));
	const latte = JSON.parse(await readFile(join(root, "themes/catppuccin-latte.json"), "utf-8"));
	assert.equal(mocha.name, "catppuccin-mocha");
	assert.equal(latte.name, "catppuccin-latte");
	// 官方色板抽查（Mocha base #1e1e2e / Blue #89b4fa；Latte base #eff1f5 / Blue #1e66f5）。
	assert.equal(mocha.vars.surface, "#1e1e2e");
	assert.equal(mocha.vars.accent, "#89b4fa");
	assert.equal(latte.vars.panel, "#eff1f5");
	assert.equal(latte.vars.accent, "#1e66f5");
});
