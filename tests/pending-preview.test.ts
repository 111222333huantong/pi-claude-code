import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getToolDisplayConfig } from "../extensions/config/config.ts";
import {
	clearPendingPreviewFileCache,
	hashPreviewText,
	MAX_PENDING_PREVIEW_BYTES,
	PENDING_PREVIEW_DEBOUNCE_MS,
	planPendingPreview,
	renderPendingDiffPreview,
} from "../extensions/renderer/tool/diff/pending-preview.ts";

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

test("hashPreviewText: 确定性 FNV-1a，大 content 指纹不分配全文 JSON", () => {
	assert.equal(hashPreviewText("hello"), hashPreviewText("hello"));
	assert.notEqual(hashPreviewText("hello"), hashPreviewText("world"));
	assert.match(hashPreviewText("x"), /^[0-9a-z]+$/);
	// write 大 content：同参二次渲染复用组件（指纹命中，不重跑 Myers）。
	const dir = fixture({ "big.ts": "base\n" });
	try {
		const content = `${"line\n".repeat(2000)}tail`;
		const input = { expanded: false, displayConfig: getToolDisplayConfig, theme };
		const context: any = { args: { path: "big.ts", content }, cwd: dir };
		const first = renderPendingDiffPreview("write", context, input);
		assert.ok(first && typeof first.render === "function");
		const second = renderPendingDiffPreview("write", context, input);
		assert.strictEqual(second, first, "same large content must reuse the cached component");
	} finally {
		rmSync(dir, { recursive: true, force: true });
		clearPendingPreviewFileCache();
	}
});

test("防抖：窗口内指纹连变返回旧组件，trailing 定时器促发最终一致", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	try {
		const dir = fixture({ "base.txt": "base\n" });
		try {
			let invalidations = 0;
			const input = {
				expanded: true,
				displayConfig: getToolDisplayConfig,
				theme,
				invalidate: () => {
					invalidations++;
				},
			};
			const context: any = { args: { path: "new-v1.txt", content: "v1\n" }, cwd: dir };
			const first = renderPendingDiffPreview("write", context, input);
			assert.ok(first && typeof first.render === "function");

			// 窗口内换 content：不重算，返回同一旧实例。
			context.args = { path: "new-v1.txt", content: "v2 with more text\n" };
			const held = renderPendingDiffPreview("write", context, input);
			assert.strictEqual(held, first, "窗口内必须复用旧组件，不重跑 Myers");
			assert.ok(
				stripAnsi(first.render(100).join("\n")).includes("v1"),
				"旧组件内容保持 v1（显示滞后 < 150ms，落定后一致）",
			);

			// trailing 定时器到点 → 促发一次 invalidate。
			t.mock.timers.tick(PENDING_PREVIEW_DEBOUNCE_MS + 50);
			assert.equal(invalidations, 1, "trailing 定时器必须恰好促发一次重算");

			// 下一帧指纹仍对不上（已超窗）→ 重算为新内容。
			const second = renderPendingDiffPreview("write", context, input);
			assert.notStrictEqual(second, first);
			assert.ok(
				stripAnsi(second.render(100).join("\n")).includes("v2 with more text"),
				"最终一致：屏上落定为最新内容",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
			clearPendingPreviewFileCache();
		}
	} finally {
		t.mock.timers.reset();
	}
});

test("防抖：首帧与慢速流立刻算，无 invalidate 回调也不抛", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	try {
		const dir = fixture({ "base.txt": "base\n" });
		try {
			// 无 invalidate 回调：窗口内返回旧组件，不起定时器，不抛错。
			const input = { expanded: true, displayConfig: getToolDisplayConfig, theme };
			const context: any = { args: { path: "n1.txt", content: "one\n" }, cwd: dir };
			const first = renderPendingDiffPreview("write", context, input);
			assert.ok(first && typeof first.render === "function");
			context.args = { path: "n1.txt", content: "two\n" };
			assert.strictEqual(renderPendingDiffPreview("write", context, input), first);

			// 超窗后立刻重算（行为与防抖前一致）。
			t.mock.timers.tick(PENDING_PREVIEW_DEBOUNCE_MS + 50);
			const second = renderPendingDiffPreview("write", context, input);
			assert.notStrictEqual(second, first);
			assert.ok(stripAnsi(second.render(100).join("\n")).includes("two"));
		} finally {
			rmSync(dir, { recursive: true, force: true });
			clearPendingPreviewFileCache();
		}
	} finally {
		t.mock.timers.reset();
	}
});

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}
