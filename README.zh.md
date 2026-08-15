# dsh-asc

[![npm](https://img.shields.io/npm/v/dsh-asc.svg)](https://www.npmjs.com/package/dsh-asc)
[![GitHub tag](https://img.shields.io/github/v/tag/lmst2/dsh-asc)](https://github.com/lmst2/dsh-asc/releases)
[![license](https://img.shields.io/github/license/lmst2/dsh-asc.svg)](LICENSE)

[English](./README.md) | [中文](./README.zh.md)

**dsh-asc**（全名 **DeepSeek Harness Agentic Surface Compaction**）是
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的上下文压缩插件：由**模型自己决定何时压缩、压缩什么**，每个压缩决策都以持久化会话日志替换事件（`surfaceOp: replace`）提交，可回放、可检索、可撤销。

灵感来自 [opencode-acp](https://github.com/ranxianglei/opencode-acp) 的"模型自主压缩"哲学，但建在 DSH 事件溯源日志之上——压缩不产生任何侧面状态文件，解压靠日志回放，搜索覆盖包括压缩原文在内的全量日志。

## 安装

**前置要求**：已安装 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh` 命令可用）；Node.js `^22.19` 或 `>=24`。

**从 npm 安装**（推荐）：

```sh
dsh plugin --profile <name> add dsh-asc
```

**从 GitHub 安装**——想用比 npm 版本更新的提交：

```sh
dsh plugin --profile <name> add github:lmst2/dsh-asc
```

`dsh plugin` 会把插件加入 profile，并根据包内的 `dsh.bundle` 声明自动启用它；工具和系统提示随该 profile 一起加载。

> **重启生效**：安装完成后，重启正在运行的 DeepSeek Harness 服务。

### 其他安装方式

**从源码安装**——要改插件本身，或参与开发：

```sh
git clone https://github.com/lmst2/dsh-asc.git
cd dsh-asc
pnpm install
pnpm build
dsh plugin --profile <name> add "link:$(pwd)"
```

### 禁用 basic 后端

`ctx.compaction` 同一时刻只能有一个提供者。在 profile 自己的 `cordis.patch.yml` 里禁用默认的 basic 后端：

```yaml
- id: compaction-basic
  disabled: true
```

可选：挂载不变式伴生和全文检索后端：

```yaml
- insert:
    - id: dsh-asc-invariant          # 运行时不变式检查（可选，推荐）
      name: "dsh-asc/invariant"
    - id: session-query-sqlite       # context_search 全文检索后端（可选）
      name: "@deepseek-ai/dsh-session-query-sqlite"
```

## 使用

安装并重启后，无需任何配置——插件会：

- 在系统提示中注入**上下文管理规范**（判断规则、工具用法、分层压缩节奏），模型从第一轮起就主动管理上下文；
- 在上下文偏高时按需注入 **nudge 提示**（节奏门控；迭代类 nudge 还要求真实 token 增长，不会每轮打扰）；
- 在溢出或手动压缩时走**确定性降级**（LLM 摘要；挂载可选的上游工具结果修剪器时先修剪），无需模型配合。

插件提供五个模型工具：

| 工具 | 作用 |
|---|---|
| `context_status` | 上下文用量、分层检查点、系统/对话构成、推荐压缩区间、近期表面节点 |
| `context_compress` | 把一段表面范围替换成你写的检查点（支持批量；自动扩展工具调用对；质量门把关） |
| `context_decompress` | 撤销压缩：原文回到表面中检查点原位置（层级感知，`full: true` 到原始内容） |
| `context_recap` | 重新读取检查点摘要，不解压原文 |
| `context_search` | 全量日志全文检索（含已压缩内容） |

压缩后的内容永不丢失：原文保留在会话日志里，随时可解压或检索。

系统提示词把这些工具串成一条操作闭环：把已经消费的原始工作压成 T1
检查点，把稳定下来的 T1 堆蒸馏成 T2 决策、再把 T2 堆凝结成 T3 事实索引。
每个检查点正文都带有 topic 和 Compaction id：可见摘要已经指出细节在哪
一块时，模型直接按 id 解压那一块；只有没有任何可见摘要能说明细节位置
时才用 `context_search`，而解压始终逐层进行。

## 工作原理

- **事件溯源**：压缩 = 日志里的一个事务（`compaction/start` → `compaction/summary` → 替换 `user/message` → `compaction/end`），无侧面状态。
- **分层压缩**：检查点分 tier（T1 全细节 → T2 决策蒸馏 → T3 裸事实），摘要越用越薄。
- **可逆**：解压回放日志中被 shadow 的事件，并提交一条原地替换事件；不需要任何侧面状态。
- **可审计**：谁压的、压了什么、摘要全文、token 成本都在日志里。

## 仓库结构

```
src/
  index.ts      插件入口：注册 ctx.compaction 与五个工具
  config.ts     严格配置校验
  types.ts      共享配置与结果类型
  events.ts     会话事件词汇说明（不声明自定义成员）
  invariant.ts  运行时不变式伴生（子路径导出）
  engine/       压缩引擎核心（engine、region、tier、quality-gate、fallback、prompt、restore）
  policy/       受保护节点策略与 nudge 状态机
  tools/        五个模型工具
  utils/        共享文本工具
tests/          vitest 测试套件
docs/           usage、design、analysis、e2e-validation
```

## 文档

| 文档 | 内容 |
|---|---|
| [docs/usage.md](docs/usage.md) | 安装、配置、模型体验、运维 |
| [docs/design.md](docs/design.md) | 已实现契约：事件、工具、自动行为、保护、不变式 |
| [docs/analysis.md](docs/analysis.md) | DSH 与 opencode-acp 上下文管理的对比分析 |

## License

MIT。算法借鉴 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（MIT），仅借鉴 [opencode-acp](https://github.com/ranxianglei/opencode-acp)（AGPL）的思想，无源码。见 [NOTICE](NOTICE)。
