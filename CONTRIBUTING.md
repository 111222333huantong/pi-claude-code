# 参与开发

`pi-claude-code` 是 [Pi](https://pi.dev) 的渲染扩展：把工具调用画成 Claude Code 风格的卡片，
并提供 diff、compact 模式、状态栏与主题。改动最终都会落到终端输出上，所以**先看快照测试**，
再谈实现。

## 环境

- Node.js **≥ 22.19**（测试直接用 `node --test` 跑 TypeScript，不需要构建步骤）
- npm（提交 `package-lock.json`）
- 一个能跑 Pi 的终端；涉及鼠标 / OSC8 / 内联图片的改动最好在真实终端里看一眼

```bash
npm ci
npm run typecheck
npm run lint
npm test
```

`npm run ci` 就是 lint + typecheck + test，与 GitHub Actions 一致。

## 代码地图

| 路径 | 内容 |
|---|---|
| `extensions/index.ts` | 扩展入口，负责装配各 feature |
| `extensions/config/` | 配置项、默认值、`/config` 输出 |
| `extensions/renderer/` | 工具卡、分组、diff、compact、状态栏等渲染层 |
| `extensions/feature/` | `/context`、`/loaded`、引用、粘贴等独立功能 |
| `extensions/utils/` | 无状态工具函数（宽度、ANSI、格式化） |
| `tests/` | `node:test` 用例，按功能分文件，渲染断言以纯文本快照为主 |
| `themes/` | 随包发布的四套主题 |
| `docs/VENDOR.md` | 上游合并记录与第三方来源，改上游同步逻辑时必读 |
| `docs/release.md` | 发版流程（维护者） |

## 改动约定

- **不要新增内置工具**。这是本包的边界：只改呈现，不改变 Pi 的工具面。
- 渲染层的宽度一律用 `visibleWidth` / `truncateToWidth` 计算，不按字符数截断（CJK、emoji、ANSI）。
- 颜色走主题槽位（`theme.fg(...)`），不要在渲染代码里写死 ANSI 色值；新增槽位要在四个主题里都有值。
- 交互（点击、悬停、滚轮）改动要同时改 `tests/mouse-*.test.ts`，并用 `hitTarget` 而不是坐标猜测。
- 新增配置项：`extensions/config/config.ts` 的默认值 + 解析 + `/config` 输出 + README 表格 + 测试，一处不能少。
- 保留 fork 已有语义（短 agent_id、卡片几何、紧凑 token 口径、`elapsedMs`），见 `docs/VENDOR.md`。

## 测试

```bash
npm test                                   # 全量
node --test tests/tool-grouping.test.ts    # 单个文件
npm run coverage                           # 覆盖率报告（无门槛）
```

- 渲染断言前先 `stripAnsi`，再 `filter(Boolean)`，否则空行/颜色会让快照很脆。
- 涉及鼠标或真彩色的用例固定 `process.env.COLORTERM ??= "truecolor"`，否则 CI runner 上
  会因终端能力探测不同而失败。
- 需要临时 git 仓库的用例自己设置 `GIT_AUTHOR_NAME/EMAIL`、`GIT_COMMITTER_NAME/EMAIL`，
  不要依赖开发机的全局 git 身份。

## 提交与 PR

- 提交信息用祈使句，建议 `feat:` / `fix:` / `test:` / `docs:` / `chore:` 前缀，正文写「为什么」。
- 一个 PR 只做一件事；纯格式化改动单独提交，别混进功能 diff。
- PR 描述里贴改动前后的终端片段（可以直接复制文本，不必截图），并写明跑过的命令。
- 修 bug 时先加一个会失败的用例，再改实现。

## 上游同步

本仓库 fork 自 [`minuque/pi-cc-extensions`](https://github.com/minuque/pi-cc-extensions)，
并选择性移植 [`timvdhoorn/cc-my-pi`](https://github.com/timvdhoorn/cc-my-pi) 的功能。
同步步骤、冲突判定与每个版本的合并记录都在 `docs/VENDOR.md`；提交上游 delta 时请在同一 PR
里更新该文件，方便下次对账。

## 行为准则

讨论对事不对人。Issue / PR 里可以直接说「这个设计我不认同」，但请给出可复现的现象或更好的方案。
