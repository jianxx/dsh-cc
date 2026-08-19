# @jianxx/dsh-cc-subagent-task

[English](README.md) | 中文

面向 DeepSeek Harness 的 **Claude Code 兼容 Task 工具** 与 **按工作区隔离的 subagent 目录**。它挂载:

- 内部工具名 `subagent_fork`(CC 显示名 `Task`),以 `subagent_type` 对会话工作区的 `.claude/agents` 定义做派发;
- `Available subagents` 系统提示词 section(**按工作区**渲染);
- 保留的工具名(`subagent`、`workflow`),使被禁用的 harness 行仍可被 restrict。

`ccModelRoutes` 服务(来自 `@jianxx/dsh-cc-model-aliases`)提供派发时的别名解析器;当其缺席时,每个 child 继承父路由(内置 fallback)。

## 是什么

Claude Code 的 `Task` 工具允许主代理按 `subagent_type`(如 `deep-reasoner`)委派给 `.claude/agents` 里定义的具名 subagent,运行时加载该 agent 自己的 system prompt、model 与工具限制。历史上 DeepSeek Harness 只有通用 fork(`description`/`prompt`),因此 `subagent_type` 派发形同虚设:child 只能拿到主模型写在 prompt 里的**手写角色文字**,而该 agent 的 `model: opus` alias 也从未抵达后端路由。

本包恢复真实链路。它发现从**会话**工作目录(而非宿主进程 cwd——web 宿主同时服务多个工作区,从 `~/.dsh/…` 启动也必须看到 `my-repo/.claude/agents`)可见的 CC `.claude/agents` 定义,并把内部 `subagent_fork` 工具变成一个真正的 subagent-type 派发器。

## 派发机制

给定 CC preset 会话中的一次 `Task(subagent_type, description, prompt)` 调用:

1. **`subagent_type` 省略、空白或为 `general-purpose`** → **普通 fork**(既有语义):prompt 文本成为 child 的首条 user message,无定义参与。
2. **命中会话 cwd(`cwdOf` 组装 agent)下的定义** → 以 `fork` 启动并携带:
   - `persona` = 定义的 `systemPrompt`(作为 child 的系统段下发);
   - 任务文本作为 child 的**首条 user message**;
   - `agentOptions` = 来自 `ctx.get('ccModelRoutes').resolve(def.model)` 的别名解析结果 `{ provider?, model? }`(只透传解析到值的 provider/model 字段,绝不破坏按字段继承);
   - `toolFilter` = 定义的 `toolRestriction`(allow/deny),**消毒**掉本组合已不再注册的工具名;
   - `maxDepth` = 3(与 harness 默认一致;可配置)。
3. **其它类型**(工作区内找不到)→ **报错结果**,附带本工作区可用类型清单(或说明本工作区未定义任何 agent)。

运行是**前台一次性**:工具等待 child 跑完并返回其最终文本。非 `completed` 的 stop reason 以错误浮出,child 输出只拼接 `text` 块。

### 工具限制消毒与保留名

当定义 frontmatter 收窄工具(如 `tools: Read, Task`)时,allow/deny 清单会强制经过 CC→harness 翻译。既未注册也未保留的名会被丢弃并告警——否则 child 的 scoped `restrict()` 会看到一个在加载期已非法的名字。本包注册内部工具名 `subagent_fork`,并经 `ctx.tools.reserve('subagent')` / `reserve('workflow')` 把这些名放进可限制 universe 而不暴露可见定义(CC frontmatter `Task` 的翻译是 `['subagent', 'subagent_fork']`,故即使 harness spawn 行被禁,`subagent` 也必须保持合法;`workflow` 为延后的 workflow 行保留)。这就是 `Task` frontmatter 限制能生效的原因:两个名都逃过了消毒。

## Available subagents 系统提示词 section

一个全局 section(`cc:subagent-catalog`,order 110)服务所有 agent。其 text 回调通过 assemble scope 拿到组装 agent,推导其 cwd,并渲染:

```
## Available subagents

- deep-reasoner — reason through hard architecture and design problems
- fast-worker — execute a pre-approved mechanical plan

To delegate to one, pass its name as the `subagent_type` argument of the Task tool.
```

由于 section 文本是同步组装的而发现是异步的,未知工作区的首次组装会显示空,随后 discovery 落地后触发 `system-prompt/change`,重组即显示目录。当工作区未定义任何 agent(或没有可 scope 的 agent)时,section 渲染空串并从提示词中消失。目录只列**文件定义**——刻意**不**把 seam 后端 provider 名(`fork`/`spawn`/`codex`/`claude-code`)当作可寻址的 agent 类型来枚举。

## 挂载

由 `cc` preset 的 `tool-task` 行(`@jianxx/dsh-cc-subagent-task`)挂载在 `cc-services` 组内,旁边是提供别名解析器的 `cc-model-routes`(`@jianxx/dsh-cc-model-aliases`)。cc preset **禁用** harness 的 `tool-subagent` 与 `tool-subagent-fork` 两行以改用本工具,避免 `subagent_fork` 名被重复注册。

## 已知限制

- **仅前台。** 本工具取代的 harness `tool-subagent-fork` 行原本是 `backgroundMode: continuable`(durable id + 挂在 host-plane 单例上的 `report`/`send_message`)。v1 将 CC Task 前台化、一次性;**durable 后台/continuable 流程为 follow-up**——这是对既有 preset 行为的可见回退,已在 parity matrix 中如实记录。
- **进程级发现缓存。** 注册表按工作区 root 缓存整个进程生命周期,不监听文件系统。编辑 `.claude/agents` 定义:对缓存条目尚未创建的工作区在下次会话生效,否则在进程重启后生效。基于 mtime 的失效刷为 follow-up。
- **v1 不做插件 agent 派发。** 只派发 `.claude/agents` 下的文件定义。seam 插件 agent(`AgentProvider`)在 v1 不被 `subagent_type` 寻址(其 start 契约不携带任务正文,且 capability 标志会拒绝 `maxDepth`)——见 parity matrix。
- **fork 继承父 prefix。** 本工具用 harness 的 `fork`,它继承父 agent 的消息 prefix;Claude Code 的 `Task` 无此继承。这是已知 parity 差异,v1 不修。

## API

- `apply(ctx)` — cordis 插件入口(插件 id `cc-subagent-task`);tools 或 system-prompt seam 任一缺席时也安全。
- `AgentRegistry`(`./registry`)— 按工作区的定义缓存(`ensure` / `list` / `resolve`),惰性加载 `loadClaudeCodeAgents(root)`(用户层 + 项目层,项目遮蔽用户)。
- `registerTaskTool` / `TASK_TOOL`(`./tool`)— 注册 `subagent_fork` Task 工具。
- `mountAgentCatalog` / `CATALOG_SECTION_NAME` / `CATALOG_SECTION_ORDER`(`./catalog`)— 挂载 `Available subagents` section。

## 非目标

- `run_in_background` / continuable Task(follow-up)。
- seam 插件 agent 派发。
- 把 CC frontmatter 的 `permissionMode` / `isolation` / `memory` / `effort` 投影到 child(loader 会解析,v1 不消费)。
- cc-shell 里的 `registerBaseAgents`(base agent 发现迁至此处;见 cc-shell README)。
