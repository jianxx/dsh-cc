# @jianxx/dsh-cc-tool-web-fetch

CC 风格的 `web_fetch` 替代工具，带可选 `prompt` 参数。当 CC preset 将 `tool-web` 配置为
`fetch: false` 并在 `cc-services` 内挂载本包时，本包取代 stock `@deepseek-ai/dsh-tool-web`
的 `web_fetch`。

## 行为

- **不传 `prompt`**（或为空白）：与 stock 工具完全一致——返回原始转换后的页面文本。
- **传 `prompt`** 且已配置 `haiku` 模型别名（`ccModelRoutes.resolve('haiku')`）：
  抓取的文档经转换后与 prompt 一起送入该廉价 lane 上的一次性摘要调用，工具只返回提取结果。
  字符串形式别名（`haiku: deepseek-v4-flash`，仅 model）会从调用方 agent 的 request-header 继承缺失的 provider；
  没有调用方 agent（即无父 provider）时 prompt 被忽略（NOTICE）。
- **传 `prompt`** 但 `haiku` 别名未配置（无 `ccModelRoutes` 服务或 resolver 返回空）：
  跳过摘要调用。工具降级为返回带前缀
  `(prompt ignored: configure the haiku model alias to summarize WebFetch results)`
  的转换后页面。

摘要调用不携带 `purpose` 字段：harness `GenerateOptions.purpose` 是封闭联合
（`'compaction' | 'session-title'`）。摘要模型请求工具或未产出文本时，调用以
`isError` 工具结果失败。

## Provider 要求

stock dsh 部署**不挂载任何 fetch provider**：在部署组合进 provider 之前，
`ctx.web.fetch` 在执行时抛 `WEB_PROVIDER_UNAVAILABLE`（例如 `web-fetch-http` 到
0.1.1-rc.2 仍未交付）。本包不挂载 provider。测试通过 fake `ctx.web.fetch` 进行。

## Prompt 指引的相互影响

将 `tool-web` 设为 `fetch: false` 同时会从 `web_search` 的 system-prompt 段落中
移除 stock 的 "Follow up with web_fetch" 子句。本包重新注册 `tool:web_fetch`
段落（order 111）补齐 fetch 指引。

## 已知限制

- 无 host allowlist：挂载的 provider 可达进程能到达的任意 URL。仅在出口受限的
  部署上启用。上游 SSRF allowlist 仍是后续事项。
