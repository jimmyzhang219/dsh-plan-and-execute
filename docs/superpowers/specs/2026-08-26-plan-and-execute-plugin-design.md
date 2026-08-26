# Plan-and-Execute 插件设计规格

- 日期：2026-08-26
- 状态：已与用户逐节确认
- 目标宿主：DeepSeek Harness（dsh），源码位于 `~/git/deepseek-harness`，从源码运行（`pnpm dsh web`）
- 插件工程：本仓库（`/Users/jimmy/VSCodeProjects/dsh-plugin/plan-and-execute`）

## 1. 背景与目标

dsh 内置的 `ReactLoopAgent`（`packages/core/agent-loop`）提供完整的 ReAct 循环。本插件在其上叠加一层 **Plan-and-Execute 编排**：先规划（与用户反复确认计划），再按批准的计划逐步执行（默认无人值守，可配置确认点），全程支持 Human-in-the-Loop（HILT）。

dsh 已有的 `plan-mode`（`packages/plan/plan-mode`）是一种"协作状态"模式（规划期只读 + `exit_plan_mode` 审批），**不含**阶段状态机与按步执行编排。本插件与它互斥（见 §5.1），但大量借鉴其已验证的实现模式：log 折叠状态、检查点工具、`userQuestions` 审批 + 反馈回传。

## 2. 硬性约束

1. **禁止更改任何 dsh 仓库文件**——只通过公开插件机制交互。
2. **遵守 dsh 插件机制**——函数形式插件（`apply(ctx)`），经 `--patch` overlay 装载；正式安装走 `dsh plugin --profile <name> add`（`package.json > dsh.bundle.patch`）。
3. **Plan 与 Execute 两阶段与 LLM 的交互全部委托给 ReactLoopAgent**——插件自身永不直接调用 LLM，只通过 `agent.steer()/inject()` 注入指令、通过工具回调与 session 事件感知进展。
4. 触发方式：斜杠命令 `/plan-and-execute`（符合命令名规则 `^[a-z][a-z0-9_-]*$`）。

## 3. 需求决策记录

| # | 议题 | 决策 |
|---|---|---|
| 1 | 编排位置 | **主会话内编排**：插件驱动用户正在对话的主 agent（runtime root），`userQuestions` 全程可用 |
| 2 | HILT 形态 | **关键节点确认**：默认仅"计划批准 + 全部完成"两处强制交互，步间无人值守自动执行；确认点可配置（manifest 单步 `requiresConfirmation` 标记） |
| 3 | 计划产物 | **manifest + 每步一个 Markdown 文件**：控制流（顺序/确认点）在轻量 JSON manifest，内容（目标/做法/验收）在文件，长计划不受工具参数 token 上限约束；用户可在暂停时手改步骤文件，注入时重读生效 |
| 4 | 步骤失败策略 | **分层**：LLM 请求级错误走 dsh `agent/request-error` 内建重试；步骤级失败默认暂停问人，可配置 `auto-recover`（自愈次数有上限，超限升级暂停）；结构性问题（文件悬空）一律暂停 |
| 5 | 中途干预 | 用户执行中直接发话 = 原生 steer 语义（进入当前步）；取消按钮 = 中止当前步并进入暂停交互；**不提供**任何辅助子命令（退出 = 暂停交互选"终止"） |
| 6 | 进度显示 | 主载体为 dsh 现成 todo 系统：插件在编排边界追加 `todo/write` 事件，会话界面 TodoPanel 自动渲染；轨迹页承载过程明细（免费）；不新增客户端 UI |
| 7 | 重启恢复 | 恢复时问一次（断点续跑以"步"为原子单位） |

## 4. 总体架构

### 4.1 组件构成（单插件包，函数形式）

| 组件 | 机制 | 职责 |
|---|---|---|
| `/plan-and-execute` 命令 | `ctx.commands.register` | 入口：前置校验、启动编排 |
| Orchestrator | 插件内部，`WeakMap<Session, Orchestrator>` | 状态机 + 步进驱动循环 |
| `submit_plan` 工具 | `ctx.tools.register(defineTool)` | Plan 阶段：提交 manifest、触发审批 |
| `report_step` 工具 | 同上 | Execute 阶段：汇报单步结果（done/blocked） |
| `pae:planning` / `pae:executing` prompt sections | `ctx.systemPrompt.section`（按折叠状态显隐） | 阶段行为约束 |
| `pae/state`、`pae/plan`、`pae/step-report` 会话事件 | `SessionEventMap` 合并声明（log-only） | 控制流持久化 |
| `todo/write` 会话事件 | 借用 dsh 现有事件词汇（payload 与 `tool-todo` 一致） | 进度展示 |
| 人机交互 | `ctx.get('userQuestions')?.ask`（机会式，非硬依赖注入） | 计划审批 / 确认点 / 暂停选项 / 恢复确认 / 完成通知 |

### 4.2 编排状态机

```
idle ──/plan-and-execute 任务──▶ planning ──批准──▶ executing ──全部完成──▶ completed
                                   ▲  │(审批未过+反馈     │ ▲
                     回到计划(重规划)─┘  │ 回模型修改)      │ │
                                   └── loop ◀──┐       ▼ │
                                                └── paused ◀┘
paused 触发源：步骤失败(默认) / requiresConfirmation 步前确认 / 用户取消当前步 / 重启后恢复确认
paused 选项：重试该步 · 跳过该步 · 继续下一步 · 回到计划阶段 · 终止
```

- **planning 内循环**（"与用户反复交互直到确认"）：模型写步骤文件 → 调 `submit_plan(manifest)` → 审批弹窗 → 未过则反馈作为工具错误回给模型 → 修改后再提交 → 循环，直到 Approve 或用户放弃。
- **executing 步进循环**：编排器逐步 `steer` 步骤指令 → `await agent.whenIdle()` → 依据 turn 结束原因 + `report_step` 事件判定 → 更新 todo → 下一步 / 暂停。
- **paused 是一等状态**：所有中断汇入同一交互（五选项）；恢复确认复用同一交互。
- **replan**：从 paused 选"回到计划阶段"进入 planning，已有计划上下文保留，模型修改步骤文件后重新走审批（追加新 `pae/plan`）。

### 4.3 驱动原则

插件永不调用 `ctx.llm`。所有模型交互由 ReactLoopAgent 完成；插件只做三件事：注入指令消息（`createUserMessage`，`source: {kind:'plugin', plugin:'plan-and-execute', form:'instruction', summary}`）、注册工具、折叠 session 事件。

## 5. Plan 阶段

### 5.1 命令入口

`/plan-and-execute <任务描述>`，handler（收 `CommandInvocation{agent, rawInput, signal}`）前置校验，任一不满足即返回 `{kind:'error', text}` 且不启动：

1. `ctx.get('userQuestions')` 存在（headless 无审批通道则拒绝启动）；
2. `agent.status === 'idle'`（忙则提示稍后再试）；
3. 折叠态检查：`planning`/`executing` 中 → 报错"编排进行中"；`paused` → 重新弹出暂停交互（额外恢复入口）后返回；
4. plan-mode 未激活（`foldPlanMode` 为真 → 报错并提示先 `/plan off`；两者 prompt 相互干扰，互斥最干净）。

通过后：append `pae/state{phase:'planning', task, planDir}` → `agent.steer(规划启动指令)` → 返回 success（编排器在后台 fiber 运行）。

**planDir**：`<config.planDir 默认 '.pae'>/<sessionId>/<runToken>`，runToken 为启动时间戳（如 `20260826-1530`），同一会话多次编排互不冲突。

### 5.2 `pae:planning` prompt section

按折叠状态显隐（`context.agent` 折叠出 `planning` 才渲染），要点：

- 先用只读工具充分调研，再制定分步计划；步骤可独立执行、可验证、粒度适中；
- 每步写一个文件到 `<planDir>/step-NN-<slug>.md`：目标 / 涉及文件 / 做法 / 验收标准；
- `requiresConfirmation` 用于标记风险步骤（不可逆、外部影响、大范围写操作）；单步计划合法；
- 本阶段不做变更性操作，写文件仅限 planDir（软约束；硬底线是 dsh 工具审批体系）；
- 完成后调用 `submit_plan` 提交。

### 5.3 `submit_plan` 工具

参数（JSON schema 由 `defineTool` 声明）：

```
steps: [{ file: string   // 相对 planDir 的文件名
        , title: string
        , requiresConfirmation?: boolean }]
summary?: string
```

执行逻辑：

1. **校验**：会话折叠态为 `planning`（否则工具报错"仅规划阶段可用"）；每个 file 存在、可读、非空（悬空 → 报错回模型自行修复）。
2. **审批**：读取各文件内容，`userQuestions.ask`：复用 `plan-review` intent；detail 渲染步骤清单（标题 + 文件 + 确认点标记）；选项 **Approve** / **Keep planning**（支持自定义反馈文本）。
3. **Approve**：append `pae/plan`（manifest 全量 + planDir）+ `pae/state{phase:'executing', stepIndex:0}` + `todo/write`（全部 pending）→ 返回 `{approved: true}`。在工具执行内 append 事件是既有模式（`tool-todo` 即如此）。
4. **Keep planning**（含反馈）：抛错（错误文本 = 反馈或"用户要求继续修改计划"）→ 模型收到工具错误 → 修改 → 再提交。
5. **弹窗被 dismiss**（`UserQuestionError` code `ASK_CANCELLED`）：抛错"用户搁置了审批，停留规划阶段，等待用户消息"（照 plan-mode 模式）。

带 `presentCall`/`presentResult` 卡片渲染（`card:'generic'`，标题取计划 summary 或首个 heading）。

## 6. Execute 阶段

### 6.1 步进循环

对 manifest 自 `stepIndex` 起的每一步 `i`（1-based 共 N 步）：

1. 若 `steps[i].requiresConfirmation` → 弹确认点："即将执行第 i/N 步 `<title>`"，选项 继续 / 跳过 / 回到计划 / 终止；
2. manifest 文件存在性校验（悬空 → 暂停，结构性问题不自动处理）；
3. append `pae/state{executing, stepIndex:i}`；`todo/write`：第 i-1 步 completed、第 i 步 in_progress；
4. `steer` 步骤指令："执行计划第 i/N 步 `<title>`，完整内容见 `<planDir>/<file>`，先读取该文件；完成或受阻都必须调用 `report_step` 汇报"；
5. `await agent.whenIdle()`，折叠判定（自注入点之后的 turn/end 原因 × log 中 `pae/step-report` 事件）：

| 情形 | 动作 |
|---|---|
| turn aborted | 用户取消 → paused |
| turn error / max-tokens | 步骤失败 → 失败策略（§6.3） |
| `report_step(done)` | 成功 → 下一步 |
| `report_step(blocked)` | 步骤失败 → 失败策略 |
| turn completed 但无 report_step | `steer` 追问一次"请调用 report_step 汇报该步结果"；仍无 → 按失败处理 |

全部完成 → `pae/state{completed}` + `todo/write` 全 completed + 完成弹窗（各步 summary 汇总，选项"知道了"）。

### 6.2 `report_step` 工具

参数：`{outcome: 'done'|'blocked', summary: string, artifacts?: string[]}`。

执行：校验会话折叠态为 `executing` 且为本步 → append `pae/step-report{stepIndex, outcome, summary}` → 返回确认。`blocked` 不抛错（让 turn 自然结束），由编排器走失败策略。

### 6.3 失败策略

- 默认 `pause`：paused 弹窗（五选项）。
- 配置 `auto-recover`：`steer` 失败上下文（turn 结束原因 / blocked summary）+ "自行调整重试，或修改后续步骤文件，然后重新 `report_step`；确无法完成则 `report_step(blocked)`"；同一失败步自愈计数 > `maxAutoRecoveries` → 升级 paused。

### 6.4 `pae:executing` prompt section

要点：只做当前步，不做后续步骤的事（除非本步文件明确要求）；结束前必须 `report_step`；如实汇报，不谎报 done；todo 清单由插件维护，**不要调用 `todo_write`**（整表替换语义会互相覆盖；每个步骤边界插件会重写正确状态，漂移自愈）；发现计划有误时在 summary 说明或 blocked，改计划走暂停，不自行跳步。

## 7. 持久化、恢复与进度

### 7.1 会话事件（log-only，控制流全在 log）

| 事件 | 写入时机 | 负载 |
|---|---|---|
| `pae/state` | 每次状态迁移 | `{phase, task?, planDir?, stepIndex?, pausedReason?}`；整值替换，last-wins 折叠（同 `plan/mode`） |
| `pae/plan` | 每次审批通过 | manifest 全量；replan 追加，折叠取最后 |
| `pae/step-report` | 每次 report_step | `{stepIndex, outcome, summary}` |
| `todo/write` | 编排边界 | TodoItem 列表，payload 结构以 dsh-session 类型为准；不依赖宿主是否组合 tool-todo，UI 从事件渲染 |

**分工：log 管控制流，文件管内容**；步骤内容在注入时由 agent 重新读文件（用户暂停期间手改自动生效）；"批准后文件被改"不触发重新审批（除非该步带确认点）——特性而非缺陷。

### 7.2 恢复

插件监听 `agent/created`（含 resume 重建），折叠 `pae/state`：

- `planning` / `executing`（进行中但无 driver）→ 弹恢复确认："执行到第 i/N 步 — 从断点继续 / 回到计划 / 终止"。**续跑以"步"为原子单位**：重新注入当前步指令，步内已做部分由模型从会话上下文自行衔接。
- `paused` → 重弹暂停交互。
- `completed` / `aborted` / 无状态 → 不动作。

插件卸载/重载：编排器 fiber 随插件 scope 终止；状态已在 log，重载后经 `agent/created` 走恢复路径。

### 7.3 进度展示

- **TodoPanel**（主）：批准 → 全 pending；每步开始 → 前一步 completed + 当前步 in_progress；失败步保持 in_progress 直到解决；完成 → 全 completed（终止则保留现场）。
- **轨迹页**（辅）：所有 turn/step 天然可见；不依赖 `pae/*` 的客户端渲染定义。
- **终局**：完成弹窗含各步 `report_step` summary 汇总。

## 8. 错误处理汇总

| 场景 | 策略 |
|---|---|
| LLM 请求级错误（网络/限流等） | dsh `agent/request-error` 内建重试，插件不参与 |
| 步骤 turn 失败 / `report_step(blocked)` / 追问后仍不汇报 | 失败策略（§6.3） |
| 用户取消当前步 | paused |
| manifest 文件悬空（步骤开始校验失败） | paused |
| 执行中用户直接发话 | 原生 steer 进入当前步，编排不动 |
| headless（无 userQuestions provider） | 命令入口拒绝启动 |
| 会话被删除/dispose | 编排器 scope 终止，无泄漏（WeakMap + scope-bound fiber） |
| 会话 log 增长（长任务） | dsh compaction 体系负责；步骤内容在文件，不依赖 log 完整性 |

## 9. 工程结构

照搬 `demo-tools-plugin`（`/Users/jimmy/VSCodeProjects/dsh-plugin/demo-tools-plugin`）的骨架与本仓库 CLAUDE.md 工程环境（TS 6.0.3 / pnpm / Node ≥22 / ESLint + Prettier + Husky / strict）：

```
src/
  index.ts          # apply(ctx)：命令、工具、prompt sections、agent/created 监听（组合根）
  orchestrator.ts   # 状态机 + 步进驱动循环
  state.ts          # pae/* 事件读写与折叠（纯函数）
  prompts.ts        # 两阶段 prompt 文本、注入消息模板
  tools.ts          # submit_plan / report_step
test/               # vitest 单测
scripts/link-host.mjs   # 宿主包软链（见下表）
scripts/dev.mjs         # 生成 .overlay.dev.yml，在 dsh checkout 启动 pnpm dsh web --patch ...
cordis.patch.yml        # 正式安装（裸包名 + tsup 产物）
```

**依赖与同实例保证**：宿主包全部 `peerDependencies: "*"`；`link-host.mjs` 把宿主包软链到 dsh 仓库真实目录，插件按绝对路径被加载后 `import '@deepseek-ai/*'` 解析到软链 → 与宿主共享同一实例（避免双 cordis 实例）。链接表（已核实）：

| 包 | dsh 仓库路径 |
|---|---|
| `@deepseek-ai/cordis` | `vendor/cordis` |
| `@deepseek-ai/schemastery` | `vendor/schemastery` |
| `@deepseek-ai/dsh-agent` | `packages/core/agent` |
| `@deepseek-ai/dsh-session` | `packages/core/session` |
| `@deepseek-ai/dsh-llm` | `packages/llm/llm` |
| `@deepseek-ai/dsh-system-prompt` | `packages/core/system-prompt` |
| `@deepseek-ai/dsh-commands` | `packages/interaction/commands` |
| `@deepseek-ai/dsh-user-questions` | `packages/interaction/user-questions` |
| `@deepseek-ai/dsh-tools` | `packages/core/tools` |

## 10. 配置（schemastery，刻意最小）

```ts
{
  onStepFailure: 'pause' | 'auto-recover',  // 默认 'pause'
  maxAutoRecoveries: number,                 // 默认 2，仅 auto-recover 生效
  planDir: string,                           // 默认 '.pae'，相对会话 cwd
}
```

确认点不做全局配置（manifest 单步标记已覆盖）。

## 11. 测试策略

- **单元测试**（vitest，不依赖 dsh 运行时）：
  - `state.ts` 折叠：事件序列 → 状态（首启 / resume / replan 取最后 plan / 步报告归属）；
  - 暂停决策矩阵：turn 结束原因 × report_step 事件 × 配置 → 动作（继续/暂停/自愈/追问）；
  - manifest 校验：悬空 / 空文件 / 非法相对路径（临时目录模拟）；
  - todo 边界更新序列与 TodoItem payload 构造。
- **手工验收**（`dev.mjs` + Web UI，剧本写入 README）：规划 → 审批拒绝 + 反馈 → 修改再提交 → 批准 → 含确认点步骤 → 制造失败 → 暂停 → 恢复 → 完成，全链路一遍。
- **诚实边界**：完整 agent loop 集成测试依赖 dsh 仓库内 test-support（llm-replay 等），外部工程不纳入；状态机循环由折叠/决策纯函数的组合间接验证。

## 12. 验收标准

1. `pnpm dev` 起 Web UI 后，`/plan-and-execute <任务>` 能走通规划 → 审批 → 执行 → 完成全链路，TodoPanel 实时反映步骤进度；
2. 审批未过时反馈回流模型并循环，直到 Approve；
3. 带 `requiresConfirmation` 的步骤在执行前弹确认点；不带的长计划连续无人值守执行；
4. 执行中取消当前步或步骤失败 → 暂停交互五选项可用；`auto-recover` 配置生效且受次数上限约束；
5. 重启 dsh 后重开会话 → 恢复确认弹出且断点续跑正确（以步为原子单位）；
6. dsh 仓库 `git status` 全程无改动；
7. 单元测试全部通过（`pnpm test`），类型检查 / lint / format 通过。
