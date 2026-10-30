# Changelog

本文件记录本 fork（`pi-claude-code`）的对外变化。上游合并记录见
[`docs/VENDOR.md`](./docs/VENDOR.md)。

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
