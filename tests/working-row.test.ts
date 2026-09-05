import assert from "node:assert/strict";
import test from "node:test";
import {
	installWorkingRow,
	piSupportsEmbeddedWorking,
} from "../extensions/feature/shell/working-row.ts";

function install(ui: any) {
	const events = new Map<string, Function>();
	installWorkingRow({
		on(name: string, handler: Function) {
			events.set(name, handler);
		},
	} as any);
	return { events, ui };
}

test("version gate only enables on Pi >= 0.85", () => {
	assert.equal(piSupportsEmbeddedWorking("0.85.0"), true);
	assert.equal(piSupportsEmbeddedWorking("0.84.1"), false);
	assert.equal(piSupportsEmbeddedWorking("0.84.4"), false);
	assert.equal(piSupportsEmbeddedWorking("1.0.0"), true);
	assert.equal(piSupportsEmbeddedWorking(""), false);
	assert.equal(piSupportsEmbeddedWorking("not-a-version"), false);
});

test("wrapped factory flips embedWorkingStatus off and chains previous", async () => {
	let installed: any;
	const prevEditor = { embedWorkingStatus: true };
	const prevFactory = () => prevEditor;
	const ui = {
		getEditorComponent: () => prevFactory,
		setEditorComponent: (factory: any) => {
			installed = factory;
		},
	};
	const { events } = install(ui);
	await events.get("session_start")?.({}, { hasUI: true, ui });
	assert.ok(installed, "factory installed");
	const produced = installed({}, {}, {});
	assert.equal(produced, prevEditor, "previous factory product reused");
	assert.equal(produced.embedWorkingStatus, false, "embedding disabled");
});

test("editors without the flag are left alone", async () => {
	let installed: any;
	const foreignEditor = { getText: () => "" };
	const ui = {
		getEditorComponent: () => () => foreignEditor,
		setEditorComponent: (factory: any) => {
			installed = factory;
		},
	};
	const { events } = install(ui);
	await events.get("session_start")?.({}, { hasUI: true, ui });
	const produced = installed({}, {}, {});
	assert.equal(produced, foreignEditor);
	assert.equal("embedWorkingStatus" in produced, false);
});

test("session_start is idempotent and headless-safe", async () => {
	let installs = 0;
	const ui = {
		getEditorComponent: () => undefined,
		setEditorComponent: () => {
			installs++;
		},
	};
	const { events } = install(ui);
	const ctx = { hasUI: true, ui };
	await events.get("session_start")?.({}, ctx);
	// Second start sees... (fresh get returns undefined in this stub, so it
	// would reinstall; emulate Pi returning our factory instead.)
	const marked = () => ({});
	(marked as any)[Symbol.for("pi-cc-extensions:working-row-factory")] = true;
	const ui2 = {
		getEditorComponent: () => marked,
		setEditorComponent: () => {
			installs++;
		},
	};
	const second = install(ui2);
	await second.events.get("session_start")?.({}, { hasUI: true, ui: ui2 });
	assert.equal(installs, 1, "already-wrapped factory is not rewrapped");

	// No UI / missing editor APIs → no-op, no throw.
	const third = install({} as any);
	await third.events.get("session_start")?.({}, { hasUI: false }, undefined);
	await third.events.get("session_start")?.({}, { hasUI: true, ui: {} }, undefined);
});
