import assert from "node:assert/strict";
import test from "node:test";

import { _resetNerdFontCache, detectNerdFont } from "../extensions/utils/nerd-font.ts";

function env(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
	return { ...overrides } as NodeJS.ProcessEnv;
}

test.afterEach(() => _resetNerdFontCache());

test("NERD_FONT env 显式开关覆盖一切探测", () => {
	assert.equal(detectNerdFont(env({ NERD_FONT: "1" })), true);
	_resetNerdFontCache();
	assert.equal(detectNerdFont(env({ NERD_FONT: "true", TERM_PROGRAM: "Apple_Terminal" })), true);
	_resetNerdFontCache();
	assert.equal(detectNerdFont(env({ NERD_FONT: "0", WEZTERM_PANE: "0" })), false);
	_resetNerdFontCache();
	assert.equal(detectNerdFont(env({ NERD_FONT: "no", TERM_PROGRAM: "ghostty" })), false);
});

test("内置 symbols 的终端白名单命中", () => {
	assert.equal(detectNerdFont(env({ TERM_PROGRAM: "ghostty" })), true);
	_resetNerdFontCache();
	assert.equal(detectNerdFont(env({ TERM: "xterm-ghostty" })), true);
	_resetNerdFontCache();
	assert.equal(detectNerdFont(env({ WEZTERM_PANE: "3" })), true);
	_resetNerdFontCache();
	assert.equal(detectNerdFont(env({ KITTY_WINDOW_ID: "1" })), true);
	_resetNerdFontCache();
	assert.equal(detectNerdFont(env({ TERM_PROGRAM: "WezTerm" })), true);
});

test("无 fallback 的终端回 plain（保守默认）", () => {
	assert.equal(
		detectNerdFont(env({ TERM_PROGRAM: "Apple_Terminal", TERM: "xterm-256color" })),
		false,
	);
	_resetNerdFontCache();
	assert.equal(detectNerdFont(env({ TERM_PROGRAM: "vscode", TERM: "xterm-256color" })), false);
	_resetNerdFontCache();
	assert.equal(
		detectNerdFont(env({ TERM_PROGRAM: "Windows Terminal", TERM: "xterm-256color" })),
		false,
	);
	_resetNerdFontCache();
	// 空 env：探测失败保守回 false。
	assert.equal(detectNerdFont(env({})), false);
});

test("进程内缓存：同一进程第二次调用不重探测", () => {
	const e = env({ TERM_PROGRAM: "ghostty" });
	assert.equal(detectNerdFont(e), true);
	// 改 env 后再调，仍命中缓存（模拟同一进程）。
	assert.equal(detectNerdFont(env({ TERM_PROGRAM: "Apple_Terminal" })), true);
	_resetNerdFontCache();
	assert.equal(detectNerdFont(env({ TERM_PROGRAM: "Apple_Terminal" })), false);
});
