# dsh-memory

中文 | [English](README.md)

面向 DeepSeek Harness 的 Claude Code 风格文件记忆：可持久化的 memdir 格式、
`memory` 系统提示词 section、`memory_save` 写入通道，以及通过 fork 的
side-query 进行动态召回。所有文件访问都走可选的 `ctx.fs` 缝，因此远程或沙箱
后端可无改动使用（无 provider 的宿主将记忆挂载为只读）。

## 本包提供的能力

- **Memdir 格式** —— 一个记忆目录（默认为 harness home 的 `memory/`，另可从
  每个项目的 `.claude/memory` 叠加），包含始终加载的 `MEMORY.md` 入口（上限
  200 行 / 25 KB，是 `.md` 主题文件的一行式索引）。每个主题文件带 `name`、
  `description` 与 `type`（`user` / `feedback` / `project` / `reference`）
  frontmatter 以及 Markdown 正文。解析器已独立导出。
- **`memory` 系统提示词 section** —— 保存通道指引、入口内容（截断）、按
  frontmatter 的主题索引清单、以及 grep 搜索指引。section 始终渲染（无记忆时
  显示占位符），保存指引永不缺席。section 文本同步组装，因此后台通过 `ctx.fs`
  扫描缓存渲染文本，变更后通过 `system-prompt/change` 触发重组装；轮末监听器
  会重新扫描，host 侧写入无需重启即可进入提示词。
- **`memory_save` 工具** —— 唯一可用的保存通道。记忆目录在所有会话 workspace
  之外，直接的 `write`/`edit` 调用会被 fs sandbox 拦截、必然失败，section 文案
  对此有明确说明。工具接收结构化字段（`name`、`type`、`description`、`body`），
  由 host 侧生成 frontmatter、upsert `MEMORY.md` 指针行，并经 `ctx.fs` 缝以
  `{ mode: 'workspace-write', workspaceRoot: <记忆目录> }` 的 per-call 策略
  落盘——围栏保留，可写根恰好是记忆目录。校验（kebab-case slug、四种类型、大小
  上限）与 `dsh-memory-consolidation` 的 fork 写回共用同一 `writeback` 边界。
  注册是机会式的：宿主无 tools 服务时跳过并保持只读。
- **动态召回** —— `agent/pre-step` 监听器用小型模型 side-query（通过
  `ctx.subagents` fork）判断哪些主题文件与当前轮相关，再通过 `agent.inject()`
  注入其正文。召回去重：本会话已展示过的主题文件不会重复注入。会跟踪本会话
  早期使用过的工具（`tools/post-execute`）并传给 selector，从而抑制正在使用工具
  的参考文档类记忆（其警告/坑点仍会呈现）。subagent 服务或 provider 缺失时跳过
  召回，不报错。
- **团队记忆（可选）** —— 当 `teamEnabled` 为 `true` 时，在私有 memdir 之上叠加
  每个项目共享的团队目录（`memoryHome/team`），`memory` section 渲染合并的私有 +
  团队提示词。每次团队记忆访问都走 seam 原生校验链（先纯字符串键 sanitization，
  再 `lstat` 末段 symlink 拒绝，最后 `resolve` + `contains` 前缀包含校验）。

## 使用

以 `@jianxx/dsh-cc-memory` 加载插件。配置项：

| Key | 默认值 | 含义 |
|---|---|---|
| `memoryHome` | harness home `memory/` | 记忆目录根 |
| `sectionEnabled` | `true` | 注册 `memory` 系统提示词 section |
| `recallEnabled` | `true` | 在 pre-step 上运行动态召回 |
| `recallProviderName` | `fork` | 召回查询的一次性子 agent provider |
| `teamEnabled` | `false` | 启用共享团队记忆目录与合并 section |

> **`teamEnabled` 默认关闭。** 开启会改变持久化记忆布局（创建并读取
> `memoryHome/team/`）、改变模型写入内容（`private` 与 `team` 两种 scope），并把
> 团队记忆读取指向共享目录。适用于单租户、受信写者项目：逐次访问校验关闭了
> 穿越，但*中间组件* TOCTOU 窗口并未完全关闭（仅末段做 `lstat` 校验，且
> resolve/包含校验与读取并非原子）。不得在**多租户或不可信写者**场景启用
> `teamEnabled`。

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
- `renderMemorySection(dir, state)` / `renderTeamMemorySection(...)` /
  `saveGuidance(dir)` —— section 文本构建器。
- `MemorySection` —— section 的后台刷新缓存持有者。
- `registerMemorySaveTool(ctx, dir, section)` / `MEMORY_SAVE_TOOL` —— 面向模型的
  保存通道。
- `validateMemoryWrites(input)` / `writeMemoryFiles(fs, dir, writes)` /
  `memoryWritePolicy(dir)` / `MEMORY_WRITES_SCHEMA` —— 与
  `dsh-memory-consolidation` 共用的 host 侧写回。
- `MemoryRecall` —— pre-step 召回协调器。
- `truncateEntrypointContent(raw)` —— 施加行/字节上限。
- `resolveMemoryHome`、`resolveProjectMemoryRoot` —— memdir 根解析辅助。
- `sanitizePathKey(key)`、`validateTeamMemKey(fs, teamDir, relativeKey)`、
  `resolveTeamMemoryRoot(home)` —— 团队记忆安全链与路径辅助。

## 已知限制与延期工作

- `ctx.fs` 缝不暴露 mtime，因此召回去重按会话记录已展示路径，而非 mtime+path；
  每次注入都会重新读取内容，仍能反映磁盘变更。CC 的 `memoryAge` 新鲜度加权
  因此推迟，直到 seam 携带 mtime（见 `docs/cc-parity-matrix.md`）。
- 召回 side-query 依赖已注册的一次性子 agent provider；本包不内置 provider
  （请组合 `fork` 或 `spawn`）。
- `memory_save` 只写私有目录；团队 scope 的保存通道与删除通道已延期（CC 的直接
  Write 语义同样推迟——fs sandbox 使会话工具无法直接写记忆目录）。
- 团队记忆（`teamEnabled`）的可逆性与安全性：启用即改变持久化格式，且中间组件
  TOCTOU 窗口（仅末段做 `lstat` 校验；resolve/包含校验与读取并非原子）意味着
  不得在**多租户或不可信写者**场景启用。
