# @jianxx/dsh-cc-permission-rules

[English](README.md) | 中文

Claude Code 兼容的权限规则引擎。解析 `ToolName` 与 `ToolName(content)` 规则，在 `tools/pre-execute` waterfall 上收敛出感知模式的判定，并通过单调的 `guard()` 层强制执行 bypass-immune 内容规则——任何模式切换或 `bypassPermissions` 都无法翻盘。规则在加载期 fail loud；settings 通过重建合并状态并重注册 guard 实现热更新。

## 规则语法

规则形如 `ToolName`（整工具）或 `ToolName(content)`（内容级）。`content` 可用反斜杠转义 `(`/`)`/`\`，可用 `*` 作为通配符，也可用 `:*` 结尾声明前缀规则。

| 规则 | 含义 |
|---|---|
| `Bash` | 覆盖所有 `Bash` 调用的整工具规则 |
| `Bash(npm install)` | 前缀规则：任何以 `npm install` 开头的命令 |
| `Bash(npm publish:*)` | 对主干 `npm publish:` 的前缀规则 |
| `Edit(foo/*.json)` | 通配符：匹配 `foo/*.json` 的命令/路径（`*` 匹配任意片段） |
| `Bash(python -c "print\(1\)")` | 内容中的字面括号 |

畸形规则（括号未闭合、结束括号后有内容、只有内容没有工具名）在加载期抛出 `TypeError`——fail loud。`escapeRuleContent`/`unescapeRuleContent` 可安全往返内容（先 `\`，再括号）。

## 评估顺序

插件注册一个 `tools/pre-execute` 监听器，为每次调用收敛一个判定：

1. **Bypass-immune** 内容规则（例如 `.git` 内部、shell 配置文件路径）始终 deny——注册为单调 **guard**，模式切换或 `bypassPermissions` 都不能覆盖。
2. **整工具 deny** → deny。
3. **整工具 ask** → ask（当设置了 `exemptSandboxedBashFromToolAsk` 时，被沙箱限制的 `Bash` 豁免并直接 allow）。
4. **内容级 allow/deny/ask** 规则按来源优先级评估（最高优先级先；首个命中规则决定）。
5. **模式**短路：`bypassPermissions` 放行一切（除非 `disableBypassPermissionsMode`）；`acceptEdits` 自动放行文件编辑工具；`plan` 自动放行只读工具。
6. **整工具 allow** 是该工具的粗略默认——没有更具体的规则命中时放行。
7. **无命中** → passthrough 给下游监听器（最终到审批缝），后者仍可能 `ask`。

## 配置

```ts
import PermissionRules from '@jianxx/dsh-cc-permission-rules'

await ctx.plugin(PermissionRules, {
  rules: {
    deny: ['Bash(rm -rf)', 'Edit(.git*)'],
    bypassImmune: ['Edit(~/.bashrc)', 'Edit(~/.zshrc)'],
  },
  bashToolName: 'Bash',           // default
  fileEditTools: ['edit'],        // auto-allowed under acceptEdits
  readOnlyTools: ['read'],        // auto-allowed under plan
  exemptSandboxedBashFromToolAsk: false,
  defaultMode: 'default',
})
```

所有字段可选；服务 schema 应用图示默认值。规则字符串以 `config` 来源解析。

## settings 与热更新

当 `ctx.settings` 挂载时，插件注册 `permissions` 命名空间（`permissions.allow` / `permissions.deny` / `permissions.ask` / `permissions.defaultMode`）。settings 规则携带 `settingsSource` 标签（默认 `userSettings`），并按来源优先级与 Config `rules` 合并——settings 规则优先。存储变更会立即重跑合并并重注册 guard（热更新）；畸形 settings 规则在 settings 边界 fail loud。当 `ctx.settings` 缺席时，仅 Config `rules` 生效。

## 来源与模式

每条规则携带 `PermissionRuleSource`（`session` > `cliArg` > `policySettings` > `flagSettings` > `localSettings` > `projectSettings` > `userSettings` > `config`），用于内容规则的优先级。引擎在调用时解析生效模式：plan 激活（来自 `@deepseek-ai/dsh-plan-mode`）覆盖会话记录的 `permission/mode` 覆盖，否则回退到 `defaultMode`。

## 供宿主 UI 使用的纯导出

- `parseRuleString(rule)`、`parseRule(rule, behavior, source)`、`escapeRuleContent`/`unescapeRuleContent`——解析规则为 `PermissionRule`。
- `evaluatePermission(input)`——为一次调用收敛 `PermissionDecision`（`allow` / `deny` / `ask` / `passthrough`），给定工具、subject、规则集、模式与豁免标志。无需挂载插件即可预览某规则会命中什么。
- `mergeRuleSets(...sets)`——按来源优先级合并规则集。
- `foldPermissionMode(events)`——折叠会话记录的模式。
- `PERMISSION_MODES`、`SOURCE_PRIORITY`——封闭词汇表。

规则解析与评估是浏览器安全的（纯字符串逻辑），因此类型/解析/评估模块可干净地导入 UI 预览。

## Invariant 伴生插件

`@jianxx/dsh-cc-permission-rules/invariant` 拒绝任何值不属于封闭 `PERMISSION_MODES` 词汇表的 `permission/mode` 会话事件。

参见 [Agent Note](../../../.agents/notes/implemented/feature/2026-08-14-cc-permission-rules.md)。
