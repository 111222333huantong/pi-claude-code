import assert from "node:assert/strict";
import test from "node:test";
import {
	capitalizeKey,
	expandShortcutText,
	interruptShortcutText,
	selectCancelShortcutText,
	shortcutText,
} from "../extensions/utils/key-hints.ts";

test("key hints follow official bindings with display normalization", () => {
	assert.equal(expandShortcutText(), "ctrl+o");
	assert.equal(interruptShortcutText(), "esc");
	assert.equal(selectCancelShortcutText(), "esc");
	assert.equal(shortcutText("app.tools.expand", "ctrl+o"), "ctrl+o");
});

test("key hints fall back without a binding context", () => {
	assert.equal(shortcutText("nonexistent.action" as never, "fb"), "fb");
});

test("capitalizeKey keeps sentence case for footers", () => {
	assert.equal(capitalizeKey("esc"), "Esc");
	assert.equal(capitalizeKey("ctrl+o"), "Ctrl+o");
	assert.equal(capitalizeKey(""), "");
});
