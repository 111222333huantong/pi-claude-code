# Changelog

本文件记录本 fork（`pi-claude-code`）的对外变化。上游合并记录见
[`docs/VENDOR.md`](./docs/VENDOR.md)。

## 未发布

### 新增

- 工具组头部在全部结算后报**总耗时**（各工具 `durationMs` 之和，`≥1s` 才显示）：
  `● Multiple Tools: 3 done · 2.4s · Read×2, Bash×1 · click to show more`。
- 组内折叠行报产出体积：`Read a.ts · 12 lines`、`Grep "TODO" · 3 matches`、
  `Find "*.ts" · 2 files`、`Ls . · 4 entries`；空结果用 `no matches` / `no files` /
  `empty` 短语。只对内置 read/grep/find/ls 生效，MCP 与扩展工具不猜口径。
  结果末尾的 `[N entries limit reached...]` / `[50.0KB limit reached]` 通知块不计入；
  grep 的 context 模式只数 `path:N:` 匹配行。

### 修复

- 组内折叠行在窄屏下先让 `offset=` / `limit=` 这类 detail 让位，保住路径或命令本身；
  主参数本来就很短（如 `a.ts`）时不按 30 列硬卡，detail 照常显示。
- diff 里的超长单行（压缩后的 JS/CSS）最多展开 24 个视觉行，末行以 `…` 收尾，
  不再把滚动区撑到几千行；普通长行仍完整换行。
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
