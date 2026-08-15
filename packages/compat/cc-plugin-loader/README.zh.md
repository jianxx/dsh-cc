# @jianxx/dsh-cc-plugin-loader

[English](README.md) | 中文

加载 Claude Code 插件的 `plugin.json` 清单，并把每个组件挂载为内存中的 dsh 插件。

这个兼容性加载器读取 CC 插件清单子集，用 [`@jianxx/dsh-cc-skill-loader`](../../skill/skill-claude-code/README.md) 与 [`@jianxx/dsh-cc-claude-code-agents`](../../preset/claude-code-agents/README.md) 的纯函数翻译每个组件，并通过 `ctx.get(...)` 读取该组件的宿主 seam。它不是运行时：它产出类型化挂载与结构化报告，把执行交给它注册到的 seam。

## 加载器

`mountCcPlugin(ctx, { root, seams? })` 读取 `${root}/plugin.json`、校验清单子集，并把每个存在的组件作为 Cordis effect 挂载。它返回 `{ report, dispose }`——`report` 是每个组件的加载结果，`dispose` 回收所有已挂载组件（context 卸载时自动调用）。

### 清单子集

加载器校验 `name`（必填、kebab-case）、`version`、`description`、`author`，以及组件字段 `commands`、`agents`、`skills`、`hooks`、`mcpServers`、`settings`。格式错误的清单会在加载时携带插件名抛错。未知的顶层字段被忽略，与 Claude Code 的宽容处理一致。

### 组件及其 seam

每个组件都是 peer 风格：加载器通过 `ctx.get(...)` 探测宿主 seam，当该 seam 缺失时把组件报告为 `skipped`（绝不让整个加载失败）。

| 组件 | 来源 | Seam（探测） | 翻译 |
|---|---|---|---|
| `commands` | 清单内联或 source | `commands` | 通过 `register` 注册每个斜杠命令；handler 返回命令内容 |
| `agents` | `agents/` 目录或清单路径 | `subagents` | 通过 `loadAgentsDir` 加载 `AgentDefinition`，再通过 `registerProvider` 注册为命名 provider |
| `skills` | `skills/` 目录或清单路径 | `skills` | 通过 `discoverCcSkills` 发现 `SKILL.md`、解析 frontmatter，再通过 `register` 注册为运行时技能 |
| `hooks` | `hooks/hooks.json` 或内联 | `hooks`（guest）| 通过 `mergePluginHooks` 注入按事件组织的 hook 映射 |
| `mcpServers` | 内联记录或 `.mcp.json` | `mcp`（guest）| 通过 `registerServer` 注册每个 server（工具命名是 seam 的职责）|
| `settings` | 清单记录 | `settings`（guest）| 过滤到 allowlist（当前是 `agent`）后通过 `set` 写入 |

`hooks` 与 `mcp` seam 目前没有 harness 自有的服务；希望挂载这些组件的部署应提供 guest seam，否则它们会被报告为 `skipped`。

## 技能语义接线

在技能挂载之上，本包是把 `skill-claude-code` 的 metadata 转成可执行注册的 consumer：

- **`allowed-tools`** —— `skillToolRestriction(metadata)` 构建仅允许的 `tools.restrict()` 过滤器；`applySkillRestriction(metadata, agent)` 把它应用到 scoped agent 并返回 disposer。
- **`context: fork`** —— `resolveSkillExecution(metadata, subagentsPresent)` 把技能路由到子代理执行；当 subagent seam 缺失时降级为内联并被报告。
- **`paths`** —— `registerSkillPathActivator(ctx, skill, projectRoot)` 挂上用于条件激活的 `fs/observed` 路径激活器。
- **内联 shell** —— `activationFor(metadata, subagentsPresent)` 报告 `forbidInlineShell`（`shell: false` 的技能不得开启内联 shell）。

## 已知限制与待办工作

- **harness 中缺少 guest seam** —— 除非部署提供 guest seam，否则 `hooks`、`mcp`、`settings` 会报告为 `skipped`。当前没有 harness 自有的 `ctx.mcp` 或 `ctx.hooks` 服务。
- **agent provider 转发执行** —— agents provider 以名字命名其后端（默认 `fork`）并委托 `start`；执行 CC agent 需要 subagent seam 在运行时存在 `fork` 后端。
- **技能激活由宿主驱动** —— 加载器注册接线与激活描述符；在模型可见的时刻应用它们由宿主负责。
