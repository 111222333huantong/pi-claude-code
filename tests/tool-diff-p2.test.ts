import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { renderWriteDiffResult } from "../extensions/renderer/tool/diff/diff-renderer.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "../extensions/renderer/tool/diff/index.ts";
import {
	clearPendingPreviewFileCache,
	planPendingPreview,
} from "../extensions/renderer/tool/diff/pending-preview.ts";

initTheme("dark");

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

function renderOverwriteExpanded(previousContent: string, content: string, width = 100): string[] {
	return renderWriteDiffResult(
		content,
		{
			expanded: true,
			filePath: "sample.ts",
			previousContent,
			fileExistedBeforeWrite: true,
		},
		{ ...DEFAULT_TOOL_DISPLAY_CONFIG },
		theme,
		"",
	).render(width);
}

const strip = (rows: string[]) => rows.map(stripVTControlCharacters).join("\n");

test("write hunks separated by gap rows with hidden line counts", () => {
	const oldLines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
	const newLines = [...oldLines];
	newLines[1] = "CHANGED-2";
	newLines[27] = "CHANGED-28";
	const text = strip(renderOverwriteExpanded(oldLines.join("\n"), newLines.join("\n")));
	assert.match(text, /CHANGED-2/);
	assert.match(text, /CHANGED-28/);
	assert.match(text, /⋮[^\n]*\d+ lines/, "gap row shows how many lines are hidden");
	assert.doesNotMatch(text, /line 15/);
});

test("adjacent hunks render without a gap row", () => {
	const text = strip(renderOverwriteExpanded("a\nb\nc", "a\nB\nc"));
	assert.match(text, /B/);
	assert.doesNotMatch(text, /lines/);
});

test("overwrite guard keeps exact add/remove stats when cheap", () => {
	const previous = Array.from({ length: 4001 }, (_, i) => `line ${i}`);
	const next = [...previous];
	next[0] = "CHANGED";
	const text = strip(
		renderWriteDiffResult(
			next.join("\n"),
			{
				expanded: true,
				filePath: "big.ts",
				previousContent: previous.join("\n"),
				fileExistedBeforeWrite: true,
			},
			{ ...DEFAULT_TOOL_DISPLAY_CONFIG },
			theme,
			"",
		).render(120),
	);
	assert.match(text, /overwrite diff omitted/);
	assert.match(text, /\+1 -1/, "exact stats survive the fuse");
	assert.match(text, /4001 → 4001 lines/);
});

test("pending preview rejects workspace escapes but allows inside paths", () => {
	const dir = mkdtempSync(join(tmpdir(), "p2-escape-"));
	try {
		const inside = join(dir, "a.txt");
		writeFileSync(inside, "hello\n");
		const ok = planPendingPreview("edit", { path: "a.txt", edits: [] }, dir);
		assert.ok(!("reason" in ok) || (ok as any).reason !== "path escapes workspace");
		// absolute outside path is rejected
		const outside = planPendingPreview(
			"edit",
			{ path: join(tmpdir(), "nope.txt"), edits: [] },
			dir,
		);
		assert.ok("reason" in outside);
		assert.equal((outside as any).reason, "path escapes workspace");
		// missing relative path still reports file-not-found, not escape
		const missing = planPendingPreview("write", { path: "new.txt", content: "hi\n" }, dir);
		assert.ok(!("reason" in missing));
	} finally {
		clearPendingPreviewFileCache();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("pending preview resolves symlinks against their real location", () => {
	if (process.platform === "win32") return; // symlink privilege varies on Windows CI
	const dir = mkdtempSync(join(tmpdir(), "p2-link-"));
	const outside = mkdtempSync(join(tmpdir(), "p2-outside-"));
	try {
		const secret = join(outside, "secret.txt");
		writeFileSync(secret, "secret\n");
		const link = join(dir, "link.txt");
		symlinkSync(secret, link);
		const plan = planPendingPreview("edit", { path: "link.txt", edits: [] }, dir);
		assert.ok("reason" in plan);
		assert.equal((plan as any).reason, "path escapes workspace");
	} finally {
		clearPendingPreviewFileCache();
		rmSync(dir, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
});

test("pending preview strips BOM so the first line diffs clean", () => {
	const dir = mkdtempSync(join(tmpdir(), "p2-bom-"));
	try {
		writeFileSync(join(dir, "bom.txt"), `${String.fromCharCode(0xfeff)}hello\n`);
		mkdirSync(join(dir, "sub"), { recursive: true });
		// read back through the preview pipeline via an edit projection
		const plan = planPendingPreview(
			"edit",
			{ path: "bom.txt", edits: [{ oldText: "hello\n", newText: "world\n" }] },
			dir,
		);
		assert.ok(!("reason" in plan), `unexpected reason: ${JSON.stringify(plan)}`);
		if (!("reason" in plan)) {
			assert.equal(plan.previousContent, "hello\n");
			assert.equal(plan.newContent, "world\n");
		}
	} finally {
		clearPendingPreviewFileCache();
		rmSync(dir, { recursive: true, force: true });
	}
});
