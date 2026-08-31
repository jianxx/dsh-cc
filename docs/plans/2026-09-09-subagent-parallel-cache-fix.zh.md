# 修复方案 v2：subagent 并行化 + 缓存命中率归因诊断

> v1 经 deep-reasoner 冷审后重构。冷审结论：v1 的 headline 修复（fork persona 字节一致化）
> 在当前部署下收益为零——typed agents 全部带 model 覆盖（opus→zai/glm-5.3，
> sonnet→llmbox_ant/deepseek-v4-flash，fable→llmbox_ant/kimi-k3），跨模型缓存本不共享，
> 且 `{{model}}` 插值使"字节一致"对 model 覆盖型 child 永不成立。v2 按实证重构。

## 实证基础（~/.dsh/sessions 全量 482 会话取证）

| 模式 | 特征 | 实例 |
|---|---|---|
| 健康累积 | 稳态 readShare 95–99%，>15min 间隔才衰减 | kimi-k3 主链路（含 subagent child 0c22bbee 95.5%） |
| 单槽增量 | read(N+1)≈input(N)，readShare 恒 ~0.5 | xai_oauth/grok-4.6（879f94da 前段） |
| 无缓存计量 | read=0 且 write=0 全额计费 | failover 到 kimi-coding/k3-256k 的段（tui-5177 尾部） |
| TTL 衰减 | gap>15min → readShare 13–40% | 各健康会话的长间隔请求 |

结论：**kimi-k3 链路的 harness 缓存机制是健康的；"命中率低"可归因为
路由/上游缓存语义差异 + TTL + 结构性首请求 miss，不是单一 harness bug。**

## 并行问题结论

调度器/工具声明/流式解析三层均支持并发（实证：3 fork 同 step 2ms 内齐发、181s 后同时返回）。
真根因 = 模型不批量发射。当前路由走 anthropic-messages 方言，**无 parallel_tool_calls 字段
可发**（OpenAI completions 专有），协议层无需改动。唯一杠杆 = 提示层。

## 本期交付（全部在 dsh-cc，不碰 deepseek-harness）

### F1 提示层并行指引（CLAUDE.md）
- 编排节增加硬规则：N 个互相独立的委派必须在同一条 assistant 消息里一次发出全部
  subagent_fork；禁止无依赖串行 drip-feed。
- commit message 写明预期可观察行为变化（同 step 多 fork 占比上升），后续真实会话验证。

### F2 会话缓存归因分析器（cache-trajectory 新模块，TDD）
`packages/test-support/cache-trajectory/src/session-log-analysis.ts`：
- `analyzeSessionCache(events)`：逐请求折叠 usage（沿用 report.ts 的 disjoint 口径），
  按最近的 `request/context` 事件归因 provider/model；输出逐请求 readShare、gap、
  路由分解、gap 桶（<1m/1-5m/5-15m/>15m）命中率。
- 模式判定：`no-cache-accounting`（连续 read=0&write=0 段）、`single-slot`
  （read(N)≈input(N-1) 占比过半）、`healthy`（默认/累积）、`insufficient-data`。
- findings：人读结论（如"req 150-152 在 kimi-coding/k3-256k 上零缓存计量"）。
- `compareForkPrefix(parentEvents, childEvents)`：fork 父子首请求 `request/header` 的
  system/config 字节比较 + 首分歧字节偏移——钉住"plain fork 与父字节一致"的既有不变量，
  并诊断 typed fork 的分歧点（persona 位置）。
- bin 增加 `analyze-log <file|->`（支持 .zstd，经 zstd CLI 解压）与
  `compare-fork <parent> <child>` 子命令。

### F3 成功度量
- 分析器对 4 个已知签名会话的判定与人工取证一致（single-slot/no-cache/healthy/TTL）。
- 后续真实会话：同 step 多 fork 占比上升（F1 验证）；新会话可用 analyze-log 自检。

## 设计但不实施（记录在案）

- **fork personaDelivery 'message' 通道**（harness 侧）：仅在"typed agent 与父同路由"时
  才有收益；当前部署无此情形，且 persona 降 user 通道有行为风险（中途身份切换、
  compaction 稀释、指令层级弱化）。实施前需行为 A/B 门禁。对应 deepseek-harness #2124 子集。
- LLMBox `supportsLongCacheRetention`（1h TTL）声明：需先确认网关支持。
- toolFilter 落线、continuable fork、workflow fan-out 原语：另行立项。
- 子代理 spawn 无工具故障（2026-09 新实例）：独立排查。

## 执行序

1. worktree `worktree-fork-cache-diagnostics`（已建，deps 已 link）。
2. F2 测试先行（tests/session-log-analysis.spec.ts 红）→ 实现（绿）→ bin 接线。
3. F1 CLAUDE.md 指引。
4. vitest 包级 + 仓门禁（typecheck、check:size、check:exports）。
5. 分析器回读 4 个已知会话验证判定一致。
6. 分两个 commit（F2 代码 / F1 提示），message 写明可观察行为变化。
