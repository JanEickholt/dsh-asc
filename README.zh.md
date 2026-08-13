# dsh-compaction-agentic —— DeepSeek Harness 的自主表面压缩（ASC）

[English](./README.md) | [中文](./README.zh.md)

由**模型自己决定何时、压缩什么**，并以持久化会话日志替换事件（`surfaceOp: replace`）提交到 DeepSeek Harness 的事件溯源表面之上。

这是 [opencode-acp](https://github.com/ranxianglei/opencode-acp) 验证过的"模型自主压缩"哲学，重建在一个让它可以被信赖的地基上：追加式会话日志——每个决策都是可回放的持久事件，每个压缩块都是从日志派生的视图，任何内容都不会丢失。

## 为什么

| | 经典压缩（basic 后端） | ACP 式模型自主 | 本包 |
|---|---|---|---|
| 谁来选压缩范围 | 固定策略 | 模型 | 模型 |
| 谁来写摘要 | 额外一次 LLM 调用 | 模型 | 模型 |
| 可逆（解压缩） | 否 | 是（侧面状态） | 是（日志回放） |
| 压缩后可检索 | 否 | 是（侧面状态） | 是（全日志 FTS） |
| 可审计 / 可回放 | 是 | 否 | 是 |
| 状态与消息流漂移 | 不适用 | 39 个 bug 的根源 | 结构上不可能 |
| 溢出安全网 | 是 | 硬编码 GC | 确定性降级 |

**融合点：** 压缩决策交给模型，压缩表示落在日志上。解压缩回放被 shadow 的事件（零存储状态），压缩块层级从 shadow 链推导（无侧面文件），nudge 写入日志并由 token 计量精确计价，搜索覆盖包括压缩原文在内的全量日志，溢出恢复则降级为确定性选择 + KV 缓存友好的 LLM 摘要。

## 四个工具

- **`context_compress`** —— 用模型书写的检查点替换表面区间，每个区间一次持久化 `compaction/*` 事务，并强制工具配对平衡、保护策略、收缩校验与质量门。
- **`context_decompress`** —— 通过回放日志还原压缩内容（层级感知：默认还原上一层，`full: true` 递归到底层原文）。
- **`context_status`** —— 用量、按层级的检查点、各层 token 总量、受保护内容、推荐区间、近期表面节点预览。
- **`context_search`** —— 对完整会话日志（含被压缩的 shadowed 内容）做全文检索。

另有自动、入日志、按 token 精确计价的 **nudge**，在上下文偏高时提示模型可压缩什么；以及不依赖模型的确定性**降级**路径，处理提供商确认的溢出与手动压缩。

## 快速开始

```sh
pnpm install && pnpm test && pnpm build
```

挂载到 DSH 组合（composition）：

```yaml
- name: "@dsh-asc/compaction-agentic"
  config:
    auto: true
- name: "@dsh-asc/compaction-agentic/invariant"   # 可选，推荐
- name: "@deepseek-ai/dsh-session-query-sqlite"   # 可选：context_search 需要
```

移除或禁用 `@deepseek-ai/dsh-compaction-basic` 行——`ctx.compaction` 同一时刻只能有一个提供者。完整配置与运维说明见 [docs/usage.md](docs/usage.md)。

## 文档

- [docs/analysis.md](docs/analysis.md) —— 对 DeepSeek Harness 与 opencode-acp 上下文管理的一手架构分析，以及本设计的推导过程。
- [docs/design.md](docs/design.md) —— 已实现契约：事件、工具、自动行为、降级、保护、不变量。
- [docs/usage.md](docs/usage.md) —— 安装、挂载、配置、模型体验、运维。

## 开发

```sh
pnpm install
pnpm test          # vitest：98 个单元 + 集成测试
pnpm typecheck
pnpm build         # tsc 产出 lib/types
```

仓库遵循 DSH 约定：ESM、严格 TypeScript、`.ts` 导入后缀、注册即效应（可逆）、"模型可见 ⟺ 已记录"、闭联集 switch 带文档化默认分支、每包一个 invariant companion。

## 许可证

MIT。本项目改编自 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（MIT）的算法，且仅借鉴 [opencode-acp](https://github.com/ranxianglei/opencode-acp)（AGPL）的**思想**——未复制其任何源码。见 [NOTICE](NOTICE)。
