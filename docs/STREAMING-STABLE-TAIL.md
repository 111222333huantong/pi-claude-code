# 流式渲染 stable/tail 二分 — 调研与落地备忘

> 来源：locode `tui-harness-study.md`（2026-07 逐行源码调研四家 CLI TUI）、
> Codex `markdown_stream.rs`、hermes PR #67236、kilocode PR #11038、
> `ink-markdown`（kud）。本文件回答「为什么还没做」和「要做需要哪一步」。

## 问题

`stream-throttle.ts` 把渲染频率从 ~40fps 压到 ~10fps（244ms → 48ms/40 帧实测），
但**每次渲染的成本仍随已输出长度线性增长**：pi 的
`AssistantMessageComponent.updateContent` 每帧 `contentContainer.clear()`
后整段 `setText()`，`Markdown.render` 从 `markdownParser.lexer` 重新词法
全量文本。Codex/grok 的做法是 settled blocks 直接 print-once 进原生
scrollback，永远退出热路径；opencode 虚拟化截断。我们是扩展，scrollback
归 pi 管，不能 print-once。

## 业界收敛模式（stable/tail）

- **只 commit 到最后一个 `\n` 为止的 markdown**：stable 区不再变，可以
  tokenize 一次冻结；mutable tail 保持 live。
- **未闭合的块整体 hold**：表格新行会重排列宽，所以 in-progress 表格不
  进 stable 区。fence/数学块同理（fence state 跨 delta 维持）。
- **settled blocks append-only**：React 生态里是「冻结成数组，每个块
  tokenize 恰好一次」；Rust/原生 scrollback 里是 print-once。
- 结果：O(blocks²)/reply → O(tail)/frame。

## 我们的可行路径（按依赖排序）

1. **pi-tui `Markdown` 已有关键半成品**（`markdown.js`）：
   `blocks` WeakRef 缓存按块复用渲染结果，`cachedTokens` WeakRef 缓存词法
   结果。但 `setText` 无条件 `clearRenderCache()`，且 lexer 每次对
   **整段**归一化文本跑——缓存粒度是「整段文本没变」而非「前缀块没变」。
2. **扩展侧能做但收益有限**：在 `updateContent` patch 里把 stable 前缀
   与 tail 拆成两个 `Markdown` 组件（前缀组件不再 `setText`）。受限于
   `updateContent` 每帧 `contentContainer.clear()`，我们自己维护子容器
   才能保住前缀组件——复杂度集中在「我们的 patch 如何在 clear 之后把
   稳定的子树塞回去」，需要重写 pi 的整个 `updateContent` 而不仅是包
   一层，维护成本高且脆弱。
3. **正解是上游**：给 pi 提 issue/PR，请求 `Markdown` 组件支持
   `commitStablePrefix()`：lexer 输出按 top-level block 切分，已闭合
   块冻结 tokenize 结果，后续 `setText` 只对新增 tail 重新 lex。
   pi PR #6665（slot 复用）和 #7082（O(viewport)）已经在往这个方向走，
   这个 API 是自然延续。

## 上游 issue 草案（可直接发）

```markdown
Title: feat(tui): incremental markdown rendering via stable-prefix commit

## Problem
AssistantMessageComponent.updateContent re-lexes the entire accumulated
markdown on every streaming frame. With stream throttling this is still
O(reply length) per frame; a 50KB reply costs full re-tokenization each
update even though earlier top-level blocks are immutable.

## Proposal
Give Markdown (or a new IncrementalMarkdown) a stable/tail split, mirroring
Codex's markdown_stream and ink-markdown's approach:

- `commitStable(text)` marks everything up to the last completed top-level
  block boundary as immutable; those blocks' tokenize results are frozen.
- `setText` (or `appendDelta`) only re-lexes the mutable tail after the
  stable boundary.
- Block-boundary rule: commit only up to the last `\n` that closes a
  top-level block; hold back unclosed fences/tables/math (a new table row
  re-shapes column widths, so in-progress tables stay in the tail).

## Why not extension-side
Extensions can wrap updateContent but cannot preserve a child component
across `contentContainer.clear()`; keeping stable children alive requires
owning the container, i.e. replacing updateContent wholesale, which is too
fragile to maintain as a patch.

## References
- Codex: codex-rs/tui/src/markdown_stream.rs (stable/tail + table holdback)
- ink-markdown: append-only frozen blocks per top-level element
- pi PR #7082: O(viewport) transcript rendering (same direction)
```

## 当前状态（v1.7.x）

- stream-throttle 已把频率项压平（两档节奏 + catch-up），剩余缺口是
  每次渲染的长度项——属结构性，只能等上游 API 或接受 patch 复杂度。
- 若上游长期不接，fallback 是「stable 前缀拆子组件」方案，先在
  feature flag 下小范围验证再铺。
