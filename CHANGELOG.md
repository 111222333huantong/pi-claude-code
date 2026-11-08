# Changelog

本文件记录本 fork（`pi-claude-code`）的对外变化。上游合并记录见
[`docs/VENDOR.md`](./docs/VENDOR.md)。

## Unreleased

### 修复

- bash live 尾预览在输出超过 16KB 后不再停住：`textFromResult` 的 16KB 上限取的是
  头部，而 Pi 的 bash 结果本身已是「最后 2000 行 / 50KB」，旧实现会再截成前 16KB，
  后续新输出永远不出现。现在 live 预览、运行中展开视图和落定后的 shell 结果行都
  改取尾部（`tailTextFromResult`）；展开态放宽到 49KB，`show more` 能翻到保留窗口
  的末尾。
- bash 标题里的 `· N lines` 与 `… (N earlier lines)` 改用 Pi
  `details.truncation.totalLines` 的真实总行数；此前只看 16KB 窗口，长命令会少报。

### 兼容与打包

- 开发基线升到 Pi 1.5.0（`@earendil-works/pi-ai` / `pi-coding-agent` /
  `pi-tui`）：完整 `npm run ci` 与热路径基准通过。1.5 的流式渲染优化与本包
  `streamThrottleMs` 并存，基准里 40 帧长回复仍是 `~244ms`（不节流）对
  `~48ms`（默认 10fps），节流继续有效。1.5 起扩展自行注册的工具参数走
  pi-schema 校验；本包只复用官方 `write` definition，不受 TypeBox 收窄影响。
- `@shikijs/cli` 4.5.0 → 4.6.0（`@shikijs/cli` 与 `shiki` 同步升级）。
- `files` 纳入 `CHANGELOG.md`：Pi 1.5 起会读取包根 changelog，在升级后的
  “Extension Updates”里展示更新说明。此前 tarball 不含该文件，提示永远为空。
- 新增 `tests/package-manifest.test.ts`：校验 `pi.extensions` / `pi.themes`
  指向的文件存在、`themes/` 与清单一一对应、extension 内的相对导入不会跑出
  `extensions/`（跑出去的文件不会进 tarball）。
- CI 增加 `npm run bench:check`（`continue-on-error`，仅报告）：热路径基准
  相对 1.8x 容差回退时会留下明显日志，但不阻断发布。

## 1.6.0 — 2026-11-07

### 上游合并（v1.0.16）

- 合并 `upstream/main 5e3ef6b`（v1.0.13 → v1.0.16，38 个提交）：
  - footer 新增会话累计 token 芯片 `footerSessionTokens`（默认关，`Σ 402k`）。
  - 新增 CC Dark HC / CC Light HC 两套高对比主题。
  - 运行中的工具卡可展开查看完整 Input / Output；折叠行保留行尾 `click to show more`
    与已用时间。
  - compact 回合收尾等到消息流式结束、工具真正跑完；同一条消息先正文后 toolCall
    不再拆成两条摘要行；已收尾回合的外露 edit/write/ask 行排到摘要行之下。
  - 工具组子卡首行只剩状态图标时不再多出空行。
  - 展开工具卡贴底点击时保持跟随视口，不再把新内容推出屏幕。
  - 写前快照期间 abort 会阻止落盘并抛错，不留下错误的快照。
  - Agent 回合摘要改为组件自渲染，数字语义色不再被 Markdown 剥掉。
  - 思考完成态可单独设置 `completedPreviewLines`（`follow` = 跟随 `previewLines`）。
- 本地适配：`completedPreviewLines` 同时作用于文档模式折叠正文；fork 的
  pending diff 预告片、bash live 尾预览、耗时与短 `agent_id` 口径保持不变。

### 新增

- 流式正文节流：新增 `streamThrottleMs`（默认 `100`，约 10fps）。Pi 1.x 每个
  `message_update` 都会清空内容容器并重建整段 Markdown，长回复会持续吃 CPU；
  现在只合并流式中间帧，`message_end` 的最终帧始终立即渲染。
  `0` 恢复逐 token 重绘。`/ccstyle` → UI 页 `Stream throttle` 可调。
- 状态栏 run 计时改用 `agent_start` → `agent_settled`：`turn_end` / `agent_end`
  不再停表，自动重试、恢复、排队续跑期间显示的是整段 run 的耗时。
- 回合摘要与 compact 收尾改用 `agent_settled`：重试/续跑期间不再提前出摘要或
  把还要继续的回合标成已结束；摘要统计按 `before_agent_start` 重置，重试产生的
  多个 `agent_end` usage 会累加后只输出一次。
- 新增 `/ccstyle diag`：一次列出扩展/Pi/Node 版本、`updateContent` 补丁链顺序、
  各补丁槽位、本会话 compat 漂移、footer 归属与主配置/状态栏配置路径。
  文本走可滚动的预览面板，方便直接复制反馈。
- 在状态栏开启时于 `/ccstyle` 打开 `Custom footer` 会提示冲突：本次会话上游
  footer 会覆盖 `/statusline`，下次启动又会被状态栏接管。
- compact golden 从 3 条扩到 9 条：进行中 / 已结束 / 展开，覆盖单工具、多工具、
  失败、窄屏与超长输出；拆 `compact-mode.ts` 前先补齐这类整屏安全网。
- 拆分 `compact-mode.ts`（2606 → 1682 行）：摘要/状态文本 → `compact-summary.ts`，
  卡片绘制与展开提示裁剪 → `compact-card.ts`，edit/write rich diff 行 →
  `compact-tool-lines.ts`，live 槽位与状态行 → `compact-live.ts`。主文件只保留
  补丁安装与回合状态机；对外导出路径保持不变。
- 手动 npm 安装可用 `--omit=optional` 跳过 `pi-paster` 的可选 `sharp` 依赖。
- `editDiffCollapsedLines` 支持 `"auto"` 并成为新默认：增删合计 ≤16 行的 edit
  整段展开，超过则收成 `↳ diff +A -D · click to show more` 一行摘要。
  数字配置继续可用（`0` 仍为仅摘要），write 的 `0` 行默认不变。
- thinking 改为文档模式：折叠默认只显示状态行（`✻ Thought for 12s · Section`，
  元信息内联；OpenCode 式，不再显示 `N steps` 或正文预览）；展开直接渲染完整
  reasoning 文档，保留 provider 的 `**Section title**`、段落、列表和代码块，
  不再把摘要列表当成展开内容。`thinkingLiveSummary: false` 可回退旧版 raw preview；
  `thinkingSummaryLimit` 默认从 5 改为 0（0 = 仅状态行；>0 = 预览最新 N 行原文）。
  展开态去掉 `toolSuccessBg` 卡片底色，
  改为淡色左侧竖线（`│`，与工具卡树线同列，正文与工具卡标题同列）；
  状态词/当前小节/正文/竖线分别使用 text / muted / muted / dim，
  与工具卡的标题/正文/树线层级一致，不再整块斜体。
  展开态使用同一条淡竖线；折叠态只有状态行，hover 时状态行末尾追加并提亮
  `expand` / `collapse`。
  活动态不再对状态词做文字扫光，改用 OpenCode 同款 braille 蛇形点
  （`⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏`，90ms 一帧）；下方 working spinner 保留自己的
  星形 glyph + 动词扫光。两者字形不同、各自动画，不再像两个重复的星形 spinner。
  compact 回合只有 thinking/文本、没有工具时，外卡底色改用中性 `toolPendingBg`，
  不再把工具成功绿套在思考上。新增 `thinking-document.ts` 与解析/渲染 golden。
- thinking 标题判定更保守：`**Bold**` 只有在文档开头、空行/围栏之后，且后面是
  空行或文档结束时才切成 section；段落中间的强调行、`**Lead**\n正文` 不再误判。
  ATX 标题保持原规则。
- 文档模式展开可选用尾部窗口：`thinkingDocumentMaxLines`（默认 `0` = 全文，
  `/ccstyle` → Thinking 页可调）。超过上限时顶部显示
  `… N earlier lines hidden`，与旧版 raw preview 的提示一致。
- 展开文档遇到引用式链接定义（`[label]: url`）时回退整篇渲染，避免逐 section
  渲染导致跨小节引用失效；围栏内的定义不触发。
- 纯文本折行改为按字素簇切分（`Intl.Segmenter`），emoji ZWJ、组合音标不会被
  拆到两行；CJK 避头尾规则不变。
- 流式节流升级为两档：正常按 `streamThrottleMs` 合并；积压超过 8 帧时进入
  250ms 的 catch-up 立即 drain，再回到正常间隔（Codex Smooth/CatchUp 的简化版）。
  最终帧仍无条件直通。

### 修复

- fullscreen 选区复制会把 thinking 文档的左竖线 `│`、旧版状态行里的 `N steps` /
  `expand` / `collapse` 以及 `… N earlier lines hidden` 提示一起复制走。现在按树线规则
  剥掉竖线，并过滤 thinking 专属的内联状态与尾部窗口提示，只保留正文。

### 性能

- 新增流式渲染基准（60fps 合成时钟，40 次 update / 约 5.6 万字符）：
  latin 297ms → 54ms（5.5×），cjk 140ms → 26ms（5.4×）。`bench:hot` 与
  `bench-baseline.json` 已包含该指标。
- `bench:hot` 把流式指标拆成 `updateContent` / `render` 两段：内容不变的重复
  render 仅约 0.44ms/帧，剩余成本集中在内容变化后的 Markdown 解析。CPU profile
  显示热点为 marked 的 `RegExp`/`inlineTokens` 与 LaTeX 块探测正则，属于 Pi 内部
  解析路径，暂不做本地缓存/增量改造，避免负收益。
- thinking 文档新增增量构建器：追加时只重解析最后一个 section，前面的索引直接复用。
  `bench:thinking` 实测 2000 sections / 310 KiB / 约 5000 次更新：逐帧全量解析
  约 5166ms → 257ms（约 20×）；展开态 Markdown 也按 section 缓存，流式时只重渲染
  正在增长的最后一段。
- 展开文档新增 section 级渲染缓存（按 section 对象身份 + 宽度 + 主题），
  流式展开只重建正在增长的最后一段；渲染结果连 padding 一起缓存，避免每帧
  对整篇文档重跑 `visibleWidth`。`bench:thinking` 的 120 帧流式渲染：
  2000 sections / 310 KiB 展开约 50ms、折叠约 15ms（改动前同一基准展开约 7.1s）。
  重结构文档（列表 + 围栏代码，501 KiB / 22k 行）首次展开约 60ms，
  去掉展开态逐行右填充后约为改动前（166ms）的三分之一。
  `thinkingDocumentSectionCount` 改用解析期算好的 `hasBody`，不再每次渲染
  slice + trim 全文。折叠摘要默认只取 1 行，无围栏时从尾部反向扫描，
  不再把整段长 reasoning split 成所有行；479 KiB / 8000 行实测约 0.016ms/次。
  增量构建器也不再原地修改已返回的 sections 数组，旧文档快照保持稳定。
- 展开文档新增稳定前缀行缓存：按 `messageTimestamp:runStartIndex` 保存已渲染行与
  section 起始位置，下一帧只截断并重建最后增长的 section，不再每帧把 22k+ 行
  重新 push 成新数组；宽度/主题/内边距变化才整篇重建，缓存上限 4 份、约 8 MiB。
- 旧的整篇展开 Markdown 缓存（legacy raw preview）增加 4 MiB 字符预算，避免多份
  大文档长期驻留；文档模式不再经过这层缓存。

## 1.5.0 — 2026-11-01

### 新增

- 新增 `extensions/compat/pi-internals.ts`：把 `ToolExecutionComponent` /
  `AssistantMessageComponent` / `Markdown` / `Container` 原型、`contentBox`、
  `previousViewportTop`、`previousLines`、终端尺寸收进单点适配。Pi 升级后内部
  接口缺失时，对应补丁自动放弃并回退原生渲染，不再半装；`session_start` 后
  以 warning toast 提示一次缺失项。
- CI 新增 `peer-latest` job：每次推送都用 npm 上最新的 `@earendil-works/pi-*`
  跑 typecheck + 全量测试，提前发现上游漂移。
- 新增性能门禁 `npm run bench:check`：基准结果按同机 `calib: measureWidth`
  归一化后与 `scripts/bench-baseline.json` 比较（默认 1.8x、0.3ms 噪声豁免），
  CI `perf` job 强制执行；`npm run bench:update` 重写基线。
- 新增落盘布局快照 `tests/golden/`（20 个场景）：diff 宽度梯度 40/80/120、
  unified/split、折叠/展开，工具卡成功/失败/展开，工具组折叠/展开，状态栏
  全量/窄屏/运行中。输入固定时钟、主题与虚拟 cwd；`npm run test:golden`
  比对，`test:golden:update` 更新。拆文件或调间距时能直接看到整屏 diff。
- 工具组头部在全部结算后报**总耗时**（各工具 `durationMs` 之和，`≥1s` 才显示）：
  `● Multiple Tools: 3 done · 2.4s · Read×2, Bash×1 · click to show more`。
- 组内折叠行报产出体积：`Read a.ts · 12 lines`、`Grep "TODO" · 3 matches`、
  `Find "*.ts" · 2 files`、`Ls . · 4 entries`；空结果用 `no matches` / `no files` /
  `empty` 短语。只对内置 read/grep/find/ls 生效，MCP 与扩展工具不猜口径。
  结果末尾的 `[N entries limit reached...]` / `[50.0KB limit reached]` 通知块不计入；
  grep 的 context 模式只数 `path:N:` 匹配行。
- `/context` 在用量副标题下增加缓存命中行：`cache 84% hit · 120k read · 8k write`
  （命中率 = cacheRead / (input + cacheRead + cacheWrite)；无缓存活动时不显示）。
- 状态栏配置支持热加载：监听 `statusline.json` 所在目录，保存后 footer 自动刷新；
  `/statusline worktree on|off` 可立即切换 L2 的 worktree 段，不用改文件或 `/reload`。
- fullscreen 选区复制默认 clean copy：剥掉工具卡树线（`├ └ │ ↳`）、代码框
  （`╭─╮ │ │ ╰─╯`）和 `… N more lines` / `click to render all` 提示，只留正文；
  列 0 的 Markdown 引用块、diff 的 `+/-` 标记和正文缩进保持原样。
  `/ccstyle` → UI 页 `Clean copy` 可关。

### 性能

- 状态栏热路径不再每秒重建上下文统计：`getContextUsage()` 按会话叶子 + 模型缓存
  （5s TTL 兜底），状态栏配置只在会话启动读一次，渲染路径不碰文件。
- 会话用量改为增量累计：新叶子是缓存叶子后代时只累加新增 entry，
  分支切换/回退才全量重扫（20k 条实测约 0.95ms → 0.011ms/次）。
- bash 实时尾预览改为从末尾反向找最后 N 行，不再 split 整个输出；
  CR 只在需要时归一、尾空行手动回退（6.2MB / 20 万行：15.7ms → 2.6ms/次；
  同一输入重复渲染 <0.001ms）。
- 工具结果折叠摘要不再 split 全文：行数改换行计数，正文行按 result 对象
  WeakMap 缓存（源文本变化自动失效）。
- 新增 `npm run bench:hot`：状态栏用量、bash 尾预览、展开态 diff 上限的固定基准。
- 新增 `utils/width.ts` 快速测宽：ASCII + 本扩展自绘字形走单遍扫描，其余回落
  `visibleWidth`；diff 展开 2200 行 364ms → **94ms**，`render all` 753ms → **172ms**
  （`renderUnified` 154ms → 16ms）。`truncateByWidth` 同步改为按字素簇截断。
- bash 尾预览支持流式追加增量：新输出以旧输出为前缀时只扫新增后缀，
  6.2MB 追加一行 9.8ms → **3.2ms**。
- write/edit 流式预览的指纹改为增量 FNV-1a：只哈希新增后缀，不再每帧重扫全文。
- SGR 处理加热路径：单参数 SGR 跳过 split/map/filter，无 ANSI 行直接返回。
- Shiki 预热延后到首屏之后 2s（会话切换会取消），启动少约 90ms、
  峰值 RSS 少约 24MB；诊断日志改为 `PI_CC_SPINNER_DEBUG=1` 才开启。
- PR 号缓存加上限（64，LRU）；鼠标层不再每帧复制整屏行数组；
  transcript 右内缩容器定位加缓存（每 64 次全扫自愈）。

### 新增

- 状态栏在回合运行中显示 `run 12s`（每秒刷新，不足 1 秒不显示；
  `turn_end` / `agent_end` 后自动消失），长时间任务不用回头看 working 行。
  用量累计按会话 leaf id 缓存，每秒重绘不再扫描整个分支。

### 修复

- `statusline.json` 改为原子写（临时文件 + rename），写到一半崩溃不会留下
  半截 JSON 导致设置全丢。
- 展开态 diff 加 2000 行安全上限：先渲染前缀，末尾给
  `… N more diff lines · click to render all`；再点一次才全量解析/着色，
  避免几千行 edit/write 展开时卡住整屏。
- 组头工具列表按次数降序、同次数按名称排序：`Bash×3, Read×1` 先看跑得最多的工具。
- 组内折叠行在窄屏下先让 `offset=` / `limit=` 这类 detail 让位，保住路径或命令本身；
  主参数本来就很短（如 `a.ts`）时不按 30 列硬卡，detail 照常显示。
- read/grep/find/ls 的慢调用（≥1s）在产出后补耗时，组内行与单卡同口径：
  `Read big.ts · 120 lines · 1.5s`；快调用不挂数字。
- diff 里的超长单行（压缩后的 JS/CSS）最多展开 24 个视觉行，末行以 `…` 收尾，
  不再把滚动区撑到几千行；普通长行仍完整换行。
- diff 词级高亮增加相似度闸门：非空白词元重合度低于 25% 的改写只保留整行红/绿，
  不再逐个词打点，减少「整行都是高亮」的噪点。
- 状态栏成本显示：`$1` 以上两位小数，以下按有效小数（`$0.05` / `$0.012`），
  不足 `$0.005` 整段隐藏——不再把 `$0.004` 显示成误导性的 `$0.00`。
- `formatTokens` 遇到 `NaN` / `Infinity` 回 `?`，负数归 0，避免异常值漏进状态栏。

### 仓库

- 新增 `CONTRIBUTING.md`、`SECURITY.md`、issue 模板（bug / feature）、
  PR 模板与 Dependabot 周更配置。

## 1.4.3 — 2026-10-30

- README：新增中英 FAQ（互斥安装、fullscreen、状态栏、Windows/WSL、回退原生），
  修正兼容性描述为 Pi `>=1.2.0`。
- 新增本 `CHANGELOG.md`。
- CI：拆成 Lint / Typecheck / Test 三步，固定 `init.defaultBranch`；
  coverage 报告改为非阻塞。
- 测试：`COLORTERM` 固定为 truecolor，修复 CI（无终端环境）上的语法色断言。
- 无运行时行为变更。

## 1.4.2 — 2026-10-29

- README：新增工具卡分组、compact 汇总、`/context` 三张真实终端截图（中英同步）。
- 无代码变更。

## 1.4.1 — 2026-10-29

- npm 元数据：描述改为功能导向，keywords 补 `tui` / `terminal-ui` / `diff` /
  `theme` / `statusline`。
- README：标题改回包名 `pi-claude-code`，开头补定位与四条卖点，增加下载量徽章。
- 无代码变更。

## 1.4.0 — 2026-10-29

### 新增

- 子代理完成通知卡：`Subagent Finished <id> · N tool uses · tokens · cost · 耗时`，
  与相邻工具自动并组，可展开查看 description / 结果 / 错误。
- `Agent` 工具改由 ccstyle 渲染，是否走原生由 `excludeRenderers` 决定。
- diff 高亮改为按 omission 分段缓存，`/context` 用量数字列贴右并降为次级色。

### 上游同步

- merge `minuque/pi-cc-extensions` v1.0.9 → v1.0.12（37 个提交）。
- 按文件级移植 `timvdhoorn/cc-my-pi` v1.4.1 → v1.4.3 的相关修复：
  - git-info 轮询在 `ExtensionContext` 失效后自停（嵌入式会话 `dispose()` 不发
    `session_shutdown`，避免后台每 3s 起 git 进程）；
  - 延迟安装器吞掉 stale-ctx 异常，并在 switch / fork / tree / shutdown 前取消。

### 修复

- diff 省略行 `⋮ N lines` 的行数被高亮器清空。
- `write` 交回官方路径解析，WSL 的 `/mnt/<drive>/` 不再落到影子树。
- 会话重建 / 回放 / 切换样式后，最后一个回合不再停在 `Running`。
- `excludeRenderers` 匹配忽略大小写，面板候选去重。

### 说明

- 本 fork 保留：frame 弹框、P3 三段式标题、OSC8 路径、spinner/shimmer、
  两行状态栏、`elapsedMs` 计时、8 位短 `agent_id` 回落。
- 测试：787 例，786 通过 / 1 跳过。
