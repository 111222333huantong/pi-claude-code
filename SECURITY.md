# 安全策略

## 支持范围

只维护 npm `latest` 对应的版本线（当前 `1.4.x`）。旧版本的问题请先升级再复现。

## 报告漏洞

**不要**开公开 issue。请用 GitHub 的私密报告入口：

<https://github.com/111222333huantong/pi-claude-code/security/advisories/new>

报告里请包含：

- 受影响的版本（`npm view pi-claude-code version`）与 Pi 版本（`pi --version`）
- 复现步骤或最小会话 / 配置
- 影响面：本地命令执行、文件读写越界、终端转义注入、供应链（依赖）等
- 如果方便，附上修复建议

一般 3 天内确认，7 天内给出处理计划；修复发布后会在 `CHANGELOG.md` 与 GitHub Security
Advisory 里同时说明。

## 本包的信任边界

`pi-claude-code` 是 **渲染与交互扩展**，不是沙箱：

- 它不新增内置工具，也不改变 Pi 的权限模型；`bash` / `write` 等仍由 Pi 与你的审批策略决定。
- 它会读取工具结果、会话文件与主题 JSON 来绘制界面；这些内容来自你本机或你信任的模型输出。
- 主题、配置、`@` 引用等输入都按不可信文本处理并做宽度/转义清洗，但**不要**把来源不明的
  扩展与本包同载。
- 与 `pi-cc-extensions`、`pi-claude-code-tui`、`pi-tidy` 等同类包互斥；同载会互相 patch
  渲染层，出现的问题不属于安全漏洞，但请先卸载再复现。

## 依赖

依赖通过 `package-lock.json` 固定，Dependabot 每周提一次更新 PR，CI 全绿才合并。
如果你在依赖里发现漏洞，也请走上面的私密入口。
