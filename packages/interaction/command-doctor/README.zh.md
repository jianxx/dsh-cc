# @jianxx/dsh-cc-command-doctor

[English](README.md) | 中文

面向用户的 `/doctor` 命令：输出包版本、settings 可达性以及各能力接缝挂载情况的环境自检（在能枚举列表的接缝上列出 LLM provider）。该插件通过 [`ctx.commands`](../../interaction/commands/README.md) 注册一个全局命令，因此每个已组合的命令适配器都能发现并执行它，无需模型轮次。

## 命令约定

| 输入 | 结果 |
|---|---|
| `/doctor` | 显示 harness 版本（来自本包 manifest）、settings 服务是否可达，以及每个能力接缝的挂载状态——`shell`、`subprocess`、`fs`、`skills`、`web`、`lsp` 与 `llm`。挂载时，`llm` 接缝还会列出其已注册的 provider id。 |

每一行都是对已挂载服务与版本元数据的纯读取；不发起模型调用，也不消耗 token。服务缺失的接缝报告为 `not mounted`。

## 组合

生产方注入 `commands`。自定义应用会挂载它的拥有者与此插件：

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: command-doctor
  name: '@jianxx/dsh-cc-command-doctor'
```

各接缝行反映真实组合，因此无头或极简应用只报告它实际挂载的内容。

## 模型体验

斜杠输入与直接的诊断输出都不会进入模型请求，也不消耗模型 token。呈现文本绝不会记录到日志中。

## 已知限制与暂缓事项

- **多数接缝仅做存在性检查**：只有 `llm` 暴露了公开的 provider 枚举；其他接缝只报告挂载／未挂载，不带 provider 列表。
- **版本来自包 manifest**：命令报告的是从其自身 `package.json` 读取的共享 harness 版本，而不是 `ctx` 可注入的版本。
