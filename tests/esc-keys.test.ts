import assert from "node:assert/strict";
import test from "node:test";
import { config } from "../extensions/config/config.ts";
import {
	DOUBLE_ESC_MS,
	isClearableDraft,
	registerDoubleEscClear,
} from "../extensions/feature/double-esc-clear.ts";
import { registerEscSteer } from "../extensions/feature/esc-steer.ts";

const ESC = String.fromCharCode(27);

function withNow<T>(now: number, fn: () => T): T {
	const realNow = Date.now;
	Date.now = () => now;
	try {
		return fn();
	} finally {
		Date.now = realNow;
	}
}

type HandleCall = { data: string };

function makeHarness() {
	const handlers = new Map<string, Array<(event: any, ctx: any) => void>>();
	const pi = {
		on(name: string, handler: (event: any, ctx: any) => void) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerCommand() {},
	} as any;
	const emit = (name: string, event: any, ctx: any) => {
		for (const handler of handlers.get(name) ?? []) handler(event, ctx);
	};
	return { pi, emit };
}

/** Fake base editor behind a pre-installed factory (never touches real CustomEditor). */
function makeBase(text: string, opts: { autocomplete?: boolean } = {}) {
	const calls: HandleCall[] = [];
	let current = text;
	return {
		calls,
		getText: () => current,
		editor: {
			getText: () => current,
			setText: (next: string) => {
				current = next;
			},
			isShowingAutocomplete: () => opts.autocomplete ?? false,
			handleInput: (data: string) => {
				calls.push({ data });
			},
		},
	};
}

const testKeybindings = {
	matches: (data: string, action: string) => {
		if (action === "app.interrupt") return data === ESC;
		if (action === "tui.input.submit") return data === "\r";
		return false;
	},
};

function makeCtx(opts: { idle: boolean; mode?: string } = { idle: true }) {
	let factory: any;
	const widgets = new Map<string, { factory: unknown; options: unknown }>();
	const state = { idle: opts.idle };
	const ctx: any = {
		mode: opts.mode ?? "tui",
		hasUI: true,
		isIdle: () => state.idle,
		setIdle: (value: boolean) => {
			state.idle = value;
		},
		ui: {
			getEditorComponent: () => factory,
			setEditorComponent: (next: any) => {
				factory = next;
			},
			setWidget: (key: string, wf: unknown, options?: unknown) => {
				if (wf === undefined) widgets.delete(key);
				else widgets.set(key, { factory: wf, options });
			},
			notify: () => {},
		},
	};
	return { ctx, widgets, buildEditor: () => factory({}, {}, testKeybindings) };
}

test("isClearableDraft owns plain drafts only", () => {
	assert.equal(isClearableDraft("hello world"), true);
	assert.equal(isClearableDraft(""), false);
	assert.equal(isClearableDraft("   "), false);
	assert.equal(isClearableDraft("!npm test"), false);
	assert.equal(isClearableDraft("  !ls"), false);
	assert.equal(DOUBLE_ESC_MS, 2000);
});

test("esc-steer arms on empty-draft Esc while busy and submits on settle", async () => {
	const previous = config.enableEscSteer;
	config.enableEscSteer = true;
	const { pi, emit } = makeHarness();
	registerEscSteer(pi);
	const { ctx } = makeCtx({ idle: false });
	const base = makeBase("");
	(ctx.ui as any).setEditorComponent(() => base.editor);
	try {
		emit("session_start", {}, ctx);
		const editor = (ctx.ui as any).getEditorComponent()({}, {}, testKeybindings);
		editor.handleInput(ESC);
		assert.deepEqual(base.calls, [{ data: ESC }], "interrupt passes through");
		(ctx as any).setIdle(true);
		emit("agent_settled", {}, ctx);
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.ok(
			base.calls.some((call: HandleCall) => call.data === "\r"),
			"empty submit injected after settle",
		);
	} finally {
		config.enableEscSteer = previous;
		emit("session_shutdown", {}, ctx);
	}
});

test("esc-steer never arms on a typed draft", async () => {
	const previous = config.enableEscSteer;
	config.enableEscSteer = true;
	const { pi, emit } = makeHarness();
	registerEscSteer(pi);
	const { ctx } = makeCtx({ idle: false });
	const base = makeBase("do not submit me");
	(ctx.ui as any).setEditorComponent(() => base.editor);
	try {
		emit("session_start", {}, ctx);
		const editor = (ctx.ui as any).getEditorComponent()({}, {}, testKeybindings);
		editor.handleInput(ESC);
		assert.deepEqual(base.calls, [{ data: ESC }], "typed Esc passes through once");
		(ctx as any).setIdle(true);
		emit("agent_settled", {}, ctx);
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.deepEqual(base.calls, [{ data: ESC }], "typed draft never auto-submits");
	} finally {
		config.enableEscSteer = previous;
		emit("session_shutdown", {}, ctx);
	}
});

test("esc-steer stays off when disabled", async () => {
	const previous = config.enableEscSteer;
	config.enableEscSteer = false;
	const { pi, emit } = makeHarness();
	registerEscSteer(pi);
	const { ctx } = makeCtx({ idle: false });
	const base = makeBase("");
	(ctx.ui as any).setEditorComponent(() => base.editor);
	try {
		emit("session_start", {}, ctx);
		const editor = (ctx.ui as any).getEditorComponent()({}, {}, testKeybindings);
		editor.handleInput(ESC);
		(ctx as any).setIdle(true);
		emit("agent_settled", {}, ctx);
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.deepEqual(base.calls, [{ data: ESC }], "disabled: no submit injected");
	} finally {
		config.enableEscSteer = previous;
		emit("session_shutdown", {}, ctx);
	}
});

test("double-esc hints then clears a plain draft", () => {
	const previous = config.enableDoubleEscClear;
	config.enableDoubleEscClear = true;
	const { pi, emit } = makeHarness();
	registerDoubleEscClear(pi);
	const { ctx, widgets } = makeCtx({ idle: true });
	const base = makeBase("draft to clear");
	(ctx.ui as any).setEditorComponent(() => base.editor);
	try {
		emit("session_start", {}, ctx);
		const editor = (ctx.ui as any).getEditorComponent()({}, {}, testKeybindings);
		const t0 = 1_000_000;
		withNow(t0, () => editor.handleInput(ESC));
		assert.ok(widgets.has("ccstyle-double-esc-hint"), "hint shown after first Esc");
		assert.equal(base.getText(), "draft to clear", "first Esc never clears");
		assert.deepEqual(base.calls, [{ data: ESC }], "idle first Esc falls through to app handlers");
		withNow(t0 + 500, () => editor.handleInput(ESC));
		assert.equal(base.getText(), "", "second Esc inside the window clears");
		assert.ok(!widgets.has("ccstyle-double-esc-hint"), "hint hidden after clear");
		assert.deepEqual(base.calls, [{ data: ESC }], "clear never falls through");
	} finally {
		config.enableDoubleEscClear = previous;
		emit("session_shutdown", {}, ctx);
	}
});

test("double-esc window expiry re-arms instead of clearing", () => {
	const previous = config.enableDoubleEscClear;
	config.enableDoubleEscClear = true;
	const { pi, emit } = makeHarness();
	registerDoubleEscClear(pi);
	const { ctx, widgets } = makeCtx({ idle: true });
	const base = makeBase("keep me");
	(ctx.ui as any).setEditorComponent(() => base.editor);
	try {
		emit("session_start", {}, ctx);
		const editor = (ctx.ui as any).getEditorComponent()({}, {}, testKeybindings);
		const t0 = 2_000_000;
		withNow(t0, () => editor.handleInput(ESC));
		withNow(t0 + DOUBLE_ESC_MS + 100, () => editor.handleInput(ESC));
		assert.equal(base.getText(), "keep me", "late second Esc does not clear");
		assert.ok(widgets.has("ccstyle-double-esc-hint"), "hint re-armed");
	} finally {
		config.enableDoubleEscClear = previous;
		emit("session_shutdown", {}, ctx);
	}
});

test("double-esc swallows busy Esc and spares bang drafts", () => {
	const previous = config.enableDoubleEscClear;
	config.enableDoubleEscClear = true;
	const { pi, emit } = makeHarness();
	registerDoubleEscClear(pi);
	const { ctx } = makeCtx({ idle: false });
	try {
		emit("session_start", {}, ctx);
		const buildEditor = () => (ctx.ui as any).getEditorComponent()({}, {}, testKeybindings);
		const busy = makeBase("busy draft");
		(ctx.ui as any).setEditorComponent(() => busy.editor);
		emit("session_start", {}, ctx);
		const busyEditor = buildEditor();
		withNow(3_000_000, () => busyEditor.handleInput(ESC));
		assert.deepEqual(busy.calls, [], "busy Esc swallowed to protect the turn");
		const bang = makeBase("!npm test");
		(ctx.ui as any).setEditorComponent(() => bang.editor);
		emit("session_start", {}, ctx);
		const bangEditor = buildEditor();
		withNow(3_000_000, () => bangEditor.handleInput(ESC));
		withNow(3_000_100, () => bangEditor.handleInput(ESC));
		assert.equal(bang.getText(), "!npm test", "bang drafts never cleared");
		assert.deepEqual(bang.calls, [{ data: ESC }, { data: ESC }], "bang Esc always falls through");
		const empty = makeBase("   ");
		(ctx.ui as any).setEditorComponent(() => empty.editor);
		emit("session_start", {}, ctx);
		const emptyEditor = buildEditor();
		emptyEditor.handleInput(ESC);
		assert.deepEqual(empty.calls, [{ data: ESC }], "empty drafts pass through");
	} finally {
		config.enableDoubleEscClear = previous;
		emit("session_shutdown", {}, ctx);
	}
});

test("esc features skip non-tui contexts", () => {
	const { pi, emit } = makeHarness();
	registerEscSteer(pi);
	registerDoubleEscClear(pi);
	const { ctx } = makeCtx({ idle: true, mode: "print" });
	emit("session_start", {}, ctx);
	assert.equal((ctx.ui as any).getEditorComponent(), undefined, "no editor wrapping outside tui");
	emit("session_shutdown", {}, ctx);
});
