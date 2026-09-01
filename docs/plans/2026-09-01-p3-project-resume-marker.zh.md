# P3：resume marker 按 projectKey 迁移（设计稿）

状态：评审通过（deep-reasoner approve-with-changes，F1–F5 已修入本稿；F6/F7 作为实现约束，见 §6）
前置：P0–P2 已合入主干方向（PR #65，`resolveProject` / `projects/<key>/` bucket / sidecar index 已存在）。

## 1. 背景与问题

当前（P0–P2 之后）的 resume marker 机制：

- **位置**：`$DSH_HOME/tui/resume-<sha256(resolve(cwd))[:16]>.txt`，按**精确 cwd** 分桶。
- **写方**：TUI `packages/ui/tui/src/resume-target.ts`（`writeResumeTarget` / `clearResumeTarget` / `readResumeTarget` / `resumeMarkerFile`），调用点：
  - `driver-agent.ts` `persistResumeTarget()`：resume 自愈 + 首个真实 prompt 后写入，key 用 `rt.cwd`（boot cwd）。
  - `driver.ts` boot：resume 失败（stale marker）时 `clearResumeTarget({ cwd })`。
  - `driver.ts` sessions ctx：`writeResumeTarget(id, { cwd })`，key 同样用 boot cwd。
- **读方**：launcher `bin/dsh-cc.js` —— 仅当 `DSH_CC_RESUME_SESSION` 未定义时读 `resumeMarkerPath(home, spawnCwd ?? process.cwd())`，写入 env 传给插件。hash 方案在 `bootstrap.mjs`（`resumeMarkerName`，JS）与 `resume-target.ts`（TS）**重复实现**，注释要求两边同步。
- **env 三态**：`DSH_CC_RESUME_SESSION` 非空 = resume 该 id；`''` = 显式 fresh（`--new` / 新建 worktree）；未定义 = launcher 已查过 marker、没有。

问题：

1. marker 按精确 cwd 分桶 —— 同一 repo 的 worktree 与主 checkout 不共享"上次会话"，违背 P0–P2 确立的 project 模型（worktree 属于同一 project）。
2. hash 方案 TS/JS 双份实现，同步靠注释。
3. marker 写入 key 用 boot cwd 而非 live session 的 project —— 从别的 project（Ctrl+A all 范围）切入的 session 会写错桶。
4. 读 marker 的逻辑在 launcher（无 TS、无 git probe 能力），无法做 project 解析。

## 2. 设计总览

**把 marker 的读取下沉到 TUI，key 改为 projectKey，launcher 瘦身为纯 flag 翻译。**

### 2.1 新 marker 位置与方案

- 路径：`$DSH_HOME/tui/projects/<projectKey>/resume.txt`（与 P1 history、P2 `sessions.txt` 同 bucket 目录）。
- `projectKey` 来自既有 `resolveProject(cwd)`（git common-dir probe；linked worktree → 主 checkout 根；非 git → `resolve(cwd)`）。
- `resume-target.ts` 内部对 `resolveProject` 按 `resolve(cwd)` 字符串做 module 级 memo（每进程每 cwd 至多一次 git probe）。

### 2.2 resume-target.ts API（options 形状为 `{ home?, cwd?, legacyCwd? }`）

| 函数 | 新行为 |
|---|---|
| `resumeMarkerFile(options)` | 返回**新** project 路径（导出，测试锁定方案） |
| `legacyResumeMarkerFile(options)` | 返回旧 `resume-<hash>.txt` 路径（导出，过渡 + 测试用） |
| `writeResumeTarget(id, options)` | **幂等**：新 marker 已等于 id 则跳过（dedupe 只看新 marker，不看 legacy —— F4 定案）。否则写新 marker（key = `resolveProject(options.cwd)`）；**同时双写 legacy marker**，key = `options.legacyCwd ?? options.cwd` 的精确 cwd 桶（F3 定案：driver 调用时传 `legacyCwd: <boot cwd>`，使 legacy 桶与旧 launcher 的读取点（launch cwd）对称；注释标注 transition-only，移除里程碑见 §2.8） |
| `readResumeTarget(options)` | 双读新 + legacy；**先过滤空文件（视为不存在），再比较 `statSync().mtimeMs`，新者胜，平局取新 marker**（F7 钉死顺序）；返回 id \| undefined |
| `clearResumeTarget(options)` | 两个文件都写 `''`（best-effort，语义与现状一致；legacy 侧 key 同样用 `legacyCwd ?? cwd`） |

非 git 目录下 `projectKey == sha256(resolve(cwd))[:16]`，与 legacy key 同值但路径不同（`projects/<key>/resume.txt` vs `resume-<key>.txt`），双读双写依然成立、无冲突。

### 2.3 TUI boot（plugin.ts + index.ts + driver.ts + cordis.patch.yml）

**F1① 修复（阻断）**：`packages/ui/tui/src/plugin.ts:32-34` 目前把 `sessionId === ''` 在进 `createDriver` 前丢弃（`undefined || length === 0 ? {} : …`），`--new` 的显式 fresh 哨兵根本到不了 driver。本 PR 改为**原样透传** `''`（`sessionId === undefined ? 不传 : 传 sessionId`），使下面的 case 2 真实可达；driver 侧相应地把 `''` 与 `undefined` 分开处理（`config.sessionId ?? random` 对 `''` 不生效，必须显式分支）。

DriverConfig（声明在 `packages/ui/tui/src/index.ts` 的 `Config` 接口 + Schema，`plugin.ts` 逐字段转发给 `createDriver` —— **两个文件都必须改，否则新配置到不了 driver**，F2）新增两个可选字段：

```ts
autoResume?: boolean        // 允许 boot 时读 project marker
continueRequested?: boolean // -c/--continue，仅影响"无可继续会话"提示
```

`cordis.patch.yml` 的 tui config 增加（`!!js` 表达式在 env 未设时求值为 `undefined`/不抛错，已核实宿主 eval 方言可行；实现后跑一次 `dsh --dump-config` 冒烟确认）：

```yaml
autoResume: !!js process.env.DSH_CC_AUTO_RESUME === '1'
continueRequested: !!js process.env.DSH_CC_CONTINUE === '1'
```

boot 会话解析优先级（driver.ts）：

1. `config.sessionId` 非空 → resume 该 id（显式 `--resume`，现状不变）。
2. `config.sessionId === ''` → fresh（显式 `--new` / 新建 worktree；**不读 marker**）。
3. `config.sessionId === undefined && config.autoResume === true` → `readResumeTarget({ cwd })`：
   - 命中 → 走现有 resume 路径（含 stale 自愈：失败后 `clearResumeTarget` 现在会双清）。
   - 未命中且 `continueRequested` → `showNotice('没有可继续的上一会话，可 /resume 手动选择')`。
4. 否则 → fresh。

`autoResume` 默认 false —— 直接 `dsh --profile tui`（不经 launcher）与既有测试套件**零行为变化**（不会读写真实 `~/.dsh`；已逐一 grep 核实全部 26 个 driver spec 均隔离 DSH_HOME，回归风险可控）。

### 2.4 marker 写入 key 修正（顺带修 P2 遗留偏差 + F3/F4 定案）

- `driver.ts` sessions ctx：`writeResumeTarget: (id) => writeResumeTarget(id, { cwd: current.agent.session.header.cwd ?? cwd, legacyCwd: cwd })` —— 新 marker 落入**session 自己**的 project 桶（从其他 project 切入的 session 不写错桶）；legacy 双写落在 **boot cwd** 桶（F3：与旧 launcher 的读取点 `spawnCwd ?? process.cwd()` 对称，常见路径——同目录重启——完全兼容；跨目录 session 的 legacy 桶偏差为已知边角，见 §2.7 矩阵脚注）。
- `driver-agent.ts` `persistResumeTarget`：同样改用 live `current.agent.session.header.cwd ?? rt.cwd` + `legacyCwd: rt.cwd`；**删除现有的 read-比对-dedupe**（`readResumeTarget(...) === id` 预检），dedupe 下沉进 `writeResumeTarget` 内部且只比对**新 marker**（F4：双读可能返回 legacy 侧旧 id 导致跳写语义未定义，下沉后无歧义）。
- `driver.ts` boot stale 自愈的 `clearResumeTarget({ cwd })` 不变（cwd 即 boot cwd，双清覆盖 legacy 同桶）。

### 2.5 launcher（bin/dsh-cc.js + bootstrap.mjs）

**bin/dsh-cc.js**：

- 删除 marker 读取块（现 122–131 行）与 `resumeMarkerPath`、`continueHint` import。
- **F1② 修复（阻断）**：入口处（解析任何 flag 之前）**无条件**从 `env0` 删除继承的 `DSH_CC_RESUME_SESSION`、`DSH_CC_AUTO_RESUME`、`DSH_CC_CONTINUE` —— 父 TUI 进程环境带着 launcher 设置的 `DSH_CC_AUTO_RESUME=1`，从 TUI 内再跑 `dsh-cc --new`/`--worktree` 时继承值会击穿 autoResume 门控（`--new` 被忽略、自动 resume）。入口清洗后，这三个变量只由 bin/interceptResume 依据本次 argv 重新推导；`--worktree` 分支里现有的 `delete env0.DSH_CC_RESUME_SESSION` 变为冗余，删除之。
- `DSH_CC_RESUME_SESSION` 未定义时不再设置它 —— 是否 resume 由 TUI 依据 `DSH_CC_AUTO_RESUME` 自行决定。

**bootstrap.mjs**：

- `interceptResume`：解析完优先级后，若 `nextEnv.DSH_CC_RESUME_SESSION === undefined`，设 `nextEnv.DSH_CC_AUTO_RESUME = '1'`（"显式 flag 抑制 marker resume"编码在这一个纯函数里，可测）。`-c`/`--continue` 额外设 `nextEnv.DSH_CC_CONTINUE = '1'`。
- 删除 `resumeMarkerName`、`resumeMarkerPath`、`continueHint` 导出及不再使用的 `createHash` import。
- worktree 流程语义不变（实现代码微调）：新建 worktree 仍设 `DSH_CC_RESUME_SESSION=''`（= 显式 fresh，跳过 marker）；复用已有 worktree → env 未定义 + AUTO_RESUME=1 → TUI 读 project marker → resume 该 project 最近会话（符合 project 模型）。

**launcher/tui/README.md**：更新 env 契约说明（marker 读写全部归属 TUI；`DSH_CC_AUTO_RESUME` / `DSH_CC_CONTINUE` 语义）。

### 2.6 `-c/--continue` 语义变化

今天 `-c` = "从 marker resume；没有则 stderr 提示"。P3 后裸 `dsh-cc` 已默认从 project marker resume，`-c` 退化为语法糖，唯一可观察差异是"无可继续会话"提示 —— 从 launcher 的 stderr 一行变为 TUI notice（launcher 已无力知道 marker 是否存在，这是读取下沉的直接代价）。`-c` 继续被接受并从转发参数中剥离，行为兼容。

### 2.7 兼容性矩阵

| launcher | TUI 插件 | 结果 |
|---|---|---|
| 新 | 新 | project marker 生效，正确 |
| 旧 | 新 | 旧 launcher 读 legacy marker；新 TUI 双写 legacy（key = 写进程的 boot cwd，与旧 launcher 读取点对称）→ 常见路径（同目录重启）正常工作。已知边角：跨目录 resume 的 session（header.cwd ≠ boot cwd）legacy 桶落在 boot cwd 而非 session cwd，旧 launcher 在 session 原目录重启会读到过期值 —— 瞬态混合版本的次要偏差，接受（F3 定案） |
| 新 | 旧 | 旧 TUI 拿不到 env → 失去自动 resume；`/resume` 手动可用。**接受的降级**：profile 安装时插件版本与 launcher 锁定（`bootstrapCommand` 用 `ownVersion`），只有"升级 launcher npm 包但不重装 profile"才会命中；README + release note 说明，恢复方法 = 重装 profile 或 `/resume` |
| 旧 | 旧 | 不变 |

**回滚**：revert 本 PR → 旧 launcher 读 legacy marker，而新 TUI 一直在双写 legacy → 无缝。

### 2.8 遗留 legacy marker 的生命周期

不主动删除旧文件。双读保证旧文件被尊重（mtime 新者胜）；双写保证旧 launcher 可用；`clearResumeTarget` 双清。注意（F5 事实修正）：`--new` 只设 env 哨兵、**不落盘清任何 marker**；TUI 也不存在 `/new` 命令（`resume-target.ts:53` 的注释是陈旧的，随重写一并更正）。旧 marker 在新 session 首个真实 prompt 后被双写覆盖。

**legacy 双写的移除里程碑（开放问题 2 定案）**：单仓同时控制 launcher 与插件、profile 安装按 `ownVersion` 锁版本，混合版本只在"升级 launcher npm 包但不重装 profile"时出现 —— 双写保留到**下一个 minor（0.4.0）**后移除，代码注释标注 `TODO(0.4.0)`，合并本 PR 后开 tracker issue 跟踪。

## 3. 影响文件清单

| 文件 | 改动 |
|---|---|
| `packages/ui/tui/src/resume-target.ts` | 新方案 + 双读/双写/双清 + `legacyCwd` + 幂等写；模块头注释与 `clearResumeTarget` 陈旧 jsdoc（"`/new`"）一并更正 |
| `packages/ui/tui/src/project.ts` | `resolveProject` 加共享 memo（keyed by `resolve(cwd)`）+ `__clearProjectCache()` 测试钩子（F6） |
| `packages/ui/tui/src/index.ts` | `Config` 接口 + Schema +`autoResume?`、`continueRequested?`（F2） |
| `packages/ui/tui/src/plugin.ts` | `sessionId` 透传 `''`（F1①）；逐字段转发 `autoResume`/`continueRequested`（F2） |
| `packages/ui/tui/src/harness/driver.ts` | boot autoResume/continue 状态机（`''` 显式分支）；sessions ctx `writeResumeTarget` key 修正（header.cwd + legacyCwd=boot cwd） |
| `packages/ui/tui/src/harness/driver-agent.ts` | `persistResumeTarget` key 修正（live session cwd）；删预检 dedupe（下沉 writeResumeTarget，F4） |
| `packages/bundle/cc-tui/cordis.patch.yml` | +`autoResume`、`continueRequested` |
| `packages/launcher/tui/bootstrap.mjs` | `interceptResume` 新 env 契约；新增纯函数 `sanitizeInheritedEnv(env)`（删三个继承变量，可测）；删 `resumeMarkerName`/`resumeMarkerPath`/`continueHint` 及 `createHash` import |
| `packages/launcher/tui/bin/dsh-cc.js` | 入口调 `sanitizeInheritedEnv`；删 marker 读取块与 hint 调用；删 `--worktree` 分支冗余的 env delete |
| `packages/launcher/tui/README.md` | env 契约文档（含直连 `dsh --profile tui` 与 env 泄漏防护说明） |
| `packages/ui/tui/tests/resume-target.spec.ts` | 重写（新方案 + 双读 mtime + 双写 + 双清 + worktree 共桶 + 幂等 dedupe） |
| `packages/ui/tui/tests/project.spec.ts` | +memo 行为与 `__clearProjectCache` 用例（互异 cwd，避免同 worker 污染） |
| `packages/ui/tui/tests/driver-resume-marker.spec.ts` | 扩展（autoResume 门控、`''` 显式 fresh、stale 双清自愈、key 修正） |
| `packages/launcher/tui/tests/bootstrap.spec.ts` | 更新 interceptResume 契约；+`sanitizeInheritedEnv` 用例；删 continueHint 用例 |
| `packages/launcher/tui/tests/worktree.spec.ts` | 删 `resumeMarkerName`/`resumeMarkerPath` 锁定用例 |

pi-tui 不动。`packages/interaction/command-resume` 不动（P4 范围）。

## 4. 测试计划（TDD：先写失败测试，再实现）

### 4.1 resume-target.spec.ts（重写）+ project.spec.ts（加用例）

- 新 marker 路径 = `projects/<sha256(resolve(repoRoot))[:16]>/resume.txt`（真 git repo tmpdir + worktree 共桶：repo 根与 linked worktree 解析出同一路径）。
- 非 git 目录：key == `sha256(resolve(cwd))[:16]`，落 `projects/<key>/resume.txt`。
- 双读（顺序钉死：blank-filter → mtimeMs → 平局取新）：仅 legacy 有值 → 返回 legacy；两侧都有 → mtime 新者胜；mtime 相同 → 新 marker 胜；"更新但为空"的 legacy + 较旧非空新 marker → 返回新 marker 的值；两侧皆无/皆空 → undefined。
- 双写：write 后新、legacy 两文件内容一致；`legacyCwd` 与 `cwd` 不同（跨目录 session）时 legacy 落 `legacyCwd` 桶、新 marker 落 `cwd` 的 project 桶。
- 幂等（F4）：新 marker 已等于 id 时 write 是 no-op（文件 mtime 不变，即使 legacy 侧是旧 id）；不等时才双写。
- 双清：clear 后两文件均为空，`read` 返回 undefined。
- project.ts memo：同 cwd 重复调用只 probe 一次（注入计数 exec）；`__clearProjectCache()` 后可重新 probe。git fixture 用例全部使用互异 cwd（防同 worker memo 污染）。
- `home` 注入隔离全部文件 IO。

### 4.2 driver-resume-marker.spec.ts（扩展，DSH_HOME 隔离强制）+ plugin 透传测试

- `sessionId === undefined` 且无 `autoResume` → 不读 marker（既有行为，回归锁）。
- `autoResume: true` + marker 命中 → boot resume 该 session。
- `autoResume: true` + marker 缺失 + `continueRequested: true` → fresh + notice。
- `sessionId === ''` + marker 存在 + `autoResume: true` → fresh（显式 --new 优先于 marker；锁 F1① 透传后的 driver 分支）。
- stale marker：resume 失败后新、legacy 两 marker 都被清空。
- 写入 key 修正：boot cwd 在 repo 根、session header.cwd 在 linked worktree → 新 marker 落 worktree 所属 project 桶、legacy 落 boot cwd 桶。
- plugin.ts 透传（F1①/F2）：`sessionId: ''` 原样传给 createDriver（不再被丢成 undefined）；`autoResume`/`continueRequested` 字段透传。用例位置随 plugin 现有测试惯例（若无 plugin.spec 则在 driver 层以 config 直传覆盖，并在 index.ts Schema 层加字段声明用例）。

### 4.3 launcher 测试

- `bootstrap.spec.ts`：无 flag → `DSH_CC_AUTO_RESUME=1` 且 `DSH_CC_RESUME_SESSION` 不设置；`--new` → `''` 且不设 AUTO_RESUME（显式优先）；`-c` → `DSH_CC_CONTINUE=1` + AUTO_RESUME；`--resume=x` → env=x 且不设 AUTO_RESUME；删除 continueHint 全部用例。
- `sanitizeInheritedEnv`（F1②）：含三个继承变量的 env → 全部被删；不含 → 原样；其它变量不受影响。
- `worktree.spec.ts`：删 `resumeMarkerName`/`resumeMarkerPath` 用例。

### 4.4 验证门槛

- `pnpm vitest run`（tui + launcher 包全绿）、`tsc -b build`、`check:size`、`check:vendor-purity`。
- 手工 e2e smoke（合入前）：目录 A 输入 prompt → `dsh-cc --worktree` 复用 session → 在 A 裸 `dsh-cc` 自动 resume 该项目最近 session；`--new` 后裸启动 resume 新 session；`-c` 空 marker 出 notice。

## 5. 开放问题（评审已定案）

1. **空 legacy 视为不存在 —— 接受。** 旧 launcher 对空 marker 本就忽略（`marker.length > 0` 才使用），语义等价。
2. **legacy 双写设定移除里程碑**：保留到下个 minor（0.4.0），代码注释 `TODO(0.4.0)` + tracker issue。
3. **`-c` 提示移到 TUI notice —— 接受**（notice 落在用户正看的界面，优于一闪而过的 stderr）。措辞指向 `/resume`。
4. **env 泄漏 —— launcher 入口清洗三个变量（F1②）+ README 文档**；TUI 侧不加防护（无法区分泄漏与契约注入）。
5. **`resumeMarkerFile` 语义改变 —— 接受**（仓库内唯一消费者是其 spec）。

## 6. 实现约束（评审 F6/F7 + 冒烟项）

- **F6**：`resolveProject` 的 memo 放在 `project.ts`（共享，driver 现有 ≥4 处调用同享收益），keyed by `resolve(cwd)`；附 `__clearProjectCache()` 测试钩子。resume-target 不私有缓存。
- **F7**：双读顺序钉死为 blank-filter → `mtimeMs` 比较 → 平局取新 marker。
- `clearResumeTarget` 的旧 jsdoc（提到 `/new`）与模块头注释（"launcher feed it back"）随重写更正。
- 实现完成后跑一次 `dsh --dump-config`（或等效冒烟）确认 cordis `!!js` 新字段解析。
- 合并后：开 "remove legacy resume marker dual-write in 0.4.0" tracker issue。
