# 上游演进监控笔记 — pi 渲染层动向与本扩展的暴露面

> 第二轮调研产物（2026-11）。重点：pi 正在系统性解决「transcript 全量重排」
> 问题，两个 PR 直接动我们 patch 的组件树与渲染路径；Codex scroll-region
> 路线的终端兼容性教训值得记录备用。

## 一、pi 上游正在落地的两个结构性改动

### 1. PR #11598（已合并方向）：transcript 虚拟化

> entries become build factories；宽度变化不再逐条 remeasure。

- transcript 从「全消息常驻组件树」改为**窗口化容器**——只有视口附近
  条目真正 build 成组件。
- **对我们的影响（押注面最大的一个）**：我们的工具卡 patch、transcript
  gutter、mouse 命中、sticky prompt 全部假设「消息组件在容器树里常驻，
  可以扫树收集」。虚拟化后视口外条目可能根本不存在组件实例：
  - `refreshTrackedComponents` / `trackedAssistantComponents` 的扫树结果
    变成「当前窗口内子集」，切回去时看不到视口外卡片；
  - Ctrl+O 全展开浏览、全局 expand-all 的语义需要重新定义；
  - 分组（grouping）跨工具调用合并的假设可能还成立（同屏内），但跨屏
    分组会断。
- **升级应对**：pi 升到这个版本时，tool-execution / tool-grouping /
  transcript-gutter 三条押注需要整体重估；届时很可能要换策略——不扫
  树而订阅「组件 build 事件」（如果上游暴露）或只作用于窗口内。

### 2. PR #11968（open，2026-11-09）：fullscreen scroll O(viewport)

- 现状：fullscreen `doRender` 每帧 `renderLayoutFrame(root,...)`，
  `LayoutContext.renderCache = new Map()` **每帧新建**（layout.js:285），
  滚动一帧 = 整 transcript 重排。wheel 事件可到 60fps。
- 修复方向：renderCache 跨帧存活 + 滚动只重排视口。
- **对我们的影响**：我们 mouse 层 `tui.currentLayout` 恒等比较
  （`interaction.ts:431,620`、`sticky-prompt.ts:302,326`）依赖「每帧
  layout 是新对象」来让 hover/sticky 缓存失效。11968 若让 layout 部分
  复用，恒等比较会在「内容没变但位置变了」时给出错误的缓存命中。
  落地前需要复查：`state.layout !== tui.currentLayout` 可能不再安全，
  需要换成「layout 版本号 / scrollTop 纳入缓存键」。

## 二、Codex scroll-region（DECSTBM）路线的终端兼容性教训

Codex 的 print-once 进原生 scrollback 依赖 `ESC[top;bot r` + `ESC[kS`
（区域滚动把顶部行"滚"进 scrollback）。已确认的坑：

- **xterm.js（VS Code 终端、Windows Terminal 部分路径）**：区域顶=1 时
  `CSI S`（SU）**直接删行而不是进 scrollback**（xterm.js issue #6010，
  Codex issue #27644——transcript 永久缺口）。LF 触发的滚动正常，
  SU/SD 不正常——实现不一致。
- **缓解**：Codex PR #39619 检测 `WT_SESSION` 用全屏滚动兜底；
  PR #11221 处理 viewport 在顶行时的非法 DECSTBM 区间。
- **对 pi / 对我们的意义**：如果上游走 Codex 同款 print-once 路线
  （#11598 虚拟化是前置），xterm.js 系终端是必须 feature-detect 的
  边界；我们作为扩展将来适配时，`tool-mouse`/`transcript-gutter` 的
  视口坐标系也会因「scrollback 内行不再在组件树」而变。先记录在案。

## 三、resize reflow（Codex 模式）

- Codex `resize_reflow.rs`：resize 清 scrollback 按新宽度**重打全部
  source-backed cells**，75ms debounce，流式期间强制末次 reflow。
- 代价：依赖每个 cell 持有原始 markdown source（`HistoryCell` 设计）。
- 已知坑（issue #37987）：resume 回放或流式中 resize 会让 cell 不完整，
  reflow 后 scrollback 比 transcript 短——**永久性丢行**。缓解是靠
  "源持有"而非"显示缓存"。
- 对照我们：pi 不做 print-once，没有 reflow 问题；但我们的
  `transcript-gutter` 内缩列数和 `collapsedHintHitbox` 的列区间都是按
  当前宽度算的，resize 时靠 pi 的重排自然修正——这条路径没问题。

## 四、difftastic 对我们的启示（暂不可行，记录方向）

difftastic 把 diff 建模为**两棵语法树上的 DAG 最短路**（tree-sitter 解析
→ 简化语法树 → 节点对齐 cost 最小化），能识别「`x` 不变只是括号层深
变了」这类行级 diff 表达不了的语义。

- 我们的 rich diff 是 JsDiff `structuredPatch`（行级）+ 行内词级高亮，
  与 difftastic 的距离是「行级 LCS vs 语法树对齐」。
- **不可行原因**：tree-sitter wasm + 每语言 grammar 的体积与冷启动
  在终端扩展里不划算；且 edit/write 的 diff 场景（agent 改几十行）
  行级已够用。
- **可借鉴的小点**：difftastic 的「unchanged region 折叠 + 变化映射
  右侧 minimap」我们已有对应物（`⋮ N lines` 省略）；可以补的是
  「delimiter 变化单独高亮」——现在行内词级高亮对「只改了缩进/括号」
  的显示不够醒目，可以后续优化高亮权重。

## 五、对押注清单的结论

本轮在 `PATCH_BETS` 里给 `tool-mouse` / `main-screen-do-render` 补了
上游动向注解。**风险排序**：

1. `tool-grouping` + `tool-execution`（#11598 虚拟化直击）
2. `tool-mouse`（#11968 恒等失效语义 + #11598 视口外无组件）
3. `assistant-message`（虚拟化后 updateContent 仍需要，但 markdownSlots
   复用语义可能随窗口化变化）
4. `transcript-gutter`（虚拟化后容器识别方式需要重估）

升级 pi 到含 #11598/#11968 的版本时，以上四条必须实机验证，
不能只跑单元测试（测试 harness 不是窗口化容器）。

## 六、第三轮补充（2026-11 继续调研）

### 1. 「两条抗闪烁规则」实证研究（quidproquo，2026-09）

对四家 coding-agent TUI 的帧级观察得出的不变量：

- **工具从隐藏到结果保持恒定高度**：折叠态一行摘要，展开前绝不从
  0 跳到 N 行（looplane 违反这条，结果被当反例）。
- **绝不自动收起**：expand/collapse 只能是用户主动行为。

**对照我们**：工具 pending 是一行 spinner（`renderRunningCollapsedResult`），
折叠/展开都走 `setExpanded`（用户点击或全局开关）；compact 模式的
`collapseTools` 是「单开制」——用户点开一张时收回同回合其他展开卡，
这是主动互斥（Claude Code 同语义），不算自动收起。**两条规则已对齐**，
记在这里防回归：以后给工具加「自动收起的便利功能」前先想这条。

### 2. Codex `StreamCore`（streaming/controller.rs）

比 stable/tail 更精确的命名：**stable region**（已 commit 进 scrollback
动画队列）+ **tail region**（可变，active-cell 槽位瞬时呈现）。
关键细节：resize 时 tail 重排、streaming 中表格 hold（新行重排列宽）。
我们的 stream-throttle 是「帧合并」，StreamCore 是「空间分区」——
后者才是结构性解，等上游 Markdown stable-commit API 后对齐。

### 3. 排队消息可视化：pi 原生已覆盖

`updatePendingMessagesDisplay` 已渲染 `Steering:`/`Follow-up:` 排队行
+ `↳ Alt+↑ to edit all queued messages` 提示——Claude Code issue #86980
的坑（排队消息在 transcript 里无表现、用户以为丢了）pi 没有。
esc-steer 的「中断后续发排队内容」和这套显示是配套的，不用我们做。

### 4. plan 配额显示（5h/7d 窗口）：不可行

Claude Code statusline 的 `5h 38% / 7d 18%` 依赖 Anthropic API 响应里的
`rate_limits` 私有字段，pi 的 `Usage` 只有 `cost`——provider 不透传
配额窗口。statusline 已显示 `$cost`，quota 窗口等上游/provider 变化。

### 5. 终端图形协议进 agent（kitty/iTerm2）

- hermes PR #21546：CLI 内联图片渲染（kitty + iTerm2 协议检测，
  SSH-aware）。
- `kitty-graphics-agent`（opencode 插件）：把终端 kitty 图截获转成
  模型附件——「CLI 产图直接给模型看」的方向。
- pi-tui 已有 `imageProtocol` / `uploadedKittyImages`（tui-alt-screen），
  宿主在铺路。我们 image-paster 是输入侧，将来若 pi 原生支持渲染侧
  内联图，tool 结果里的图片可直接显示——关注上游。

### 6. 多 agent 可视化前沿（记录方向，暂不实施）

`agent-hub-ui` 泳道（每 agent 一 lane、工具按时长色块）、
`pi-subagents` observability.md 的嵌套状态树、Conflux 的卡片画布。
我们 `agent-summary`/`subagent-notification` 还是单 agent 视角；
pi 生态多 agent 场景普及后再考虑泳道式概览（属大功能，单独立项）。

### 7. markdown 宽表格：横滚优于挤列（已确认 pi 是挤列方案）

Codex PR #12523/#20252 + VectorJet/tui-md：表格超宽时**保持自然列宽、
横向滚动**而非挤压换行——prose 列不被毁掉。

**pi 现状**（pi-tui `Markdown.renderTable`，已读源码）：按
`availableWidth` 给每列分预算换行；`minCellsWidth > availableForCells`
时退 raw markdown（原样输出 `| a | b |`）。prose 列被挤换行是常态，
宽表格场景体验明显差于 Codex 横滚方案。

**行动**：可扩展 `docs/STREAMING-STABLE-TAIL.md` 的 issue 草案，加
「宽表格横滚」为第二个诉求——或观察 Codex PR #22052 落地后用户
反馈再决定。
