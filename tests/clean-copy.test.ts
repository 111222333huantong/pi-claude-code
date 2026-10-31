import assert from "node:assert/strict";
import test from "node:test";
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { config } from "../extensions/config/config.ts";
import { installCleanCopy } from "../extensions/renderer/mouse/clean-copy.ts";
import { cleanCopiedText } from "../extensions/utils/clean-copy.ts";

test("cleanCopiedText: 工具卡树线前缀被剥掉", () => {
	const text = [
		" █ Bash  Ran 2 commands · 1.2s",
		"   ├  ✓ ls  12 files",
		"   │ src",
		"   └  ✓ grep  api · 4 matches",
		"    ↳ Output",
	].join("\n");
	assert.equal(
		cleanCopiedText(text),
		[
			" █ Bash  Ran 2 commands · 1.2s",
			"✓ ls  12 files",
			"src",
			"✓ grep  api · 4 matches",
			"Output",
		].join("\n"),
	);
});

test("cleanCopiedText: 列 0 的 │ 是 Markdown 引用，保留", () => {
	const text = "│ quoted line\n│ still quoted";
	assert.equal(cleanCopiedText(text), text);
});

test("cleanCopiedText: 代码框只留代码，保留代码缩进", () => {
	const text = ["╭── ts ──╮", "│ function a() { │", "│   return 1; │", "│ } │", "╰────────╯"].join(
		"\n",
	);
	assert.equal(cleanCopiedText(text), ["function a() {", "  return 1;", "}"].join("\n"));
});

test("cleanCopiedText: 只删提示行与提示后缀", () => {
	const text = [
		"result body",
		"… 12 more lines · click to show more",
		"another body · click to show more",
		"   ↳ … 40 more diff lines · click to render all",
		"… (120 earlier lines)",
		"↑ Collapse",
	].join("\n");
	assert.equal(cleanCopiedText(text), ["result body", "another body"].join("\n"));
});

test("cleanCopiedText: diff 标记与普通缩进不动", () => {
	const text = ["- old code", "+ new code", "  context", "    indented content"].join("\n");
	assert.equal(cleanCopiedText(text), text);
});

test("cleanCopiedText: 普通文本原样返回（只裁行尾空白）", () => {
	assert.equal(cleanCopiedText("hello   \n\nworld\t\n"), "hello\n\nworld");
});

test("installCleanCopy: fullscreen 复制走清洗后的文本，可随配置关闭", async () => {
	installCleanCopy();
	const proto = TuiAltScreen.prototype as unknown as {
		copySelectionToClipboard: (this: unknown) => Promise<boolean>;
	};
	const copied: string[] = [];
	const fake = {
		getActiveSelectionText: () => "   ├  ✓ Read  a.ts\n    ↳ done",
		copyTextToClipboard: (text: string) => {
			copied.push(text);
			return Promise.resolve(true);
		},
	};

	const previous = config.cleanCopy;
	try {
		config.cleanCopy = true;
		await proto.copySelectionToClipboard.call(fake);
		assert.deepEqual(copied, ["✓ Read  a.ts\ndone"]);

		config.cleanCopy = false;
		await proto.copySelectionToClipboard.call(fake);
		assert.deepEqual(copied.at(-1), "   ├  ✓ Read  a.ts\n    ↳ done");
	} finally {
		config.cleanCopy = previous;
	}
});
