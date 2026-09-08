import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	clearPendingPreviewFileCache,
	MAX_PENDING_PREVIEW_BYTES,
	planPendingPreview,
	renderPendingDiffPreview,
} from "../extensions/renderer/tool/diff/pending-preview.ts";
import { getToolDisplayConfig } from "../extensions/config/config.ts";

const theme = {
	fg(_color: string, text: string) {
		return text;
	},
	bg(_color: string, text: string) {
		return text;
	},
	bold(text: string) {
		return text;
	},
} as any;

function fixture(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "pending-preview-"));
	for (const [name, content] of Object.entries(files)) {
		writeFileSync(join(dir, name), content, "utf8");
	}
	return dir;
}

test("edit: 单条精确替换投影出新旧内容", () => {
	const dir = fixture({ "a.ts": "const TIMEOUT = 5000;\nconst RETRY = 5000;\n" });
	try {
		const plan = planPendingPreview(
			"edit",
			{ path: "a.ts", edits: [{ oldText: "TIMEOUT = 5000", newText: "TIMEOUT = 10000" }] },
			dir,
		);
		assert.ok(!("reason" in plan), `unexpected reason: ${JSON.stringify(plan)}`);
		if ("reason" in plan) return;
		assert.equal(plan.previousContent, "const TIMEOUT = 5000;\nconst RETRY = 5000;\n");
		assert.ok(plan.newContent.includes("TIMEOUT = 10000"));
		assert.ok(plan.newContent.includes("const RETRY = 5000;"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
		clearPendingPreviewFileCache();
	}
});

test("edit: oldText 命中多次/不存在/重叠一律回 reason", () => {
	const dir = fixture({ "a.ts": "foo bar foo\nsecond line\n" });
	try {
		const twice = planPendingPreview(
			"edit",
			{ path: "a.ts", edits: [{ oldText: "foo", newText: "x" }] },
			dir,
		);
		assert.ok("reason" in twice && /more than once/.test((twice as any).reason));
		const missing = planPendingPreview(
			"edit",
			{ path: "a.ts", edits: [{ oldText: "nope", newText: "x" }] },
			dir,
		);
		assert.ok("reason" in missing && /does not match/.test((missing as any).reason));
		const overlap = planPendingPreview(
			"edit",
			{
				path: "a.ts",
				edits: [
					{ oldText: "foo bar", newText: "x" },
					{ oldText: "bar foo", newText: "y" },
				],
			},
			dir,
		);
		assert.ok("reason" in overlap && /overlap/.test((overlap as any).reason));
		const empty = planPendingPreview("edit", { path: "a.ts", edits: [] }, dir);
		assert.ok("reason" in empty);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		clearPendingPreviewFileCache();
	}
});

test("write: 覆盖与新建；缺 content 回 reason", () => {
	const dir = fixture({ "old.txt": "hello\n" });
	try {
		const overwrite = planPendingPreview("write", { path: "old.txt", content: "world\n" }, dir);
		assert.ok(!("reason" in overwrite));
		if ("reason" in overwrite) return;
		assert.equal(overwrite.previousContent, "hello\n");
		assert.equal(overwrite.newContent, "world\n");
		assert.equal(overwrite.fileExistedBefore, true);

		const created = planPendingPreview("write", { path: "new.txt", content: "hi\n" }, dir);
		assert.ok(!("reason" in created));
		if ("reason" in created) return;
		assert.equal(created.previousContent, "");
		assert.equal(created.fileExistedBefore, false);

		const missing = planPendingPreview("write", { path: "old.txt" }, dir);
		assert.ok("reason" in missing);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		clearPendingPreviewFileCache();
	}
});

test("render: 预览组件渲染出删/加行，同参复用缓存", () => {
	const dir = fixture({ "login.ts": "const TIMEOUT = 5000;\nconst RETRY = 3;\n" });
	try {
		const context: any = {
			args: {
				path: "login.ts",
				edits: [{ oldText: "TIMEOUT = 5000", newText: "TIMEOUT = 10000" }],
			},
			cwd: dir,
		};
		const input = { expanded: true, displayConfig: getToolDisplayConfig, theme };
		const first = renderPendingDiffPreview("edit", context, input);
		assert.ok(first && typeof first.render === "function");
		const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
		const lines = strip(first.render(100).join("\n"));
		assert.ok(lines.includes("TIMEOUT = 5000"), `missing removed line, got:\n${lines}`);
		assert.ok(lines.includes("TIMEOUT = 10000"), `missing added line, got:\n${lines}`);
		const second = renderPendingDiffPreview("edit", context, input);
		assert.strictEqual(second, first, "same args must reuse the cached component");
		// 折叠态与最终态一致：只显示摘要头，不展开全文。
		const folded = renderPendingDiffPreview(
			"edit",
			{ args: context.args, cwd: dir },
			{ expanded: false, displayConfig: getToolDisplayConfig, theme },
		);
		assert.ok(folded && typeof folded.render === "function");
		assert.ok(
			folded.render(100).join("\n").includes("login.ts"),
			"collapsed preview must keep the file header",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		clearPendingPreviewFileCache();
	}
});
test("超限/目录/未知工具回 reason，不抛错", () => {
	const dir = fixture({ "a.ts": "x\n" });
	try {
		assert.ok("reason" in planPendingPreview("bash", { command: "ls" }, dir));
		assert.ok("reason" in planPendingPreview("edit", {}, dir));
		assert.ok(
			"reason" in
				planPendingPreview(
					"edit",
					{ path: "missing.ts", edits: [{ oldText: "a", newText: "b" }] },
					dir,
				),
		);
		assert.ok(MAX_PENDING_PREVIEW_BYTES >= 1_000_000);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		clearPendingPreviewFileCache();
	}
});
