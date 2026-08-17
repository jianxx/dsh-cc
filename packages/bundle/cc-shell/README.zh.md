# dsh-cc-bundle-shell

[English](README.md) | 中文

CC 壳层的 **host-plane infra** 组合包。本包承载真正属于宿主层的部件——带 deferred-name 支持的 tools 注册表替换、settings-migrations 机制——以及 `cc-shell-glue` 插件的*代码*(glue 代码仍住在这里,但挂载动作由 CC preset 执行,而非本包的 patch)。所有 agent-face 组合——tool-search、skill loader、memory、coordinator、worktree/sleep/notebook/structured-output 工具、19 个斜杠命令、hook 桥、output-style 渲染——都已迁至 [`@jianxx/dsh-cc-preset-cc`](../../preset/cc/README.md) 组合包,以便按 preset 隔离,而不是泄漏进每个模式。

## 作用

- **tools 注册表替换。** 禁用 in-box 的 `tools` 行,重挂 `@jianxx/dsh-cc-tools`。`reserve()`/`isAdmitted()` 加入可限制名 universe,权限门可在 deferred 工具加载前按名门控;其余行为与上游一致。基础行的 `DSH_TOOLS_MODE` 开关被延续($DSH_HOME / process.cwd() 语义不变)。
- **settings 迁移。** 挂载 `@jianxx/dsh-cc-settings-migrations`,在启动时应用版本门控的 `settings.json` 迁移(等价于 CC 的 `runMigrations`)。当前为空注册表——仅机制。
- **glue 插件代码(由 CC preset 挂载)。** `cc-shell-glue` 挂载 cordis patch 行无法静态表达的部件:磁盘上的 Claude Code 插件目录(每个含 `plugin.json`,提供 agents/skills/commands/hooks/mcp servers)、`.mcp.json` server 接线,以及基础 CC agent preset 目录(`~/.claude/agents` + `<cwd>/.claude/agents`)。发现为尽力而为——每个缺失路径都只是不挂载任何东西。它还暴露 `ccPlugins` 服务,用于对已挂载插件做实时枚举/重扫。

## 已知限制 / 说明

- 本包不再全局挂载任何 agent-face 表面。只有 host-plane infra 行(tools 注册表替换 + settings-migrations)由本包的 `cordis.patch.yml` 挂载;glue 插件与所有 agent 表面由 `@jianxx/dsh-cc-preset-cc` 挂载,从而限定在该 preset 内。
- 由于 tool-web executor 行在 rc.6 之前未被 CLI 依赖树携带,基于 fetch 的 web 工具由 preset 挂载而非此处;当前 fetch 状态见 preset 的「已知限制」。
