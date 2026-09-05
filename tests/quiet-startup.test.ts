import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createQuietStartupFile } from "../extensions/feature/shell/quiet-startup.ts";

test("缺文件读 false，写 true 后读 true", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-cc-quiet-"));
	try {
		const file = createQuietStartupFile(join(dir, "settings.json"));
		assert.equal(file.read(), false);
		file.write(true);
		assert.equal(file.read(), true);
		file.write(false);
		assert.equal(file.read(), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("写入保留其他键", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-cc-quiet-"));
	try {
		const path = join(dir, "settings.json");
		writeFileSync(path, JSON.stringify({ theme: "x", quietStartup: false }));
		createQuietStartupFile(path).write(true);
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		assert.equal(parsed.theme, "x");
		assert.equal(parsed.quietStartup, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("损坏文件不覆盖", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-cc-quiet-"));
	try {
		const path = join(dir, "settings.json");
		writeFileSync(path, "{oops");
		const file = createQuietStartupFile(path);
		assert.equal(file.read(), false);
		file.write(true);
		assert.equal(readFileSync(path, "utf8"), "{oops");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
