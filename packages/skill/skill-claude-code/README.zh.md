# @jianxx/dsh-cc-skill-loader

[English](README.md) | 中文

面向 Claude Code skill 格式兼容的 `ctx.skills` 注册表 Provider。

本包在 Claude Code 的目录布局（managed、project、user 与附加目录）中发现 `SKILL.md` skill，解析完整的 Claude Code frontmatter 规范，并通过 `@deepseek-ai/dsh-skill` 提供给 harness。它是一个兼容性 Provider：harness 可以消费为 Claude Code 编写的 skill，而无需复制执行它们的运行时。注册表仍位于 `@deepseek-ai/dsh-skill`；会话目录与加载器仍位于 `@deepseek-ai/dsh-tool-skill`。

## 插件

需要 `ctx.skills`（`inject: ['skills']`）。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `providerName` | `claude-code` | 用于在 `ctx.skills` 上注册此 Provider 的唯一名称。 |
| `dshHome` | `$DSH_HOME` 或 `~/.dsh` | 由 [`@deepseek-ai/dsh-home-paths`](../../util/home-paths/README.md) 解析的 harness 主目录；将其下的 `skills` 作为 user 根扫描。 |
| `managedDir` | — | 可选的托管策略根，在所有默认根之前扫描。 |
| `additionalDirs` | `[]` | 在 project 与 user 根之后追加的附加 skill 根。 |

## 发现

按以下优先级顺序发现根（rank 越小越优先处理同名冲突）：

| Rank | 来源 | 路径 |
|---|---|---|
| 100 | managed | `config.managedDir` |
| 200 | project | `<projectRoot>/.claude/skills` |
| 300 | user | `<dshHome>/skills` |
| 400 | additional | 每个 `config.additionalDirs` |

project 根是最近包含 `.git` 的祖先；若无则使用当前 cwd。skill 是目录包 `<name>/SKILL.md`；旧的 `.claude/commands/*.md` 文件也会被加载，并在元数据中标记为 `deprecated`。发现按真实路径去重，因此通过符号链接或重叠路径指向的同一文件只会被提供一次。

## Skill 格式

`SKILL.md` 被解析为与 Markdown 正文分离的 YAML frontmatter 文档。Provider 读取每个已知的 Claude Code 字段并容忍未知字段；已知字段的值无效时会在加载期响亮失败，而不是静默地错误激活。

支持的字段：`description`、`name`、`allowed-tools`、`argument-hint`、`arguments`、`when_to_use`、`version`、`model`（含 `inherit`）、`user-invocable`、`disable-model-invocation`、`context`（含 `fork`）、`agent`、`effort`、`shell`、`hooks` 与 `paths`。名称必须是 kebab-case 才能注册到注册表中。

## 语义翻译

Provider 原样解析并提供 Claude Code 字段；在激活时将它们应用到 harness 接缝是消费方的职责。本包导出的翻译器：

- `ccRestriction(allowedTools)` — 将 `allowed-tools` 转成仅允许（allow-only）的 `tools.restrict()` 过滤器（`*` 或空列表给出 `undefined`，因此该 skill 继承调用方的表面）。
- `ccPathMatcher(patterns)` / `registerPathActivator(ctx, ...)` — 将 gitignore 风格的 `paths` 转为条件激活：当 Read/Write/Edit 工具触碰匹配文件时，`fs/observed` 监听器触发 `onActivate`。
- `ccInvocation(parsed)` — 将 `disable-model-invocation` 与 `user-invocable` 解析为注册表的调用策略。
- `context: fork` — 以 `metadata.executionContext` 形式呈现；消费方将该 skill 与其渲染后的正文一起路由到 `ctx.subagents.start()`。

## 渲染

`renderSkillBody` 替换 `$ARGUMENTS`、`$ARGUMENTS[n]`、`$n`、命名 `$name` 占位符以及 `${CLAUDE_SKILL_DIR}` / `${CLAUDE_SESSION_ID}`，并将内联 shell `` !`...` `` 命令分段供调用方执行（由 `allowInlineShell` 门控，MCP 来源的 skill 必须强制关闭）。`estimateFrontmatterTokens` 只统计 name、description 与 `when_to_use` —— 发现期间从不统计正文。

## 已知限制与待办

- **语义翻译在消费方完成** —— `allowed-tools`、`context: fork` 与 `paths` 以元数据和辅助函数形式呈现，而非自动应用，因为 Provider 在加载时没有 agent 引用。
- **本包不执行内联 shell** —— 命令被提取并返回，执行是调用方的职责。
- **单层发现** —— 仅识别 `<root>/<name>/SKILL.md` 与旧的顶层 `.claude/commands/*.md`。
