# Vendored 第三方台账

本包是拼装型扩展：fork 基座 + 多处移植 + npm 依赖。本文件是唯一真相源。
同步流程：上游有更新时，按条目 `Pinned` 取 diff，只合上游改动，
`Local delta` 原样保留；**没记在这里的差异就是 bug**——要么补记，要么删掉。

考证方式：文件头注释 + `git remote` + GitHub API / npm registry 实测
（2026-09-16）。凡 API 查不到的一律标“未 pin”，不猜。

## 0. Fork 基座

- **Upstream**: <https://github.com/minuque/pi-cc-extensions>（`git remote upstream` 可验证）
- **License**: MIT（见根目录 `LICENSE`：`Copyright (c) 2026 minuque` + fork 续注）
- **关系**：全仓 fork；`origin` = `111222333huantong/pi-claude-code`。
  上游同步以 merge 方式进行（如 `8f1ac5d merge upstream/main 0d6f162`）。
- **Local delta**（fork 后自有部分，持续增长）：状态栏、后续全部改动由本 fork 维护
  （README 已声明）。

## 1. `extensions/renderer/tool/diff/` — rich diff

- **Upstream**: <https://github.com/MasuRii/pi-tool-display>
- **License**: MIT（上游 LICENSE 全文转引自
  `extensions/renderer/tool/diff/ATTRIBUTION.md`）
- **Pinned**: commit `91cef7580078371f8dc49a8607222807ad6a424d`（见 ATTRIBUTION.md）
- **Local delta**（与上游同源 LCS 分叉后各自演进，本包领先侧）：
  1. 折叠态更严的矩阵预算（`MAX_COLLAPSED_...=200_000`，上游只有 4000 行/1M 两档）
  2. 只 highlight/render 显示上限前缀（上游全量算完再截断）
  3. pending 预览 mtime 文件缓存 + `context.state` 指纹缓存（上游即算即用）
  4. `hovered` 进缓存键、`writeCollapsedLimit==0` 的创建摘要行、live 配置
  5. 2026-09：手写 LCS → JsDiff `structuredPatch`（`diff@^9`，见 §5）；
     上游与本包旧版是同一份 LCS，两边都没修，此条上游没有
- **Mutual exclusion**：不要同时装 `pi-tool-display`。撞 `write` 工具名时
  `installWriteOverride` 内 `hasExternalWriteOwner` 检测到非 builtin 来源会让位，
  但同屏双渲染仍属误配置。

## 2. `extensions/feature/shell/` — mascot / Loaded / spinner / quiet-startup

- **Upstream**: <https://github.com/timvdhoorn/cc-my-pi>（`extensions/claude-header/`、
  `extensions/spinner.ts`、`extensions/pi-agent-settings.ts` 等）
- **License**: MIT（各文件头均有 `Ported from cc-my-pi ... (MIT, Tim van den Hoorn)`）
- **Pinned**：未 pin。文件级移植、无整包同步；下次动这些文件时再 pin 当时版本。
- **涉及文件**：`mascot.ts`、`loaded-stats.ts`、`startup-header.ts`、
  `quiet-startup.ts`、`spinner-color.ts`、`spinner-settings.ts`、
  `spinner-shimmer.ts`、`spinner-ticker.ts`、`spinner-verbs.ts`、
  `assistant-paragraphs.ts`（`renderer/`，仅取 DottedParagraph 打点部分）
- **Local delta**：
  1. `startup-header`：布局、去渐变、右侧原生 hints 栏为本包原创（文件头声明）
  2. `assistant-paragraphs`：只搬打点呈现，数学切段/Thinking 段/拷贝链接不搬
     （本包数学走 Pi 原生，thinking 走 compact-thinking 体系）
  3. `spinner-ticker` 上游链条：`ticker.ts` 本身脱胎于 FammasMaz `pi-cc-tools`
     （文件头 `Tim van den Hoorn / FammasMaz`）；本包另加共享 90/16ms 双 ticker、
     代际防抖、`_resetTicker` 测试钩子
  4. 本轮另加（上游没有）：`LAST_TEXT` 语义早已存在于 Loader 补丁；
     `refreshIfIdle` 语义系按其 `refresh-coordinator.ts`（13 行 Semaphore）
     用 20 行无 `effect` 依赖重写，非复制
- **Mutual exclusion**：不要同时装 `npm:pi-claude-code-tui`
 （Phoobobo 原版；mascot 概念源头，见下条）。

## 3. mascot 概念源头（灵感，非代码）

- **Upstream**: <https://github.com/Phoobobo/pi-claude-code-tui>（cc-my-pi 经由此获得灵感，
  本包文件头如实转引 `(MIT, Phoobobo)`）
- **关系**：无代码复制；mascot 逐帧字形为 cc-my-pi 原创（plan 031），本包再移植。
- **Mutual exclusion**：同上条，不与原版同装（都会渲染启动头）。

## 4. `extensions/feature/compact-thinking.ts` — 内联 fork

- **Upstream 注称**: `pi-compact-thinking`，MIT，
  `https://github.com/tifandotme/pi-extensions/tree/master/packages/pi-compact-thinking`
  （见文件头 1–2 行）
- **Pinned**：未 pin——2026-09-16 实测该 monorepo `master` 的 `packages/` 下
  **已无此包名**（现存 `pi-preferred-thinking` 等 13 个，无 `pi-compact-thinking`），
  疑更名或删除。同步前必须先找到对应后继，否则视为 FORKED 不跟进。
- **Local delta**（已大幅改写）：三级 LRU 缓存、`duration` 落盘持久化、
  `patchRegistry` 所有权管理、`CompactThinkingController` 只读查询面
  （供 `renderer/compact-mode` 复用，不建第二套计时器）。

## 5. npm 运行时依赖（非 vendored，但合规相关）

| 包 | 版本 | License | 用途 |
|---|---|---|---|
| `pi-paster` | `^0.2.3` | MIT（`beowulf11/pi-paster`，registry 实测） | 图片粘贴底层；`feature/image-paster.ts` 只是填配置的薄 wrapper |
| `grok-mermaid` | `^0.2.2` | Apache-2.0（`xl0/grok-mermaid`） | markdown mermaid 方言渲染 |
| `diff`（JsDiff） | `^9.0.0` | BSD-3-Clause（`node_modules` 实测） | 2026-09 引入，write overwrite Myers；用法抄 `cc-tools` 30 行 `parseDiff`，非复制 |
| `@shikijs/cli` | `^4.0.2` | MIT（`node_modules` 实测 4.4.1） | diff 代码高亮 |

## 6. 思路参考（无代码复制，只记结论，防后人重复考证）

- `cc-tools`（FammasMaz，<https://github.com/FammasMaz/pi-cc-tools>，API 实测存在）：
  `structuredPatch("", "", old, new, "", "", {context:3})` + 同步 FNV `hashText`
  做缓存键；`xxhash-wasm` 只做行锚 ID，**不要**为缓存引入（异步 WASM 太重）。
- `pi-pretty`（`@heyhuynhgiabuu/pi-pretty@0.6.29`，MIT，registry 实测）：
  `utils/tool-metrics.ts` 移植自其 `src/tools/metrics.ts`，`details` 键名
  （`__prettyElapsedMs`/`__prettyOutputChars`）故意保持一致以便对账。
- `@narumitw/pi-usage`（MIT，registry 实测 0.60.8）：状态栏“按优先级逐段剔除”
  思想（`statusline/render.ts:fitSegments`）。
- `kreeger/pi-statusbar`（MIT，API 实测存在）：状态栏范式参考
  （render 只读快照 + 后台单飞行轮询），无代码复制。
- 上游 `pi-tool-display` 的 `pending-diff-preview.ts` BOM/换行归一更严谨，
  本包未搬（待办，见 §7）。

## 7. 互操作适配（协议兼容，非 vendored）

`tintinweb` 系（`@tintinweb/pi-tasks` 私有 RPC、`agent_id` 17 位）与 `arhen`
系（`@arhen/pi-core-subagent`、`runId` 短 ID）两套 subagent 协议：
`names.ts`、`reference/agent-titles.ts`、`default-mode.ts` 的 Task 标题分支
是本包原创的兼容垫片，不复制对方代码。对方升级协议时只改这三处。

## 待办

- [ ] §2 pin 一个 cc-my-pi 版本（git tag/commit）
- [ ] §4 找到 `pi-compact-thinking` 后继或宣告 FORKED
- [x] §6 上游 pending BOM/换行归一可选抄入（2026-09-16 P2.3 已做：BOM 去除 + CRLF 经
  `splitWriteContentLines` 归一 + `~` 展开 + `realpath` 工作区逃逸检查，见
  `extensions/renderer/tool/diff/pending-preview.ts`）
