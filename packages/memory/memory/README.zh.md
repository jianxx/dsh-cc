# dsh-memory

中文 | [English](README.md)

面向 DeepSeek Harness 的 Claude Code 风格文件记忆：可持久化的 memdir 格式、
`memory` 系统提示词 section，以及通过 fork 的 side-query 进行动态召回。所有
文件访问都走可选的 `ctx.fs` 缝，因此远程或沙箱后端可无改动使用（无 provider
的宿主将记忆挂载为空操作）。

## 本包提供的能力

- **Memdir 格式** —— 一个记忆目录（默认为 harness home 的 `memory/`，另可从
  每个项目的 `.claude/memory` 叠加），包含始终加载的 `MEMORY.md` 入口（上限
  200 行 / 25 KB，是 `.md` 主题文件的一行式索引）。每个主题文件带 `name`、
  `description` 与 `type`（`user` / `feedback` / `project` / `reference`）
  frontmatter 以及 Markdown 正文。解析器已独立导出。
- **`memory` 系统提示词 section** —— 入口内容（截断）、按 frontmatter 的主题
  索引清单、以及 grep 搜索指引。当 `MEMORY.md` 缺失时 section 渲染为空（不报
  错）。section 文本同步组装，因此后台通过 `ctx.fs` 扫描缓存渲染文本，变更后
  通过 `system-prompt/change` 触发重组装。
- **动态召回** —— `agent/pre-step` 监听器用小型模型 side-query（通过
  `ctx.subagents` fork）判断哪些主题文件与当前轮相关，再通过 `agent.inject()`
  注入其正文。召回去重：本会话已展示过的主题文件不会重复注入。subagent 服务或
  provider 缺失时跳过召回，不报错。

## 使用

以 `@jianxx/dsh-cc-memory` 加载插件。配置项：

| Key | 默认值 | 含义 |
|---|---|---|
| `memoryHome` | harness home `memory/` | 记忆目录根 |
| `sectionEnabled` | `true` | 注册 `memory` 系统提示词 section |
| `recallEnabled` | `true` | 在 pre-step 上运行动态召回 |
| `recallProviderName` | `fork` | 召回查询的一次性子 agent provider |

```ts
import memory from '@jianxx/dsh-cc-memory'
await ctx.plugin(memory, { memoryHome: '/tmp/mem' })
```

## Model Experience

基准开销：每步一次同步渲染缓存的 section 文本（无 I/O）。最便宜路径还会扫描
记忆目录——当存在主题时，召回每轮可能花费一次小型模型 subagent 调用，直到所有
主题均已展示为止。token 增长受入口截断上限与五文件召回上限约束。

## API

- `parseMemoryFile(raw)` —— 将主题文件拆分为 frontmatter 与正文。
- `scanMemoryDirectory(fs, dir, signal?)` —— 读取入口与主题索引。
- `renderMemorySection(dir, state)` —— 由扫描状态生成 section 文本。
- `MemorySection` —— section 的后台刷新缓存持有者。
- `MemoryRecall` —— pre-step 召回协调器。
- `truncateEntrypointContent(raw)` —— 施加行/字节上限。
- `resolveMemoryHome`、`resolveProjectMemoryRoot` —— memdir 根解析辅助。

## 已知限制与延期工作

- `ctx.fs` 缝不暴露 mtime，因此召回去重按会话记录已展示路径，而非 mtime+path；
  每次注入都会重新读取内容，仍能反映磁盘变更。
- 召回 side-query 依赖已注册的一次性子 agent provider；本包不内置 provider
  （请组合 `fork` 或 `spawn`）。
- 写入侧强制（谁可写主题文件）在 `dsh-memory-consolidation` 中；本包只读。
