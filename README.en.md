<p align="center">
  <img src="./assets/readme/hero.en.svg" width="100%" alt="pi-cc-extensions: a productivity extension suite for Pi">
</p>

<p align="center">
  <a href="https://pi.dev/packages?name=pi-cc-extensions"><img alt="Pi package catalog" src="https://img.shields.io/badge/Pi-package-58B7FF?style=flat-square"></a>
  <a href="https://www.npmjs.com/package/pi-cc-extensions"><img alt="npm version" src="https://img.shields.io/npm/v/pi-cc-extensions?style=flat-square&color=66E3C4"></a>
  <a href="#compatibility"><img alt="Node.js 22.19 or newer" src="https://img.shields.io/badge/Node.js-%E2%89%A522.19-66E3C4?style=flat-square"></a>
</p>

<p align="center">
  Claude Code-style TUI output with some personal touches and handy utilities.
</p>

<p align="center">
  <a href="./README.md">简体中文</a> · <strong>English</strong>
</p>

---

## Preview

https://github.com/user-attachments/assets/6c858000-fdad-43f9-957f-4d0278648498

## Quick start

```bash
pi install npm:pi-cc-extensions

# GitHub
pi install git:github.com/minuque/pi-cc-extensions
```

Run `/reload` after installation.

## Features

| Feature                     | Description                                                                               | Entry point                                     |
| --------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Claude Code Output          | Tool summaries, expand/collapse, rich edit/write diffs, and`on` / `compact` / `off` modes | `/ccstyle`                                      |
| Markdown enhancements      | Mermaid art, admonitions, URL linking, and more                                           | Automatic                                        |
| Fullscreen mode             | Tool card/group click to expand, double-click to collapse, previews, hover highlight, and a back-to-bottom button | `TUIMODE=fullscreen` or `--tui-mode fullscreen` |
| Settings panel              | `Style / Diff / Thinking / UI / Feature` tabs                                             | `/ccstyle`                                      |
| Context inspection          | Usage breakdown and previews for the system prompt, memory, skills, tools definition, and messages | `/context`                                      |
| Session/Subagent references | Search and inject effective context from previous Sessions or existing SubAgents          | `@`                                             |
| Theme                       | Bundled CC Dark and CC Light themes                                                       | `/theme`                                        |

## Configuration

`/ccstyle` behavior is configured through `~/.pi/agent/claude-code-style.json`:

```js
{
  "mode": "on",                            // on / compact / off
  "excludeRenderers": [],                  // tools keeping the native renderer; Agent always keeps its dedicated renderer

  // diff
  "diffViewMode": "auto",                  // layout: auto / split / unified
  "diffIndicatorMode": "bars",             // change indicators: bars / classic / none
  "diffSplitMinWidth": 120,                // min terminal width for side-by-side columns
  "editDiffCollapsedLines": 24,            // Edit collapse lines; beyond that shows the expand hint
  "writeDiffCollapsedLines": 0,            // write collapse lines; 0 = creation summary only
  "diffWordWrap": true,                    // wrap long diff lines

  // thinking
  "useSummaryTitlesAsThinkingTitle": true, // use latest summary as thinking title
  "previewLines": 3,                       // preview lines; 0 hides
  "animationIntervalMs": 90,               // title animation interval (ms)
  "dimThinkingText": false,                // dim thinking body text

  // ui
  "expandedInputMaxLines": 5,              // expanded tool Input lines; overflow shows a footer hint
  "expandedOutputMaxLines": 10,            // expanded tool Output lines; overflow shows a footer hint
  "expandedPreviewMaxLines": 40,           // max lines for expanded diff/TaskList bodies
  "inputClip": 100,                        // tool summary path/command clip length
  "showStartupHeader": true,               // startup header (logo + tips) toggle
  "scrollStepLines": 3,                    // fullscreen wheel scroll step

  // features
  "enableSessionReference": true,          // @ session references
  "enableSubagentAutocomplete": true,      // @ subagent completion and delegation hints
  "enableContextCommand": true,            // /context usage check
  "enableAgentSummary": true,              // per-turn tool summary
  "enableWorkingMessage": true,            // Working... bottom token/elapsed
  "enableAliases": true                    // /clear, /exit aliases
}
```

> **Fullscreen**: click `click to show more` to expand tool cards, thinking, Skill, and compact summaries. When expanded Input/Output exceeds the line cap, the footer `… +N more lines • click to show more` opens a full preview. Double-click an expanded panel to collapse it.
>
> **Tip**: set `markdown.mermaid` to `final` via `~/.pi/agent/settings.json` or the Mermaid diagrams option in `/settings`. Default `streaming` redraws per frame; `final` renders once at completion.

## Local development

```bash
npm test
npm run typecheck
./test.bat # or pi -e .
```

## Compatibility

- Node.js `>=22.19.0`, Pi `^0.84.0` (loaded through `pi.extensions` and `pi.themes` in the root `package.json`)

## Recommended companions

| Extension                                | Purpose                                                      |
| ---------------------------------------- | ------------------------------------------------------------ |
| `npm:@tintinweb/pi-subagents`            | Parallel SubAgents, background tasks, and worktree isolation |
| `npm:@tintinweb/pi-tasks`                | Claude Code-style task tracking and coordination             |
| `npm:pi-mcp-adapter`                     | On-demand MCP tool discovery with lower context usage        |
| `npm:@ff-labs/pi-fff`                    | FFF-powered fuzzy file and content search (fffind / ffgrep)  |
| `npm:pi-web-access`                      | Web search, URL fetching, GitHub cloning, PDF/video parsing  |
| `npm:@narumitw/pi-usage`                 | Current-account usage for Codex / Copilot / OpenRouter       |
| `git:github.com/DietrichGebert/ponytail` | Lazy-mode coding: forces the simplest working solution       |

## Credits

- Rich diffs are adapted from [`MasuRii/pi-tool-display`](https://github.com/MasuRii/pi-tool-display) (MIT). See [`extensions/renderer/tool/diff/ATTRIBUTION.md`](./extensions/renderer/tool/diff/ATTRIBUTION.md).
