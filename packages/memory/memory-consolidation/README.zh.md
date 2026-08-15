# dsh-memory-consolidation

中文 | [English](README.md)

面向 DeepSeek Harness 的后台记忆整合：轮末抽取与对 `dsh-memory` 所读取的记忆
目录进行三重门 dream 重写。

## 本包提供的能力

- **extractMemories** —— `agent/turn-stopping` 监听器启动一个后台 fork 的
  subagent（通过 `ctx.jobs` + `ctx.subagents`，工具被限制为仅访问记忆目录），
  从当前轮抽取持久事实并追加到匹配的主题文件。
- **Dream 整合** —— 三道可配置的门，全部通过后才会用只读的 fork subagent 回顾
  过往会话并重写 `MEMORY.md` 与主题文件：
  1. **时间门** —— 自上次整合起至少 `minHours`（默认 24）小时。
  2. **会话门** —— 至少 `minSessions`（默认 5）条新 transcript。
  3. **文件锁** —— `.consolidation-lock` 文件以存储的时间戳保证互斥；过期的持有者
     （超过 `lockStaleMs`，默认 1 小时）可被回收，因此整合中崩溃可自动恢复。失败
     或被 kill 的整合会回滚锁，使时间门重新打开。
- **记忆写入改变模型可见上下文** —— 在上游，`dsh-memory` 会在记忆目录变更后通过
  `system-prompt/change` 重组装 `memory` 系统提示词 section。本包不为记忆文件本身
  引入新的会话事件。

## 使用

以 `@jianxx/dsh-cc-memory-consolidation` 加载插件。配置：

| Key | 默认值 | 含义 |
|---|---|---|
| `memoryHome` | harness home `memory/` | 记忆目录根 |
| `extractEnabled` | `true` | 运行轮末抽取 |
| `dreamEnabled` | `true` | 运行三重门 dream |
| `minHours` | `24` | 两次整合间的最小间隔小时数 |
| `minSessions` | `5` | 需要整合的最小新 transcript 数 |
| `lockStaleMs` | `3_600_000` | 锁持有者过期窗口 |
| `subagentProviderName` | `fork` | fork 使用的一次性 provider |

```ts
import consolidation from '@jianxx/dsh-cc-memory-consolidation'
await ctx.plugin(consolidation, { minHours: 24, minSessions: 5 })
```

## Model Experience

门关闭时，turn-stopping 监听器几乎无成本（一次锁读取）。当时间门与会话门打开时，
每次整合运行一个 fork subagent，限制为读/搜索加记忆写入工具；其输出不会追加到主
transcript。每轮抽取可能启动一个短暂后台 fork。

## API

- `tryAcquireLock(fs, dir, pid, now)` / `rollbackLock(fs, dir, priorAt)` /
  `readLastConsolidatedAt(fs, dir)` —— 整合锁。
- `gatesPass(input)` / `timeGatePasses(...)` / `sessionGatePasses(...)` —— 门谓词。
- `MEMORY_TOOL_FILTER` / `MEMORY_AGENT_TOOLS` —— 记忆作用域工具集。
- `buildExtractionPrompt` / `buildConsolidationPrompt` —— fork 的提示词。

## 已知限制与延期工作

- `ctx.fs` 缝不暴露 mtime，因此锁将持有者 PID 与上次整合时间戳存入锁文件正文而非
  文件 mtime；崩溃恢复依赖过期窗口而非进程存活。
- 会话门当前通过 `ctx.sessions` 统计存活会话并将其视为新会话；带时钟的 transcript
  查询已延期。
- Write/Edit 的路径作用域由提示词契约而非路径感知的工具守卫强制。
