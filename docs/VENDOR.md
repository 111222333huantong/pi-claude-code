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
  上游同步以 merge 方式进行（如 `8f1ac5d merge upstream/main 0d6f162`；
  2026-10-14 merge `upstream/main 281d23f`（v1.0.3），本包升版 1.1.0；
  2026-10-23 merge `upstream/main 6519fad`（v1.0.9）；
  2026-10-29 merge `upstream/main 90957cd`（v1.0.12），本包升版 1.4.0）。
- **Local delta**（fork 后自有部分，持续增长）：状态栏、后续全部改动由本 fork 维护
  （README 已声明）。1.1.0 合并要点见本文件 §8。

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
     代际防抖（只在 `session_start` 领代际，避开 Pi project-trust 预检实例）、
     `_resetTicker` 测试钩子
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
- **Local delta（thinking 呈现）**：活动标题复用 compact 摘要扫光；
  按空行/句末换行/500 字/2 秒空闲切分 reasoning，每块本地提炼一行摘要；
  有 provider 的 `**Section title**` 时优先用标题，否则先过滤元话语/输出规划/短碎片，
  再按动作、结果、路径、决策线索选一行；没有有效内容时不生成条目。
  折叠态保留最近 `thinkingSummaryLimit` 条，展开态显示完整摘要列表。
  对应配置 `thinkingLiveSummary`（默认 on）、`thinkingSummaryLimit`（默认 5）、
  `showRawThinking`（默认 off，调试时展开原文）。
- **Summary streaming 增量优化**：纯摘要函数在
  `extensions/feature/thinking-summary.ts`，按 run 的状态机在
  `extensions/feature/thinking-summary-stream.ts`；provider 标题按新增行扫描，
  动画 tick 只重算标题，不再每帧全量重建 content tree。
  回归基准：`npm run bench:thinking`。

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

## 8. 1.1.0 合并记录（2026-10-14，`upstream/main 281d23f` v1.0.3）

- **基线**：`e43e004`（v0.8.71）→ 上游 154 个提交（1.0.0/1.0.1/1.0.2/1.0.3）
  + 本地 58 个提交，一次 merge 合入，无 rebase。
- **以上游为准**：tool 层拆分（tool-state/tool-io/mcp-title/ask-user-question/
  ccstyle-tool/codemode）、default 补丁拆分、footer 体系（footer*.ts/token-rate/
  git-stats/mcp-chip）、compact 分组折叠树、粘性条/视口修复、show-more-hint
  并入 names.ts（本包 `show-more-hint.ts` + `key-hints.ts` 的旧改已由上游独立实现，
  删模块，`key-hints.ts` 因 panel/working-message 仍用而保留）。
- **本地保留并适配**：statusline（与上游 footer 互斥，见 `extensions/index.ts`）、
  working-message（verb shimmer/耐心阈值/响铃 + 向 token-rate 喂数）、
  compact-thinking Markdown 展开 + tail-window（适配上游 string-key 状态模型）、
  context 健康分级（+上游真实计账/[copy]）、bash live 预览（title 计数 +
  tail 体 + group glance 行）、write 流式头 + 预告片（迁入 ccstyle-tool）、
  P3 三段式标题、 Esc 双件套、image/clipboard 粘贴、/loaded、agent-titles、
  失败分类（failureSummaryText 接入折叠行 + dim）、halted 语义（detail 行；
  title ○ 待后续）、queued 静态点、MCP 人性化（无显式标题时）/真实名（单卡传入时）。
- **改名跟进**：`inputClip` → `toolLabelClip`（normalize 兼容旧键；配置面板/测试同步）；
  配置文件迁 `claude-code-style.json` → `pi-cc-extensions.json`（自动迁移旧文件）。
- **依赖**：`@earendil-works/*` devDeps `^0.85.1` → `^1.2.0`（对齐宿主 Pi；
  peer 保持上游的 `*`）；`jiti` 进 dependencies（上游）；`diff`/`pi-paster` 保留。
- **版本**：`pi-claude-code` 0.10.0 → 1.1.0（上游 1.0.x 基线 + 本 fork 功能）。
- **已知延后**：700ms 最小可读窗口/排队 Waiting 行/head-tail 成功输出截断
  （旧架构特性，新架构下的移植为独立任务）；`tests/tool-visual-state.test.ts`
  已瘦身为失败分类 + gutter/宽度用例；`pending-dot`/`pending-animation-perf`
  呼吸类断言跟随新架构重写。
- **环境注记**：git-stats 系 9 个用例需 git 提交身份（CI/本地无 identity 时红，
  上游同样；`GIT_AUTHOR_*`/`GIT_COMMITTER_*` 置位即绿）。

## 9. 1.3.0 合并记录（2026-10-22，`upstream/main 3c60b72`，v1.0.8+）

- **基线**：`184fa85`（v1.0.4）→ 上游 42 个提交（v1.0.5–v1.0.8 及之后修复）；
  本地 1.2.0 分支一次 merge 合入，无 rebase。
- **以上游为准**：主题 token 重构（`fg/canvas/blueBright/...`，`cc-dark`/`cc-light`
  重写）、`expandedCardBackground` 与 `dimThinkingText` 配置删除（展开卡改按工具
  状态取 `TOOL_CARD_BG_SLOT`）、工具输入统一走 `muted` payload、footer 芯片布局
  默认值（`model/context/cache/rate/cost/pi-usage` + `cwd/git`）、
  `scrollButtonMode`、`enableMarkdownEnhance`、`enableEditorPrefix`、
  compact 成员外置/展开面板跨消息合一、codemode 折叠摘要、mouse/scroll 修复、
  `recordProviderUsage(final)` 与 `message_end` 定格、toolcall_delta 计数。
- **本地保留并适配**：statusline（仍走独立 `statusline.json`，与上游 footer 互斥）、
  启动头/mascot/`/loaded`、working-message verb shimmer + stalled + 响铃、
  compact-thinking tail-window、Esc 双件套、图片/剪贴板粘贴、`/context`、
  `diffPalette=claude`、路径 OSC8（标题路径不着色）、P3 三段式标题、
  bash live 预览、Catppuccin 两套主题（已迁移到上游新 token 结构）。
- **合并适配**：`pathSummary.main` 改为只留标题（路径值交给渲染层截断）；
  ccstyle 标题宽度计算改用实际路径宽度，避免 detail 被行尾硬截断成半截；
  working-message 合并重复的 `tool_execution_start` handler（token 暂停与
  activeTools 计数同处）；主题测试允许 `export` 直接写 hex。
- **合并后修复**：上游 prompt-editor 直接替换编辑器插槽，覆盖 pi-paster 与
  working-row；spinner 被重新嵌回输入框边框，粘贴编辑器也会被顶掉。改为
  editor factory 渲染包装层后，spinner 回到输入框上方，两者共存。
- **版本**：`pi-claude-code` 1.2.0 → 1.3.0（上游 1.0.8+ 基线 + 本 fork 功能）。
- **环境注记**：git-stats 系用例仍需 git 提交身份；`statusline-git-config`
  轮询用例在慢机上放宽了变更等待窗口。

## 10. 1.0.9 合并记录（2026-10-23，`upstream/main 6519fad`）

- **基线**：`3c60b72`（v1.0.8+）→ `6519fad`（v1.0.9），3 个上游提交
  （#81 `/ccstyle` 输入框前缀切换冻结修复、编辑器插槽 reset 后不再写回过期工厂、
  版本号）。
- **以上游为准**：`/ccstyle` 面板打开期间不再替换 editor 插槽；面板关闭后才
  `applyPromptEditor`/`clearPromptEditor`。`releasePromptEditor` 发现 Pi 已把插槽
  重置回占据前工厂时只清状态，不重复写回。
- **本地适配**：fork 的 prompt-editor 渲染包装层保留（不回到上游的直接替换
  `PromptEditor`），否则会再次覆盖 pi-paster/working-row。每次安装创建独立
  factory 并固定其 base，避免再次安装时 `previousEditorFactory` 指向外层 wrapper
  形成递归；`decorateEditor` 加幂等标记，外层再次包装不会叠加 `❯`。
- **测试**：移植上游 `ccstyle-panel-editor-prefix.test.ts` 与 prompt-editor
  reset/重复安装用例；面板导航改为向上回绕到 UI 页最后一项（本 fork 设置项更多）。
- **结果**：`npm run lint`、`npm run typecheck`、`npm test` 全绿（694/694）。

## 11. 1.4.0 合并记录（2026-10-29，`upstream/main 90957cd` v1.0.12）

- **基线**：`6519fad`（v1.0.9）→ `90957cd`（v1.0.12），37 个上游提交。主线：
  子代理完成通知渲染（#77）、`excludeRenderers` 决定 Agent 渲染、会话空闲收尾、
  `/context` 用量数字列贴右、diff 分段高亮与 omission 高亮重置（#90）、
  write 覆盖层交回官方路径解析（WSL `/mnt/<drive>/` 不再落影子树）。
- **以上游为准**：`default-mode` 删除 `DEDICATED_RENDERER_TOOLS`，Agent 是否走
  ccstyle 只看 `excludeRenderers`；分组用 `groupItems` 判断「至少两项」，一个通知
  组件可包含多个 agent；`settleReplayedRound` 更名 `settleIdleRound`（按会话空闲
  收尾，回放/重建后不再停在 Running）；diff 高亮按 omission 分段缓存。
- **本地保留**：frame 弹框（标题嵌框 + health 行）、P3 三段式标题、OSC8 路径、
  spinner/shimmer、statusline、`elapsedMs` 计时（`write-execution` 走官方写路径，
  外层仍包 `noteElapsed()`）、8 位短 `agent_id` 回落（§7 垫片；上游两处按全 ID
  断言的新用例改回短 ID 口径）、`formatTokens` 紧凑口径（`36k`，上游 `35.5k`）。
- **合并适配**：`/context` 沿用 fork 的 `frameHeader`/`frameRow` 几何，把上游右对齐
  数字列折进 `frameRow` 内容预算（`inner - 3` gap、`inner - 2` pad）；4 个上游新
  用例按 frame 几何改写断言（顶边嵌标题、`│ ›` 选中行、`%  │` 收尾）。
- **合并后修复**：`createCodeLineHighlighter` 外层对未注册条目回 `line` 而非 `""`
  ——渲染期物化的 omission 是新对象，否则 `⋮ N lines` 的计数被清空。
- **版本**：`pi-claude-code` 1.3.0 → 1.4.0。
- **结果**：`npm run lint`、`npm run typecheck`、`npm test` 全绿
  （785 例：784 过 / 1 跳过）。

## 待办

- [ ] §2 pin 一个 cc-my-pi 版本（git tag/commit）
- [ ] §4 找到 `pi-compact-thinking` 后继或宣告 FORKED
- [x] §6 上游 pending BOM/换行归一可选抄入（2026-09-16 P2.3 已做：BOM 去除 + CRLF 经
  `splitWriteContentLines` 归一 + `~` 展开 + `realpath` 工作区逃逸检查，见
  `extensions/renderer/tool/diff/pending-preview.ts`）
