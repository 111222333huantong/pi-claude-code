import assert from "node:assert/strict";
import test from "node:test";
import {
	clipboardImageMarker,
	EMPTY_BRACKETED_PASTE,
	findMarkerNumbers,
	isImageFilePath,
	registerClipboardPaste,
	stripMarkers,
} from "../extensions/feature/clipboard-paste.ts";

function makePi() {
	const handlers = new Map<string, Function>();
	let shortcutHandler: Function | undefined;
	const ui = {
		pasted: [] as string[],
		notifies: [] as string[],
		terminalInputs: [] as Function[],
		pasteToEditor(text: string) {
			this.pasted.push(text);
		},
		notify(message: string) {
			this.notifies.push(message);
		},
		onTerminalInput(handler: Function) {
			this.terminalInputs.push(handler);
			return () => {};
		},
	};
	const pi = {
		registerShortcut(_id: string, options: any) {
			shortcutHandler = options.handler;
		},
		on(name: string, handler: Function) {
			handlers.set(name, handler);
		},
	};
	return { pi: pi as any, handlers, ui, getShortcut: () => shortcutHandler };
}

const okImage = () => ({
	ok: true as const,
	image: {
		originalPath: "clipboard.png",
		mimeType: "image/png" as const,
		data: "aGVsbG8=",
		dimensions: undefined,
	},
});
const noImage = () => ({ ok: false as const, reason: "empty" as const });

test("disabled or non-windows: no registration", () => {
	const a = makePi();
	assert.equal(registerClipboardPaste(a.pi, { enabled: false, platform: "win32" }), false);
	assert.equal(a.getShortcut(), undefined);
	const b = makePi();
	assert.equal(registerClipboardPaste(b.pi, { enabled: true, platform: "darwin" }), false);
	assert.equal(b.getShortcut(), undefined);
});

test("isImageFilePath matches image extensions only", () => {
	assert.equal(isImageFilePath("C:\\shots\\a.png"), true);
	assert.equal(isImageFilePath("~/pic/PHOTO.JPG"), true);
	assert.equal(isImageFilePath("notes.txt"), false);
	assert.equal(isImageFilePath("noext"), false);
	assert.equal(isImageFilePath("a.png\nb.png"), false);
});

test("markers are numbered and stripped in occurrence order", () => {
	assert.equal(clipboardImageMarker(1), "[Image 1]");
	const text = `look at ${clipboardImageMarker(2)} and ${clipboardImageMarker(1)} ok`;
	assert.deepEqual(findMarkerNumbers(text), [2, 1]);
	assert.equal(stripMarkers(text), "look at  and  ok");
	assert.deepEqual(findMarkerNumbers("plain text"), []);
});

test("shortcut with clipboard image: marker inserted, input attaches", async () => {
	const { pi, handlers, ui, getShortcut } = makePi();
	const now = 1000;
	const ok = registerClipboardPaste(pi, {
		enabled: true,
		platform: "win32",
		now: () => now,
		readImage: okImage,
		readText: () => undefined,
	});
	assert.equal(ok, true);
	await getShortcut()?.({ hasUI: true, ui });
	assert.ok(ui.pasted.some((t) => t.includes("[Image 1]")));
	const result = await handlers.get("input")?.({
		source: "user",
		text: "check this [Image 1]",
		images: [],
	});
	assert.equal(result.action, "transform");
	assert.equal(result.text, "check this");
	assert.equal(result.images.length, 1);
	assert.equal(result.images[0].mimeType, "image/png");
});

test("shortcut with clipboard text: inserted, no attachment", async () => {
	const { pi, handlers, ui, getShortcut } = makePi();
	registerClipboardPaste(pi, {
		enabled: true,
		platform: "win32",
		now: () => 2000,
		readImage: noImage,
		readText: () => "hello\r\nworld",
	});
	await getShortcut()?.({ hasUI: true, ui });
	assert.ok(ui.pasted.some((t) => t.includes("hello\nworld")));
	const result = await handlers.get("input")?.({
		source: "user",
		text: "hello\nworld",
		images: [],
	});
	assert.equal(result.action, "continue");
});

test("shortcut with empty clipboard: announced once", async () => {
	const { pi, ui, getShortcut } = makePi();
	registerClipboardPaste(pi, {
		enabled: true,
		platform: "win32",
		now: () => 3000,
		readImage: noImage,
		readText: () => undefined,
	});
	await getShortcut()?.({ hasUI: true, ui });
	assert.ok(ui.notifies.some((m) => m.includes("empty")));
});

test("debounce: shortcut + empty-paste within window runs once", async () => {
	const { pi, handlers, ui, getShortcut } = makePi();
	let reads = 0;
	let now = 4000;
	registerClipboardPaste(pi, {
		enabled: true,
		platform: "win32",
		now: () => now,
		readImage: () => {
			reads++;
			return noImage();
		},
		readText: () => "x",
	});
	await handlers.get("session_start")?.({}, { hasUI: true, ui });
	await getShortcut()?.({ hasUI: true, ui });
	now += 100;
	for (const handler of ui.terminalInputs) handler(`abc${EMPTY_BRACKETED_PASTE}def`);
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(reads, 1);
});

test("empty bracketed-paste with image: attaches, no empty warning", async () => {
	const { pi, handlers, ui } = makePi();
	registerClipboardPaste(pi, {
		enabled: true,
		platform: "win32",
		now: () => 5000,
		readImage: okImage,
		readText: () => undefined,
	});
	await handlers.get("session_start")?.({}, { hasUI: true, ui });
	for (const handler of ui.terminalInputs) handler(EMPTY_BRACKETED_PASTE);
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.ok(ui.pasted.some((t) => t.includes("[Image 1]")));
	assert.ok(!ui.notifies.some((m) => m.includes("empty")));
});

test("non-empty terminal input is ignored", async () => {
	const { pi, handlers, ui } = makePi();
	let reads = 0;
	registerClipboardPaste(pi, {
		enabled: true,
		platform: "win32",
		now: () => 6000,
		readImage: () => {
			reads++;
			return noImage();
		},
		readText: () => undefined,
	});
	await handlers.get("session_start")?.({}, { hasUI: true, ui });
	for (const handler of ui.terminalInputs) handler("plain typed text");
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(reads, 0);
	assert.equal(ui.pasted.length, 0);
});

test("two pastes get sequential numbers and both attach", async () => {
	const { pi, handlers, ui, getShortcut } = makePi();
	let now = 8000;
	registerClipboardPaste(pi, {
		enabled: true,
		platform: "win32",
		now: () => now,
		readImage: okImage,
		readText: () => undefined,
	});
	await getShortcut()?.({ hasUI: true, ui });
	now += 1000;
	await getShortcut()?.({ hasUI: true, ui });
	assert.ok(ui.pasted.some((t) => t.includes("[Image 1]")));
	assert.ok(ui.pasted.some((t) => t.includes("[Image 2]")));
	const result = await handlers.get("input")?.({
		source: "user",
		text: "compare [Image 1] vs [Image 2]",
		images: [],
	});
	assert.equal(result.action, "transform");
	assert.equal(result.text, "compare  vs");
	assert.equal(result.images.length, 2);
});

test("input without markers drops stale pending images", async () => {
	const { pi, handlers, ui, getShortcut } = makePi();
	const now = 7000;
	registerClipboardPaste(pi, {
		enabled: true,
		platform: "win32",
		now: () => now,
		readImage: okImage,
		readText: () => undefined,
	});
	await getShortcut()?.({ hasUI: true, ui });
	// User deleted the marker before sending: pending must be discarded.
	const result = await handlers.get("input")?.({
		source: "user",
		text: "no marker here",
		images: [],
	});
	assert.equal(result.action, "continue");
});
