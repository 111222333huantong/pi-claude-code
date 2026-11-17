/**
 * Nerd Font 可用性探测：`footerNerdIcons: "auto"` 档的判定。
 *
 * 参照 `has-nerd-font`（sargunv，MIT）的两层探测：
 * 1. `NERD_FONT=1|0` 显式开关（用户自助覆盖）；
 * 2. 终端白名单——内置 Nerd Font Symbols fallback 的终端
 *    （Ghostty / WezTerm / Kitty 打包 symbols-only 字体，iTerm2/Windows
 *    Terminal/VS Code 不带，macOS Terminal.app 不带）。
 *
 * 探测结果进程内缓存；`footerNerdIcons: true/false` 时不走这里。
 */

/** 内置（或默认 fallback 链自带）Nerd Font Symbols 的终端标识。 */
const NERD_FONT_TERMINALS = new Set([
	"ghostty",
	"wezterm",
	"kitty",
	"alacritty", // 社区构建常带 symbols fallback；保守起见仍计入
]);

let cached: boolean | undefined;

/** 终端大概率能渲染 PUA/私有区 nerd 字形；探测失败时回 false（保守）。 */
export function detectNerdFont(env: NodeJS.ProcessEnv = process.env): boolean {
	if (cached !== undefined) return cached;
	const flag = env.NERD_FONT?.trim().toLowerCase();
	if (flag === "1" || flag === "true" || flag === "yes") {
		cached = true;
		return true;
	}
	if (flag === "0" || flag === "false" || flag === "no") {
		cached = false;
		return false;
	}
	const termProgram = (env.TERM_PROGRAM ?? "").toLowerCase();
	const term = (env.TERM ?? "").toLowerCase();
	// Ghostty 的 TERM 值是 xterm-ghostty；WezTerm 常见 WEZTERM_PANE；
	// kitty 有 KITTY_WINDOW_ID。三者任一命中即认为有符号 fallback。
	if (
		env.WEZTERM_PANE !== undefined ||
		env.KITTY_WINDOW_ID !== undefined ||
		termProgram === "ghostty" ||
		term.includes("ghostty") ||
		NERD_FONT_TERMINALS.has(termProgram)
	) {
		cached = true;
		return true;
	}
	cached = false;
	return false;
}

/** 测试用：清缓存，下次重新探测。 */
export function _resetNerdFontCache(): void {
	cached = undefined;
}
