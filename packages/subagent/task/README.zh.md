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

1. **`subagent_type` 省略、空白或为 `general-purpose`** → **全新 spawn**:prompt 文本成为 child 的首条 user message,无定义参与,不拷贝父对话。prompt 必须自包含。
2. **`subagent_type` 等于保留哨兵 `fork`** → 继承对话的 **fork**(Claude Code 的 `subagent_type: "fork"`):父已完成轮次作为 seed,无定义参与。哨兵优先于同名文件,`.claude/agents/fork.md` 不可达。
3. **命中会话 cwd(`cwdOf` 组装 agent)下的定义** → 以 `spawn` 启动并携带:
   - `persona` = 定义的 `systemPrompt`(作为 child 的系统段下发);
   - 任务文本作为 child 的**首条 user message**;
   - `agentOptions` = 来自 `ctx.get('ccModelRoutes').resolve(def.model)` 的别名解析结果 `{ provider?, model? }`(只透传解析到值的 provider/model 字段,绝不破坏按字段继承);
   - `toolFilter` = 定义的 `toolRestriction`(allow/deny),**消毒**掉本组合已不再注册的工具名;
   - `maxDepth` = 3(与 harness 默认一致;可配置)。
4. **其它类型**(工作区内找不到)→ **报错结果**,附带本工作区可用类型清单(或说明本工作区未定义任何 agent)。

运行是**前台一次性**:工具等待 child 跑完并返回其最终文本。非 `completed` 的 stop reason 以错误浮出,child 输出只拼接 `text` 块。

### 工具限制消毒与保留名

当定义 frontmatter 收窄工具(如 `tools: Read, Task`)时,allow/deny 清单会强制经过 CC→harness 翻译,再对照工具注册表**实时**已知的名集合(`ctx.tools.view(callingAgent).restrictableNames`——已注册与已保留名的并集,在 execute 时按调用 agent 的 scope 读取,因此 standing-scope 上的 MCP 保留名可见)做校验。注册表不认识的名会被丢弃并告警;这里没有静态合法名集合,因此已挂载的 MCP 工具和未来新增的注册行都无需改代码即可通过:

- **MCP 公开名。** 精确的 `mcp__<server>__<tool>` 原样保留——必须用该工具的公开名,包括名字被规范化截断/替换时追加的 12 位十六进制确定性 hash 后缀。
- **server 级 MCP 通配。** `mcp__<server>` 与 `mcp__<server>__*` 都会展开为该 server 已挂载的全部工具(`mcp__<server>__` 前缀),frontmatter 因此不必逐个点名带 hash 的条目也能在 server 发布新工具后继续生效。
- **裸 `mcp__`**(无 server 段)被丢弃并给出 invalid-wildcard 告警。
- **自动带上 `ToolSearch`。** 若过滤器带有 `allow` 清单、保留下来的 allow 名中有 MCP 工具、且 `ToolSearch` 工具本身已挂载(可限制),则追加 `ToolSearch`(去重)——否则 child 手握 MCP 名却没有任何加载路径。`ToolSearch` 未挂载时绝不注入。
- **未挂载的名被丢弃**,给出标准 `dropping unknown tool name …` 告警——包括未挂载 server 的 MCP 名。
- **匹配不到任何工具的 allow 清单 = 醒目的 deny-all。** 若过滤器带有 `allow` 清单而消毒后一个名都不剩,产出的过滤器是 `{ allow: [] }`(child 以零工具运行)并告警列出被丢弃的原始名——省略 `allow` 反而会把 child 放宽到全部工具。被清空的 `deny` 清单则直接省略。

本包注册内部工具名 `subagent_fork`,并经 `ctx.tools.reserve('subagent')` / `reserve('workflow')` 把这些名放进可限制 universe 而不暴露可见定义(CC frontmatter `Task` 的翻译是 `['subagent', 'subagent_fork']`,故即使 harness spawn 行被禁,`subagent` 也必须保持合法;`workflow` 为延后的 workflow 行保留)。由于消毒对照的是实时注册表而非静态清单,这些保留名和每个静态 CC 名(`read`、`bash` 等)只有在真正被保留/注册时才会存活——在 cc preset 中它们正是如此。定义同时省略 `tools` 与 `disallowedTools` 时不传 `toolFilter`,child 继承父的完整工具面(含 MCP schema)。

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
- **保留类型名。** `general-purpose` 与 `fork` 是哨兵,不是文件类型。工作区文件 `.claude/agents/fork.md` 不可达;`subagent_type: "fork"` 永远表示继承父已完成轮次。

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
