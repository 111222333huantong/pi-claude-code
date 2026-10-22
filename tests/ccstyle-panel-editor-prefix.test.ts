import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// 必须在导入 config 之前隔离 agent 目录：updateConfig 会把配置写回磁盘。
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "ccstyle-panel-"));

const { config } = await import("../extensions/config/config.ts");
const { initTheme } = await import("@earendil-works/pi-coding-agent");
const { showCcstylePanel } = await import("../extensions/config/panel.ts");
const { applyPromptEditor, clearPromptEditor } = await import(
	"../extensions/feature/shell/prompt-editor.ts"
);

// 面板构造 SettingsList 时要取主题；测试不渲染，只要求主题已初始化。
initTheme("dark");

type EditorFactory = (tui: unknown, theme: unknown, keybindings: unknown) => unknown;

type Panel = { handleInput(data: string): void };

/**
 * `ui` 复刻 pi 的关键副作用：`setEditorComponent` 会清空 editorContainer 并抢走焦点，
 * 对话框还开着时替换编辑器等于把对话框踢出渲染树，它的 done() 再也不会被调用。
 */
function fakePanelUi() {
	let factory: EditorFactory | undefined;
	let dialogOpen = false;
	let panel: Panel | undefined;
	const swaps: (EditorFactory | undefined)[] = [];
	const notices: string[] = [];

	const custom = (
		build: (tui: unknown, theme: unknown, keybindings: unknown, done: () => void) => Panel,
	) =>
		new Promise<void>((resolve) => {
			const done = () => {
				dialogOpen = false;
				resolve();
			};
			dialogOpen = true;
			panel = build({ requestRender: () => {} }, {}, {}, done);
		});

	const ui = {
		getEditorComponent: () => factory,
		setEditorComponent: (next: EditorFactory | undefined) => {
			assert.equal(
				dialogOpen,
				false,
				"editor slot swapped while the /ccstyle panel was still open",
			);
			factory = next;
			swaps.push(next);
		},
		notify: (message: string) => notices.push(message),
		custom,
	};

	return {
		ctx: { mode: "tui", hasUI: true, ui },
		notices,
		swaps,
		get panel(): Panel {
			assert.ok(panel, "panel was never built");
			return panel;
		},
	};
}

const hooks = { applyStyleMode: () => {}, refreshCurrentTranscript: () => {} };

/** 从 Style 页签走到 UI 页签的 Editor prefix 行。 */
function selectEditorPrefixRow(panel: Panel): void {
	panel.handleInput("\t");
	panel.handleInput("\t");
	for (let i = 0; i < 7; i++) panel.handleInput("\x1b[B");
}

test("toggling Editor prefix keeps the panel alive and swaps the editor after close", async () => {
	const slot = fakePanelUi();
	const { ctx, notices, swaps } = slot;
	config.enableEditorPrefix = false;

	const closePanel = showCcstylePanel(ctx, hooks);
	const panel = slot.panel;
	selectEditorPrefixRow(panel);
	panel.handleInput("\r");

	assert.equal(config.enableEditorPrefix, true);
	assert.deepEqual(swaps, [], "editor must not be swapped while the panel is open");
	assert.ok(notices.includes("Updated enableEditorPrefix: on"));

	panel.handleInput("\x1b");
	await closePanel;

	assert.equal(swaps.length, 1);
	assert.equal(typeof swaps[0], "function");
	assert.equal(ctx.ui.getEditorComponent(), swaps[0]);

	// 再应用一次不许重建编辑器实例。
	applyPromptEditor(ctx as never);
	assert.equal(swaps.length, 1);
	assert.equal(ctx.ui.getEditorComponent(), swaps[0]);
});

test("toggling Editor prefix off restores the editor captured on enable", async () => {
	const otherFactory: EditorFactory = () => ({});
	const slot = fakePanelUi();
	const { ctx, swaps } = slot;

	// 上一段的占用先撤干净。
	config.enableEditorPrefix = false;
	clearPromptEditor(ctx as never);
	assert.equal(ctx.ui.getEditorComponent(), undefined);

	// 别的扩展占着插槽，本扩展开启后再关闭，必须把它原样还回去。
	ctx.ui.setEditorComponent(otherFactory);
	config.enableEditorPrefix = true;
	applyPromptEditor(ctx as never);
	assert.notEqual(ctx.ui.getEditorComponent(), otherFactory);
	swaps.length = 0;

	const closePanel = showCcstylePanel(ctx, hooks);
	const panel = slot.panel;
	selectEditorPrefixRow(panel);
	panel.handleInput("\r");

	assert.equal(config.enableEditorPrefix, false);
	assert.deepEqual(swaps, []);

	panel.handleInput("\x1b");
	await closePanel;

	assert.equal(swaps.length, 1);
	assert.equal(ctx.ui.getEditorComponent(), otherFactory);
});
