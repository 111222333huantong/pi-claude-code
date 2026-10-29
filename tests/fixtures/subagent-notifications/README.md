# subagent-notification 格式样本

`formats.json` 是 pi-subagents `subagent-notification` 通知的格式样本，供
`tests/subagent-notification-fixtures.test.ts` 驱动单独行、展开卡与工具分组的渲染测试。
每条是一条会话里保存的 `custom_message` 条目（`{ name, entry }`），测试经 Pi 的
`sessionEntryToContextMessages` 转成消息后渲染。

## 这是什么，不是什么

- **按形状重建，不是录制**：只看本机 Pi 会话里的 `subagent-notification` 条目，先归纳成
  「哪些字段、什么类型」的形状，再按形状用固定的合成值重建。不是逐字节的脱敏录制，也不是
  完整会话回放；没有任何邻近消息或工具调用。
- **不含原始内容**：原文、说明、结果预览、错误、id、路径、时间、用量都不保留；也不记录来源
  会话、项目、路径、哈希、出现次数或频率。
- 测试只读这个文件，不读任何本机会话目录。

## 保留与归一化

保留的维度：

- 字段有没有出现；`status` 的已知取值；用量是 0 还是正数；文本是单行还是多行。
- `others` 没有、一个还是多个，以及其中各不相同的嵌套形状。

归一化（统一换成固定值）：

| 内容 | 固定值 |
| --- | --- |
| agent id | `fixture-agent-N`（首个 agent 起按顺序编号） |
| `description` / `resultPreview` / `error` | `Fixture task.` / `Fixture preview.` / `Fixture error.`；多行再接一行 `Fixture second line.` |
| `outputFile` | `/fixture/transcripts/<id>.output` |
| 用量 | `toolUses` 2、`turnCount` 3、`totalTokens` 1234、`totalCost` 0.125、`durationMs` 1200；0 仍是 0 |
| `content` | 固定的 `<task-notification>` 信封 |
| 条目 | `id` `fixture-entry`、`parentId` null、`timestamp` 2000-01-01 |
| 批量 | 每种嵌套形状留一个代表，需要「多个」时复制一个；不代表实际数量或顺序 |

名称只由序号与格式维度组成：
`format-NN-<status>-<batch|single>-<path|no-path>-<cost|zero-cost|no-cost>-<multiline|single-line>`。

## 新增格式

1. 只为真实观察到、现有样本没有的新形状新增；在本机归纳形状，不把原始条目带进仓库。
2. 所有值按上表换成合成值，名称按上面的规则生成，追加到末尾。
3. 测试里的隐私守卫只放行这些字段与固定值：新字段或新 status 要同时改守卫，并单独审查。

虚构的异常输入（`details` 缺失或为 null、未知 status、畸形 `others`）不属于观察到的格式，
放在 `tests/subagent-notification.test.ts`，不放这里。
