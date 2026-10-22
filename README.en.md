<p align="center">
  <a href="https://pi.dev/packages?name=pi-claude-code"><img alt="Pi package catalog" src="https://img.shields.io/badge/Pi-package-58B7FF?style=flat-square"></a>
  <a href="https://www.npmjs.com/package/pi-claude-code"><img alt="npm version" src="https://img.shields.io/npm/v/pi-claude-code?style=flat-square&color=66E3C4"></a>
  <a href="#compatibility"><img alt="Node.js 22.19 or newer" src="https://img.shields.io/badge/Node.js-%E2%89%A522.19-66E3C4?style=flat-square"></a>
</p>

<p align="center">
  Claude Code-style TUI output with some personal touches and handy utilities.
</p>

<p align="center">
  <a href="./README.md">简体中文</a> · <strong>English</strong>
</p>

# pi-cc-extensions

> Claude Code-style TUI output with some personal touches and handy utilities (no extra built-in tools).

## Preview

<a href="https://github.com/user-attachments/assets/6c858000-fdad-43f9-957f-4d0278648498"><img src="./assets/readme/preview.webp" alt="pi-cc-extensions UI preview" width="100%"></a>

Click the cover to play the demo video

## Quick start

```bash
pi install npm:pi-claude-code

# GitHub
pi install git:github.com/111222333huantong/pi-claude-code
```

Run `/reload` after installation.

## Features

| Feature                     | Description                                                                               | Entry point                                     |
| --------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Claude Code UI              | Tool summaries, expand/collapse, rich edit/write diffs, and `on` / `compact` / `off` modes | `/ccstyle`                                      |
| Markdown enhancements       | Mermaid dialects and circled-number conversion                                            | Automatic; turn off with `enableMarkdownEnhance: false` |
| Fullscreen mode             | Tool card/group expand and collapse on click, previews, hover highlight, and a back-to-bottom button | `TUIMODE=fullscreen` or `--tui-mode fullscreen` |
| Settings panel              | `Style / Features / UI / Diff / Thinking / Footer` tabs                                   | `/ccstyle`                                      |
| Context inspection          | Usage breakdown and previews for the system prompt, memory, skills, tools definition, and messages | `/context`                                      |
| Session/Subagent references | Search and inject effective context from previous Sessions or existing SubAgents          | `@`                                             |
| Loaded resources            | Animated mascot header with a Loaded resource panel                                       | `/loaded`                                       |
| Image paster                | Pasted/dropped image paths become first-class attachments with collapsible history previews | Automatic                                     |
| Clipboard paste             | Ctrl+V pastes clipboard images or text (Windows only); images become attachments          | Automatic (Windows)                             |
| Path hyperlinks             | File paths in tool titles become clickable OSC8 links (zero width change)                 | `/ccstyle` Features tab, off by default         |
| Statusline (this fork)      | Two-line footer: model/ctx/cost/mcp/ext + cwd/git, plain text, theme-aware                | `/statusline`                                   |
| Status bar (upstream)       | Shows model, context, cache, cost, and git; also works with `@narumitw/pi-usage` for live quota. Git/cache Nerd Font icons can be turned off | `/ccstyle` (applies when `/statusline` is off)                                      |
| Theme                       | Bundled CC Dark / CC Light / Catppuccin Mocha / Catppuccin Latte themes                   | `/settings` → Theme                             |

> Forked from [`minuque/pi-cc-extensions`](https://github.com/minuque/pi-cc-extensions) (MIT); the statusline and later changes are maintained in this fork.

Renderer snapshots for `on` / `compact` modes: [default](./docs/tool-render-examples-default.md) · [compact](./docs/tool-render-examples-compact.md)

## Configuration

`/ccstyle` behavior is configured through `~/.pi/agent/pi-cc-extensions.json`:

```jsonc
{
  // style
  "mode": "on",                            // on / compact / off
  "excludeRenderers": [],                  // tools keeping the native renderer; Agent always keeps its dedicated renderer

  // features
  "enableSessionReference": true,          // @ session references
  "enableSubagentAutocomplete": true,      // @subagent:[name] completion and delegation hints
  "enableContextCommand": true,            // /context usage check
  "enableAgentSummary": true,              // per-turn tool summary
  "enableWorkingMessage": true,            // Working... bottom token/elapsed
  "enableAliases": true,                   // /clear, /exit aliases
  "enableMarkdownEnhance": true,           // markdown pass: Mermaid dialects and circled-number conversion; false hands it to other extensions
  "enableEditorPrefix": true,              // editor ❯ prefix

  // ui
  "expandedInputMaxLines": 5,              // expanded tool Input lines; overflow shows a footer hint
  "expandedOutputMaxLines": 10,            // expanded tool Output lines; overflow shows a footer hint
  "expandedPreviewMaxLines": 40,           // max lines for expanded TaskList bodies (expanded diffs always show all)
  "toolLabelClip": 0,                      // tool summary path/command clip length; 0 = fit width
  "showStartupHeader": true,               // startup header (logo + tips) toggle
  "stickyUserMessage": true,               // fullscreen: pin a user message's first line once it scrolls off the top edge, until the next one takes over
  "scrollButtonMode": "dock",              // fullscreen: extension dock row / native Pi floating overlay

  // diff
  "diffViewMode": "auto",                  // layout: auto / split / unified
  "diffIndicatorMode": "bars",             // change indicators: bars / classic / none
  "diffPalette": "theme",                 // palette: theme-adaptive; claude = fixed CC red/green, no highlight on removals
  "diffSplitMinWidth": 120,                // min terminal width for side-by-side columns
  "editDiffCollapsedLines": 24,            // edit collapse lines; 0 = change-count summary only
  "writeDiffCollapsedLines": 0,            // write collapse lines; 0 = creation summary only
  "diffWordWrap": true,                    // wrap long diff lines

  // thinking
  "useSummaryTitlesAsThinkingTitle": true, // use latest summary as thinking title
  "previewLines": 3,                       // preview content lines (blanks skipped); 0 hides
  "animationIntervalMs": 90,               // title animation interval (ms)
  "thinkingExpandedMaxLines": 200,         // expanded tail lines first; expand again for full body

  // ui (this fork)
  "showStartupHeader": true,               // startup header (mascot + tips + Loaded) toggle
  "startupAnimation": true,                // play the mascot build-up once per process
  "startupSlogan": "",                     // header slogan (empty hides it)
  "startupSloganColor": "accent",          // slogan color slot: accent / success / warning / error / text / muted
  "quietStartup": true,                    // hide Pi's native startup listing (takes effect next session)
  "scrollStepLines": 3,                    // fullscreen wheel scroll step
  "completionBellAfterSec": 0,             // ring the bell when a turn takes over N seconds, 0 disables
  "liveToolPreview": true,                 // live bash tail preview while running
  "liveToolPreviewLines": 5,               // bash tail preview rows

  // features (this fork)
  "enableImagePaster": true,               // image paster: clipboard/dropped images as attachments
  "enableClipboardPaste": true,            // Ctrl+V clipboard paste (Windows only)
  "enablePathHyperlinks": false,           // OSC8 hyperlinks for file paths in titles (off by default)
  "enableEscSteer": true,                  // empty-draft Esc aborts and auto-continues
  "enableDoubleEscClear": true,            // double Esc clears a non-empty draft

  // footer
  "enableCustomFooter": true,              // upstream footer (fallback when /statusline is off)
  "footerTokenRate": true,                 // output rate chip; false hides it
  "footerTokenRateMode": "average",        // average: whole-prompt avg; live: trailing 1s rate
  "footerTokenRateTtft": true,             // append TTFT to the rate chip; false shows tok/s only
  "footerCurrency": "USD",                 // display currency for the footer cost
  "footerCurrencyRate": null,              // display units per 1 cost unit; null changes the symbol only
  "footerNerdIcons": true,                 // Nerd Font glyphs for git/cache; false = plain text
  "footerGitStatsMode": "working",         // working (default): uncommitted; branch: cumulative net changes
  "footerHiddenKeys": [],                  // hidden chip keys
  "footerLine1Keys": ["model", "context", "cache", "rate", "cost", "pi-usage"], // chip order per line; builtins and plugins share one layout
  "footerLine2Keys": ["cwd", "git"],        // cwd: directory and session; git: branch and changes. Either can move to any line
  "footerLine3Keys": [],                   // painted only when a chip is visible
}
```

This fork's statusline uses its own file, `~/.pi/agent/statusline.json` (toggle with `/statusline`, or the Features tab in `/ccstyle`):

```js
{
  "enabled": true,       // master switch; off falls back to the upstream footer (then Pi native)
  "showWorktree": true   // show wt <name> on line 2
}
```

> [!TIP]
> **Fullscreen**: expanded diffs always show every line. When expanded Input/Output exceeds the line cap, the footer shows `… +N more lines`; click for the full preview, click again to collapse.

> [!NOTE]
> **Mermaid rendering**: set `markdown.mermaid` to `final` via `~/.pi/agent/settings.json` or `/settings`. Default `streaming` redraws every frame; `final` renders once.

## Local development

```bash
./test.sh            # macOS/Linux; needs node and pi
./test.bat           # Windows; runs test.sh through Git Bash
pi -e .              # one run, does not edit settings.json
```

## Compatibility

- Node.js `>=22.19.0`, Pi `^0.84.0`

## Recommended companions

| Extension                                | Purpose                                                      |
| ---------------------------------------- | ------------------------------------------------------------ |
| `npm:@arhen/pi-core-subagent`            | Parallel SubAgents, DAG scheduling, worktree isolation (no bottom-docked panel) |
| `npm:@tintinweb/pi-tasks`                | Claude Code-style task tracking and coordination             |
| `npm:pi-mcp-adapter`                     | On-demand MCP tool discovery with lower context usage        |
| `npm:pi-web-access`                      | Web search, URL fetching, GitHub cloning, PDF/video parsing  |
| `npm:@narumitw/pi-usage`                 | Current-account usage for Codex / Copilot / OpenRouter       |
| `npm:@juicesharp/rpiv-ask-user-question` | Multiple-choice questionnaire the model can ask you          |
| `git:github.com/DietrichGebert/ponytail` | Lazy-mode coding: forces the simplest working solution       |

> **Sharing the screen with `@arhen/pi-core-subagent`**: `subagent` spawns keep their built-in plan-graph rendering (human names, no UUIDs); `subagent_status/result/await/reply/steer/cancel` use this package's tool cards (short `runId` + human `taskId`). Its live widget sits above the editor and `/subagents peek` is on demand — no bottom-docked panel. Note: `@tintinweb/pi-tasks`' `TaskExecute` only speaks tintinweb's private RPC and degrades with arhen (tracking works, dispatch verbally). User-aborted tool waits collapse into a dim `Operation aborted` instead of echoing the raw message.

## Credits

- Rich diffs are adapted from [`MasuRii/pi-tool-display`](https://github.com/MasuRii/pi-tool-display) (MIT). See [`extensions/renderer/tool/diff/ATTRIBUTION.md`](./extensions/renderer/tool/diff/ATTRIBUTION.md).
- The startup mascot and Loaded panel are ported from [`timvdhoorn/cc-my-pi`](https://github.com/timvdhoorn/cc-my-pi) (MIT), inspired by [`Phoobobo/pi-claude-code-tui`](https://github.com/Phoobobo/pi-claude-code-tui) (MIT).

## License

[MIT](./LICENSE) © minuque (fork annotations, see LICENSE)
