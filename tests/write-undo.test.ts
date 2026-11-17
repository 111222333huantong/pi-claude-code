import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WriteExecutionMetadataStore } from "../extensions/renderer/tool/diff/write-execution.ts";

test("undoLatest: 恢复快照内容（文件原已存在）", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ccstyle-undo-"));
	const path = join(dir, "a.txt");
	const store = new WriteExecutionMetadataStore();
	// 模拟 writeSnapshotOperations 留下的快照：原内容 + 绝对路径。
	store.set("call-1", {
		fileExistedBeforeWrite: true,
		previousContent: "original\n",
		absolutePath: path,
		capturedAt: 1000,
	});
	const undone = await store.undoLatest();
	assert.equal(undone?.path, path);
	assert.equal(readFileSync(path, "utf8"), "original\n");
	// 已回滚的快照从 store 移除，再调返回 undefined。
	assert.equal(await store.undoLatest(), undefined);
});

test("undoLatest: 快照时文件不存在 → undo 删除", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ccstyle-undo-"));
	const path = join(dir, "new.txt");
	const store = new WriteExecutionMetadataStore();
	store.set("call-1", {
		fileExistedBeforeWrite: false,
		absolutePath: path,
		capturedAt: 1000,
	});
	// write 已落盘（模拟官方执行后状态）。
	const { writeFileSync } = await import("node:fs");
	writeFileSync(path, "agent wrote this");
	const undone = await store.undoLatest();
	assert.equal(undone?.restoredBytes, 0);
	assert.equal(existsSync(path), false);
});

test("undoLatest: 无快照内容（diffUnavailableReason）不回滚", async () => {
	const store = new WriteExecutionMetadataStore();
	store.set("call-1", {
		fileExistedBeforeWrite: true,
		diffUnavailableReason: "previous file exceeds limit",
		absolutePath: "/tmp/x",
		capturedAt: 1000,
	});
	assert.equal(await store.undoLatest(), undefined);
	// 快照未被消费（防误删）。
	assert.notEqual(store.get("call-1"), undefined);
});

test("undoLatest: 快照时间戳最新者胜出（多次 write 回最近一次）", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ccstyle-undo-"));
	const pathA = join(dir, "a.txt");
	const pathB = join(dir, "b.txt");
	const store = new WriteExecutionMetadataStore();
	store.set("old", {
		fileExistedBeforeWrite: true,
		previousContent: "old-content",
		absolutePath: pathA,
		capturedAt: 1000,
	});
	store.set("new", {
		fileExistedBeforeWrite: true,
		previousContent: "new-content",
		absolutePath: pathB,
		capturedAt: 2000,
	});
	const undone = await store.undoLatest();
	assert.equal(undone?.path, pathB);
	assert.equal(readFileSync(pathB, "utf8"), "new-content");
});

test("undoLatest: 空 store / 无 absolutePath 的快照返回 undefined", async () => {
	const store = new WriteExecutionMetadataStore();
	assert.equal(await store.undoLatest(), undefined);
	// 旧版快照（无 absolutePath 字段）不参与 undo。
	store.set("legacy", { fileExistedBeforeWrite: true, previousContent: "x" });
	assert.equal(await store.undoLatest(), undefined);
});
