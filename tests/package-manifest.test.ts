/**
 * 发布清单守卫：`npm pack` 只带 `files` 允许的路径，测试却是从源码树直接 import。
 * 这里把两边的差距钉住——清单指向的文件必须存在，extension 的相对导入不能跑出
 * 会被发布的目录，主题目录与 `pi.themes` 不能脱节。
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
const files: string[] = pkg.files;
const extensionsRoot = join(root, "extensions");

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return walk(path);
		return path.endsWith(".ts") ? [path] : [];
	});
}

test("pi.extensions 指向的文件存在", () => {
	const entries: string[] = pkg.pi.extensions;
	assert.ok(Array.isArray(entries) && entries.length > 0, "pi.extensions 非空");
	for (const rel of entries) {
		assert.ok(existsSync(join(root, rel)), `extension 入口存在：${rel}`);
	}
});

test("themes 目录与 pi.themes 清单一致", () => {
	const listed = new Set<string>(
		(pkg.pi.themes as string[]).map((rel: string) => rel.replace(/^\.\//, "")),
	);
	for (const name of readdirSync(join(root, "themes"))) {
		if (!name.endsWith(".json")) continue;
		assert.ok(listed.has(`themes/${name}`), `主题已登记：themes/${name}`);
	}
	for (const rel of listed) {
		assert.ok(existsSync(join(root, rel)), `主题文件存在：${rel}`);
	}
});

test("CHANGELOG.md 随包发布（Pi 1.5 的扩展更新说明依赖它）", () => {
	// 默认 changelog 路径是包根 CHANGELOG.md；不放进 files 就永远不会展示。
	assert.ok(files.includes("CHANGELOG.md"), "files 包含 CHANGELOG.md");
});

test("extension 的相对导入不跑出 extensions/（否则 tarball 里缺文件）", () => {
	const importRe = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)"(\.[^"]+)"/g;
	const offenders: string[] = [];
	for (const file of walk(extensionsRoot)) {
		const source = readFileSync(file, "utf-8");
		for (const match of source.matchAll(importRe)) {
			const specifier = match[1]!;
			const target = resolve(dirname(file), specifier);
			if (!target.startsWith(extensionsRoot + sep)) {
				offenders.push(`${relative(root, file)} -> ${specifier}`);
			}
		}
	}
	assert.deepEqual(offenders, [], "所有相对导入都落在 extensions/ 内");
});
