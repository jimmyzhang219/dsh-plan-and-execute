# 审批卡静默模型选择（通道 A）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把 Web UI 的 plan-review 审批卡（输入座位置的按步确认卡）替换为自定义卡片：每步可打开 md 文件（宿主机默认应用）、每步模型下拉；**下拉选择即静默保存**（`ctx.remote.settings.update` 写 settings 文件 → 宿主 `settings/updated` 桥接 `applyStepModels`）——无「应用模型选择」按钮、无会话消息、无斜杠命令。toolview 卡片同步简化为展示。

**架构：**
- 静默写链路：审批卡下拉 onChange → `ctx.remote.settings.update('pae-step-models', {[sessionId]: {[step]: {provider, model}}}, undefined)` → settings 文件落盘 → 宿主 `settings/updated` 事件（settings 服务 `packages/settings/settings/src/index.ts:778`，emit `(ns, next, prev, source)`，next 为命名空间解析后完整值）→ 插件桥接（按 sessionId 找编排器 → `ctx.llm.resolveCallConfig` 校验 → `orchestrator.applyStepModels` → orchestrator.json）→ 现有 `agent/request` waterfall 按步生效。
- 审批卡替换：client 注册 `conversation.composer` chain（priority -1，`select` 用**结构判定** `kind==='plan-review'` 而非 instanceof，避免值导入非种子包），只接管 plan-review 待审批、其余 pending 返回 null 放行内置卡；整卡复刻决策按钮（`pending.answer`/`pending.cancel` 契约同 `ui-user-questions/PlanReviewPanel.tsx`），并新增反馈 textarea（custom 走驳回反馈，宿主编排器已支持）。
- 步骤数据来源：chat 快照里最新 submit_plan tool-call 节点的 `argsRaw`（`{planDir, steps, summary}`），范式同 `ui-chat/chat/ApprovalCommand.tsx:31-40`；打开文件/目录 = 直接调 `ctx.remote.session.openWorkspacePath`（等价 toolview owner 的 openFile）。

**技术栈：** TypeScript、React（客户端）、schemastery（settings schema，已有依赖）、vitest（node + jsdom）。

---

## 设计决策记录（调研结论的落点，实现时不再重查）

| # | 决策 | 依据 |
|---|---|---|
| DD1 | 静默通道用 `ctx.remote.settings.update`（settings 命名空间）——真无痕（零 transcript 痕迹，写 settings 文件）；不用 `commands.execute`（落 command 行）、不用 `session.prompt`（用户消息入流）、不用 `selectModel`（会话级+全局默认副作用） | `api/settings-controller/src/index.ts:148-160`（@Remote update）；白名单/RPC 表不可扩展（`api/remotes/remote-events.ts:16-31`） |
| DD2 | 宿主桥接用 `settings/updated` 事件（`(ns, next, prev, source)`，next=解析后完整值，`packages/settings/settings/src/index.ts:778`）；桥接内 llm 校验（resolveCallConfig）失败项跳过并 warn | 上条 + `settings/src/index.ts:524-543`（update 先校验后持久化再 emit） |
| DD3 | settings 命名空间全局、按 sessionId 分键；schema = `Schema.dict(Schema.dict(Schema.object({provider, model})))`（schemastery `Schema.dict` 存在，vendor/schemastery/src/index.ts:85） | — |
| DD4 | 审批卡替换 = composer chain priority -1（ui-user-questions 默认 0 先被 -1 拦截）；select 结构判定 `kind==='plan-review' && typeof answer/cancel==='function'`，其余返回 null | `ui-user-questions/src/client/index.ts:94-103`（内置注册形态）；`ui-slots/src/store.ts:819-821`（chain 低 priority 先试） |
| DD5 | 步骤数据 = chat 快照 submit_plan argsRaw（`{planDir, steps}`）；不解析审批卡 detail 文本（脆弱） | `ui-chat/chat/ApprovalCommand.tsx:31-40` 同款范式；审批卡 payload 无结构化步骤 |
| DD6 | 决策按钮渲染 question.options（批准/继续修改，label+description）+ 反馈 textarea（custom 仅在非批准选项且非空时附加）+「讨论」按钮（`pending.cancel()`，对应宿主 dismissed 语义）；busy/error settle 模式同 PlanReviewPanel.tsx:36-46 | `user-questions/src/types.ts:50-64`（answer 形状固定：label 数组+custom）；编排器 `askOrDismiss` 对 dismissed 保持 planning |
| DD7 | toolview 卡片简化为展示（步骤+打开按钮，去下拉/应用）——模型选择唯一入口 = 审批卡；`/plan-and-execute-set-models` 命令保留（不再被 UI 调用） | 避免双 UI 冲突；命令向后兼容 |
| DD8 | settings 残留键不清理（YAGNI，settings 文件用户可编辑）；刷新页面后下拉显示重置的已知限制仍适用（已生效映射持续） | 上轮计划已知限制① |
| DD9 | 插件每步都发**完整**修改后映射（非增量 patch）——applyStepModels 整体替换语义下保证不丢其他步骤选择 | 上轮任务 3 裁定（applyStepModels 整体替换） |

---

## 文件结构

**新建（宿主侧）：**
- `src/settings.ts` — settings 命名空间常量、schema、`parsePaeModels` 解析纯函数

**修改（宿主侧）：**
- `src/index.ts` — `bySessionId` 登记（ensure 时）；`ctx.settings.register(NS, schema)`；`settings/updated` 桥接；`settings` 服务 type-only 合并导入
- `package.json` — peerDeps 加 `@deepseek-ai/dsh-settings`
- `scripts/link-host.mjs` — HOST_PACKAGES 加 `@deepseek-ai/dsh-settings → packages/settings/settings`

**新建（client half）：**
- `src/client/review-card.ts` — 纯函数层（`isPlanReviewPending` / `questionView` / `buildSettingsPatch` / `findLatestSubmitPlanArgs`）
- `src/client/PaeReviewCard.tsx` — 审批卡整卡组件 + 薄包装（数据获取）

**修改（client half）：**
- `src/client/index.ts` — composer chain 注册（priority -1）+ inject 加 `'remote.settings'`
- `src/client/PlanCard.tsx` — 移除下拉/应用（DD7）
- `src/client/plan-card.ts` — `serializeStepModels` 保留（`buildSettingsPatch` 复用）；`buildSetModelsPrompt` 已删除（最终修复波 I-2：命令注册在宿主侧 `src/index.ts`，该函数零引用孤儿）
- `src/client/locale.ts` — review 卡文案键（zh/en）；删 applyModels/applied 键

**测试：**
- 新建 `test/settings.spec.ts`（node）、`test/client/review-card.spec.ts`（node）、`test/client/pae-review-card-render.spec.tsx`（jsdom）
- 修改 `test/index.spec.ts`（桥接）、`test/client/plan-card-view.spec.tsx`、`test/client/plan-card-render.spec.tsx`（简化后）

---

## 任务 1：宿主 settings 命名空间与桥接

**文件：**
- 创建：`src/settings.ts`
- 修改：`src/index.ts`、`package.json`、`scripts/link-host.mjs`
- 测试：`test/settings.spec.ts`、`test/index.spec.ts`

- [ ] **步骤 1：编写失败测试**

`test/settings.spec.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { parsePaeModels, PAE_MODELS_NS } from '../src/settings.ts'

describe('parsePaeModels', () => {
  it('合法载荷解析为 {步骤号: {provider, model}}', () => {
    expect(parsePaeModels({ 1: { provider: 'a', model: 'm1' }, 2: { provider: 'b', model: 'm2' } })).toEqual({
      1: { provider: 'a', model: 'm1' },
      2: { provider: 'b', model: 'm2' },
    })
  })
  it('非法条目丢弃（非整数键/缺字段/非字符串），不抛', () => {
    expect(parsePaeModels({ '1.5': { provider: 'a', model: 'm' }, 0: { provider: 'a', model: 'm' }, 3: { provider: 'a' }, 4: 'x', 5: { provider: 'a', model: 42 } })).toEqual({})
    expect(parsePaeModels(null)).toEqual({})
    expect(parsePaeModels('x')).toEqual({})
  })
  it('命名空间常量', () => {
    expect(PAE_MODELS_NS).toBe('pae-step-models')
  })
})
```

`test/index.spec.ts` 追加（fakeCtx 增 `settings` 服务 + llm 已有）：

```ts
// fakeCtx 增加：
//   settings: { register: vi.fn(() => {}) },
//   get 增加 'settings' 分支（与 sessionTitle 同构）
// llm.resolveCallConfig 已有假件

describe('settings/updated 桥接', () => {
  it('本命名空间变更 → 解析校验后 applyStepModels（按 sessionId 定位编排器）', async () => {
    // seedState('planning', { plan: { planDir: join(cwd,'.pae','sess-1'), steps: [{file:'a.md',title:'A'}] } })
    // apply(ctx)；触发 agent/created（ensure 登记 bySessionId）
    // 找到 ctx.on 捕获的 'settings/updated' 监听器
    // await listener('pae-step-models', { 'sess-1': { 1: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } } }, {}, 'user')
    // 预期：llm.resolveCallConfig 被调用；再触发一次 agent/created 后经 set-models 命令读不到？
    // 简化断言：编排器 stepModels 已应用——经 applyStepModels 落 storage；用命令 handler 查
    // 或直接断言：命令 handler 对同一载荷返回 success 时 applyStepModels 的幂等（略）
    // 实际断言方式：触发 agent/created 后，listener 调用返回；再调 set-models 命令
    //   rawInput 为空对象 {} 会整体替换——故用如下断言：
    //   await listener(NS, {'sess-1': {1: {provider:'a', model:'m'}}}, {}, 'user')
    //   然后 vi.waitFor(() => expect(llm.resolveCallConfig).toHaveBeenCalled())
    //   并断言 ctx.registered 无异常
  })
  it('非本命名空间 → 不处理', async () => {
    // listener('other-ns', {...}, {}, 'user') → llm.resolveCallConfig 未被调用
  })
  it('非法载荷 → 跳过且不抛', async () => {
    // listener(NS, {'sess-1': {1: {provider: 42}}}, {}, 'user') → 无异常
  })
})
```

（桥接的"已应用"直接断言受 FakeStorage 不可达限制时，可在 listener 后再次触发 `agent/created` + `revive` 断言 `stepModelFor`——实现者按现有 index.spec 的 seedState/fireCreated 模式自行选择可达断言。）

- [ ] **步骤 2：运行测试验证失败**

```bash
pnpm test -- test/settings.spec.ts test/index.spec.ts
```

预期：FAIL——`src/settings.ts` 不存在；桥接未实现。

- [ ] **步骤 3：实现**

`src/settings.ts`：

```ts
/**
 * 每步模型选择的 settings 命名空间：Web UI 审批卡下拉经
 * ctx.remote.settings.update 静默写入（不走会话消息/斜杠命令），
 * 宿主侧监听 settings/updated 桥接到编排器。
 * @module plan-and-execute/settings
 */
import Schema from '@deepseek-ai/schemastery'
import type { PaeStepModel } from './state.ts'

/** settings 命名空间名（全局用户配置，按 sessionId 分键）。 */
export const PAE_MODELS_NS = 'pae-step-models'

/** 命名空间 schema：sessionId → 步骤号(数字字符串) → {provider, model}。 */
export const PAE_MODELS_SCHEMA = Schema.dict(
  Schema.dict(
    Schema.object({
      provider: Schema.string().required(),
      model: Schema.string().required(),
    }),
  ),
)

/**
 * 从 settings 载荷解析合法步骤模型（非法条目丢弃，不抛）。
 * @param section - 单个 sessionId 的载荷（settings/updated 的 next 中对应键的值）。
 * @returns 1-based 步骤号 → 模型。
 */
export function parsePaeModels(section: unknown): Record<number, PaeStepModel> {
  if (typeof section !== 'object' || section === null) return {}
  const models: Record<number, PaeStepModel> = {}
  for (const [stepKey, value] of Object.entries(section)) {
    const index = Number(stepKey)
    if (!Number.isInteger(index) || index < 1) continue
    const v = value as { provider?: unknown; model?: unknown } | null
    if (typeof v?.provider !== 'string' || typeof v?.model !== 'string') continue
    models[index] = { provider: v.provider, model: v.model }
  }
  return models
}
```

`scripts/link-host.mjs` 的 HOST_PACKAGES 追加：`'@deepseek-ai/dsh-settings': 'packages/settings/settings'`；`package.json` peerDependencies 追加 `"@deepseek-ai/dsh-settings": "*"`；重跑 `pnpm install`（触发 postinstall link）。

`src/index.ts`：
1. 顶部 `import type {} from '@deepseek-ai/dsh-settings'`（ctx.settings 类型合并）；`import { parsePaeModels, PAE_MODELS_NS, PAE_MODELS_SCHEMA } from './settings.ts'`。
2. 新增 `const bySessionId = new Map<string, Orchestrator>()`；`ensure()` 的 `orchestrators.set(...)` 后加 `bySessionId.set(String(agent.id), orchestrator)`，`ctx.effect` 清理闭包加 `bySessionId.delete(String(agent.id))`。
3. apply 内新增桥接块（放在工具注册之后）：

```ts
  // —— settings 命名空间：审批卡下拉静默写通道 ——
  // 注册失败（如部署已有同名命名空间）则静默降级：审批卡下拉不可用，其余功能不受影响。
  let settingsRegistered = false
  try {
    ctx.settings.register(PAE_MODELS_NS, PAE_MODELS_SCHEMA)
    settingsRegistered = true
  } catch (error) {
    ctx.logger.warn(`plan-and-execute: settings 命名空间注册失败（审批卡模型下拉不可用）：${String(error)}`)
  }
  if (settingsRegistered) {
    ctx.on('settings/updated', (ns: string, next: unknown) => {
      if (ns !== PAE_MODELS_NS) return
      void (async () => {
        for (const [sessionId, section] of Object.entries(
          (next ?? {}) as Record<string, unknown>,
        )) {
          const orchestrator = bySessionId.get(sessionId)
          if (orchestrator === undefined) continue
          const parsed = parsePaeModels(section)
          const resolved: Record<number, { provider: string; model: string }> = {}
          for (const [stepKey, model] of Object.entries(parsed)) {
            try {
              const ok = await ctx.llm.resolveCallConfig({
                provider: model.provider,
                model: model.model,
              })
              resolved[Number(stepKey)] = { provider: ok.provider, model: ok.model }
            } catch (error) {
              ctx.logger.warn(
                `plan-and-execute: 步骤 ${stepKey} 模型 ${model.provider}/${model.model} 不可用，跳过：${
                  error instanceof Error ? error.message : String(error)
                }`,
              )
            }
          }
          const result = await orchestrator.applyStepModels(resolved)
          if (!result.ok) {
            ctx.logger.warn(`plan-and-execute: 应用步骤模型失败：${result.error}`)
          }
        }
      })()
    })
  }
```

（`ctx.llm` 经 dsh-llm 的 Context 合并已可用；`applyStepModels` 整体替换语义下，卡片侧每次发完整映射——DD9。）

- [ ] **步骤 4：运行测试验证通过**

```bash
pnpm test
pnpm typecheck
```

预期：PASS（存量 96 + 新增）。

- [ ] **步骤 5：Commit**

```bash
git add src/settings.ts src/index.ts package.json scripts/link-host.mjs test/
git commit -m "feat: 每步模型选择 settings 命名空间与 settings/updated 桥接（静默写通道）"
```

---

## 任务 2：client 审批卡替换（PaeReviewCard）

**文件：**
- 创建：`src/client/review-card.ts`、`src/client/PaeReviewCard.tsx`
- 修改：`src/client/index.ts`、`src/client/locale.ts`
- 测试：`test/client/review-card.spec.ts`、`test/client/pae-review-card-render.spec.tsx`

- [ ] **步骤 1：编写失败测试**

`test/client/review-card.spec.ts`（node）：

```ts
import { describe, expect, it } from 'vitest'
import {
  buildSettingsPatch,
  isPlanReviewPending,
  questionView,
} from '../../src/client/review-card.ts'

const pending = {
  kind: 'plan-review',
  key: 'k1',
  questions: [
    {
      id: 'pae-approve',
      question: '批准此计划（共 2 步）并开始执行？',
      options: [
        { label: '批准', description: '离开规划阶段' },
        { label: '继续修改', description: '留在规划阶段' },
      ],
    },
  ],
  answer: async () => undefined,
  cancel: async () => undefined,
}

describe('isPlanReviewPending', () => {
  it('plan-review 结构命中', () => {
    expect(isPlanReviewPending(pending)).toBe(true)
  })
  it('其他结构放行（question kind / 缺 answer / 非对象）', () => {
    expect(isPlanReviewPending({ ...pending, kind: 'question' })).toBe(false)
    expect(isPlanReviewPending({ ...pending, answer: undefined })).toBe(false)
    expect(isPlanReviewPending(null)).toBe(false)
    expect(isPlanReviewPending('x')).toBe(false)
  })
})

describe('questionView', () => {
  it('提取 id/question/options', () => {
    expect(questionView(pending.questions)).toEqual({
      id: 'pae-approve',
      question: '批准此计划（共 2 步）并开始执行？',
      options: [
        { label: '批准', description: '离开规划阶段' },
        { label: '继续修改', description: '留在规划阶段' },
      ],
    })
  })
  it('形状不符返回 undefined', () => {
    expect(questionView([])).toBeUndefined()
    expect(questionView([{ id: 'x' }])).toBeUndefined()
  })
})

describe('buildSettingsPatch', () => {
  it('sessionId 键 + serializeStepModels 结果', () => {
    expect(buildSettingsPatch('sess-1', { 1: 'a|m1' })).toEqual({
      'sess-1': { 1: { provider: 'a', model: 'm1' } },
    })
  })
})
```

`test/client/pae-review-card-render.spec.tsx`（`// @vitest-environment jsdom`）：

```tsx
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PaeReviewCard, type PaeReviewCardProps } from '../../src/client/PaeReviewCard.tsx'
import { PAE_MODELS_NS } from '../../src/settings.ts'

const base: PaeReviewCardProps = {
  sessionId: 'sess-1',
  pending: {
    kind: 'plan-review',
    key: 'k1',
    questions: [{
      id: 'pae-approve',
      question: '批准此计划？',
      options: [{ label: '批准', description: 'a' }, { label: '继续修改', description: 'b' }],
    }],
    answer: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
  },
  args: {
    planDir: '.pae/sess-1',
    summary: '测试计划',
    steps: [
      { file: 'a.md', title: '步骤 A' },
      { file: 'b.md', title: '步骤 B', requiresConfirmation: true },
    ],
  },
  canOpen: true,
  options: [
    { provider: 'deepseek-official', model: 'deepseek-v4-flash', label: 'deepseek-official · deepseek-v4-flash' },
    { provider: 'deepseek-official', model: 'deepseek-v4-pro', label: 'deepseek-official · deepseek-v4-pro' },
  ],
  current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  openPath: vi.fn(),
  settings: { update: vi.fn(async () => undefined) },
  t: (key: string) => key,
}

describe('PaeReviewCard', () => {
  it('渲染步骤行（标题/文件/⚠）与模型下拉，默认 = 当前会话模型', () => {
    render(<PaeReviewCard {...base} />)
    expect(screen.getByText('步骤 B')).toBeTruthy()
    expect(screen.getByText('b.md')).toBeTruthy()
    const selects = screen.getAllByRole('combobox')
    expect(selects).toHaveLength(2)
    expect((selects[1] as HTMLSelectElement).value).toBe('deepseek-official|deepseek-v4-flash')
  })

  it('下拉 onChange → 静默 settings.update（完整映射，无按钮）', async () => {
    render(<PaeReviewCard {...base} />)
    fireEvent.change(screen.getAllByRole('combobox')[0]!, {
      target: { value: 'deepseek-official|deepseek-v4-pro' },
    })
    await waitFor(() => {
      expect(base.settings.update).toHaveBeenCalledWith(
        PAE_MODELS_NS,
        { 'sess-1': { 1: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } } },
        undefined,
      )
    })
  })

  it('点「批准」→ pending.answer({answers:[{id, selected:[\'批准\']}]})', async () => {
    render(<PaeReviewCard {...base} />)
    fireEvent.click(screen.getByRole('button', { name: '批准' }))
    await waitFor(() => {
      expect(base.pending.answer).toHaveBeenCalledWith({
        answers: [{ id: 'pae-approve', selected: ['批准'] }],
      })
    })
  })

  it('反馈框填写后点「继续修改」→ answer 携带 custom', async () => {
    render(<PaeReviewCard {...base} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '步骤 2 拆开' } })
    fireEvent.click(screen.getByRole('button', { name: '继续修改' }))
    await waitFor(() => {
      expect(base.pending.answer).toHaveBeenCalledWith({
        answers: [{ id: 'pae-approve', selected: ['继续修改'], custom: '步骤 2 拆开' }],
      })
    })
  })

  it('点「讨论」→ pending.cancel()', async () => {
    render(<PaeReviewCard {...base} />)
    fireEvent.click(screen.getByRole('button', { name: '讨论' }))
    await waitFor(() => expect(base.pending.cancel).toHaveBeenCalled())
  })

  it('canOpen 时「打开计划目录」→ openPath(planDir)；每行「打开文件」→ openPath(planDir/file)', () => {
    render(<PaeReviewCard {...base} />)
    fireEvent.click(screen.getByRole('button', { name: 'openDir' }))
    expect(base.openPath).toHaveBeenCalledWith('.pae/sess-1')
    fireEvent.click(screen.getAllByRole('button', { name: 'openFile' })[1]!)
    expect(base.openPath).toHaveBeenCalledWith('.pae/sess-1/b.md')
  })

  it('settings.update 拒绝 → 行内错误显示，不崩溃', async () => {
    const failing = { update: vi.fn(async () => { throw new Error('denied') }) }
    render(<PaeReviewCard {...base} settings={failing} />)
    fireEvent.change(screen.getAllByRole('combobox')[0]!, {
      target: { value: 'deepseek-official|deepseek-v4-pro' },
    })
    await waitFor(() => expect(screen.getByText(/应用失败|denied/)).toBeTruthy())
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

```bash
pnpm test -- test/client/review-card.spec.ts test/client/pae-review-card-render.spec.tsx
```

预期：FAIL——模块不存在。

- [ ] **步骤 3：实现**

`src/client/review-card.ts`：

```ts
/**
 * 审批卡替换的纯函数层（无 React/DOM 依赖，可 node 单测）。
 * @module plan-and-execute/client/review-card
 */
import type { CardArgs } from './plan-card.ts'
import { serializeStepModels } from './plan-card.ts'

/** 结构判定面：plan-review 待审批（避免 instanceof 值导入非种子包）。 */
export interface PlanReviewPendingLike {
  readonly kind: 'plan-review'
  readonly key: string
  readonly questions: readonly unknown[]
  readonly answer: (answer: unknown) => Promise<unknown>
  readonly cancel: () => Promise<unknown>
}

/** 结构判定：kind==='plan-review' 且具备 answer/cancel/questions 即命中。 */
export function isPlanReviewPending(value: unknown): value is PlanReviewPendingLike {
  if (typeof value !== 'object' || value === null) return false
  const v = value as { kind?: unknown; answer?: unknown; cancel?: unknown; questions?: unknown }
  return (
    v.kind === 'plan-review' &&
    typeof v.answer === 'function' &&
    typeof v.cancel === 'function' &&
    Array.isArray(v.questions)
  )
}

/** 审批卡决策面（首个问题的 id/标题/选项）。 */
export interface ReviewView {
  readonly id: string
  readonly question: string
  readonly options: ReadonlyArray<{ readonly label: string; readonly description?: string }>
}

/** 从问题载荷提取决策面；形状不符返回 undefined。 */
export function questionView(
  questions: readonly unknown[],
): ReviewView | undefined {
  const q = questions[0] as {
    id?: unknown
    question?: unknown
    options?: unknown
  } | undefined
  if (typeof q?.id !== 'string' || typeof q?.question !== 'string') return undefined
  if (!Array.isArray(q.options)) return undefined
  const options: ReviewView['options'] = []
  for (const o of q.options) {
    const entry = o as { label?: unknown; description?: unknown } | null
    if (typeof entry?.label !== 'string') continue
    options.push({
      label: entry.label,
      ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
    })
  }
  if (options.length === 0) return undefined
  return { id: q.id, question: q.question, options }
}

/** 下拉选择 → settings.update 载荷（sessionId 键 + 完整修改后映射）。 */
export function buildSettingsPatch(
  sessionId: string,
  selection: Readonly<Record<number, string>>,
): Record<string, Record<number, { provider: string; model: string }>> {
  return { [sessionId]: serializeStepModels(selection) }
}

/**
 * 从 chat 快照取最新 submit_plan 调用参数。
 * 遍历 conversation 树找 tool-call 节点（toolName==='submit_plan'，取最后出现者），
 * 读 argsRaw 经 parseCardArgs 解析。节点形状以宿主
 * packages/client/ui-chat/src/client/conversation-nodes（ToolCallBlock）为准；
 * 找不到或形状不符返回 undefined（卡片退化为仅决策按钮）。
 */
export function findLatestSubmitPlanArgs(chat: unknown): CardArgs | undefined {
  // 实现时：按 ui-chat conversation-nodes 的节点类型遍历
  // （TurnNode → 子节点；tool-call 节点含 toolName/argsRaw），
  // 收集 toolName==='submit_plan' 的 argsRaw，取最后一个经 parseCardArgs 解析。
  // 本函数以真实节点形状为准编写，测试用最小 fixture 覆盖两种形态
  // （命中 / 无 submit_plan）。
  void chat
  return undefined
}
```

`src/client/PaeReviewCard.tsx`（整卡 + 薄包装）：

```tsx
/**
 * plan-review 审批卡替换：步骤打开文件/目录 + 每步模型下拉（静默写 settings）+ 决策按钮。
 * 注册于 conversation.composer（priority -1），仅接管 plan-review 待审批。
 * @module plan-and-execute/client/PaeReviewCard
 */
import { useState } from 'react'
import type { CardArgs, ModelOption } from './plan-card.ts'
import { optionKey } from './PlanCard.tsx'
import { PAE_MODELS_NS } from '../settings.ts'
import { buildSettingsPatch, questionView, type PlanReviewPendingLike } from './review-card.ts'

/** 决策答案形状（与宿主 AskUserQuestionAnswer 一致的最小面）。 */
export interface AnswerLike {
  answers: ReadonlyArray<{ readonly id: string; readonly selected: readonly string[]; readonly custom?: string }>
}

export interface PaeReviewCardProps {
  readonly sessionId: string
  readonly pending: PlanReviewPendingLike
  readonly args: CardArgs | undefined
  readonly canOpen: boolean
  readonly options: readonly ModelOption[]
  readonly current: { readonly provider: string; readonly model: string }
  readonly openPath: (path: string) => void
  readonly settings: { readonly update: (ns: string, patch: Record<string, unknown>, rev: number | undefined) => Promise<unknown> }
  readonly t: (key: string) => string
}

/** 审批卡（受控下拉 + 静默写 + 决策按钮，busy/error settle 同宿主 PlanReviewPanel）。 */
export function PaeReviewCard({
  sessionId, pending, args, canOpen, options, current, openPath, settings, t,
}: PaeReviewCardProps): JSX.Element {
  const review = questionView(pending.questions)
  const defaultValue = optionKey(current)
  const [selection, setSelection] = useState<Record<number, string>>({})
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const settle = (send: () => Promise<unknown>): void => {
    setBusy(true)
    setError(null)
    void send().catch((cause: unknown) => {
      setBusy(false)
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }
  const decide = (label: string, custom?: string): void => {
    if (review === undefined) return
    const answers: AnswerLike['answers'] = [
      { id: review.id, selected: [label], ...(custom === undefined || custom === '' ? {} : { custom }) },
    ]
    settle(() => pending.answer({ answers }))
  }
  const onModelChange = (step: number, value: string): void => {
    const next = { ...selection, [step]: value }
    setSelection(next)
    setError(null)
    void settings.update(PAE_MODELS_NS, buildSettingsPatch(sessionId, next), undefined).catch(
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    )
  }

  return (
    <section data-testid="pae-review-card" aria-label={review?.question ?? 'plan review'}>
      <header>
        <strong>{t('planReview')}</strong>
        {args?.summary !== undefined ? <p>{args.summary}</p> : null}
        {canOpen && args !== undefined ? (
          <button type="button" aria-label={t('openDir')} onClick={() => openPath(args.planDir)}>
            {t('openDir')}
          </button>
        ) : null}
      </header>
      {args === undefined ? null : (
        <ol>
          {args.steps.map((step, index) => {
            const i = index + 1
            const value = selection[i] ?? defaultValue
            return (
              <li key={step.file}>
                <span>
                  {i}. {step.title}
                  {step.requiresConfirmation === true ? ' ⚠' : ''}
                </span>{' '}
                <code>{step.file}</code>{' '}
                {canOpen ? (
                  <button type="button" aria-label={t('openFile')} onClick={() => openPath(`${args.planDir}/${step.file}`)}>
                    {t('openFile')}
                  </button>
                ) : null}{' '}
                <select
                  aria-label={`model-${i}`}
                  value={value}
                  onChange={(event) => onModelChange(i, event.target.value)}
                >
                  {options.map((option) => (
                    <option key={optionKey(option)} value={optionKey(option)}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </li>
            )
          })}
        </ol>
      )}
      <label>
        {t('feedback')}
        <textarea
          value={feedback}
          onChange={(event) => setFeedback(event.target.value)}
          placeholder={t('feedbackHint')}
        />
      </label>
      <div role="status">{error}</div>
      <footer>
        <button type="button" disabled={busy} onClick={() => { settle(() => pending.cancel()) }}>
          {t('discuss')}
        </button>
        {review?.options.map((option) => (
          <button
            key={option.label}
            type="button"
            disabled={busy}
            title={option.description}
            onClick={() => decide(option.label, feedback)}
          >
            {option.label}
          </button>
        ))}
      </footer>
    </section>
  )
}
```

（说明：反馈 custom 仅在点击**非批准**选项时才有意义——宿主编排器只在非批准分支读 custom；批准点击时传 feedback 无害但按宿主语义忽略。`decide` 统一附加 custom 是安全的，PlanReviewPanel 的 answer 形状同样接受。）

`src/client/index.ts`：
1. `inject` 加 `'remote.settings'`。
2. 注册 composer chain（在 toolview 注册旁）：

```ts
  ctx.slots.inject('conversation.composer', () =>
    ctx.slots.register(
      {
        name: 'conversation.composer',
        priority: -1,
        select: ({ pendingInteraction }: { pendingInteraction: unknown }) =>
          isPlanReviewPending(pendingInteraction) ? pendingInteraction : null,
        locale: NS,
      },
      PaeReviewCardView,
    ),
  )
```

3. `PaeReviewCardView`（薄包装，与 PaeReviewCard 同文件导出）：收 `ComposerChainProps`（sessionId/pendingInteraction）+ 注入面（remote.session/remote.settings/connection）；挂载时 `modelCatalog()` + `canOpenWorkspacePath()` + `isLoopback`；`useChat` 快照 → `findLatestSubmitPlanArgs`；`openPath = (path) => remote.session.openWorkspacePath({ path })`（相对路径宿主按会话 cwd 解析；planDir 为绝对路径时原样透传——宿主 resolveWorkspacePath 语义）；渲染 `PaeReviewCard`。组件 props 传递与 hooks 调用以宿主 `ui-user-questions` 的 QuestionComposer 接收 props 形态为准（标准 session 钩子经 slots 注入）。

`src/client/locale.ts`：新增键（zh/en 双份）：`planReview`（计划审批）、`openDir`（打开计划目录，复用）、`openFile`（打开文件，复用）、`feedback`（驳回反馈）、`feedbackHint`（选「继续修改」时附上反馈，可选）、`discuss`（讨论）；删除 `applyModels`/`applied` 键。

- [ ] **步骤 4：运行测试验证通过**

```bash
pnpm test
pnpm typecheck
pnpm build
```

预期：PASS（存量 + 新增）；build 产物含 PaeReviewCard（包装契约断言通过）。

- [ ] **步骤 5：Commit**

```bash
git add src/client/ test/client/
git commit -m "feat: plan-review 审批卡替换（步骤打开/模型下拉静默写 + 决策按钮）"
```

---

## 任务 3：toolview 简化与收尾

**文件：**
- 修改：`src/client/PlanCard.tsx`、`test/client/plan-card-view.spec.tsx`、`test/client/plan-card-render.spec.tsx`
- 测试：`test/client/plan-card-render.spec.tsx`

- [ ] **步骤 1：编写失败测试**

`test/client/plan-card-render.spec.tsx`：现有下拉/应用相关用例改为断言**不再存在**：

```tsx
  it('简化后：无下拉与应用按钮（模型选择唯一入口 = 审批卡）', () => {
    render(<PlanCard {...base} />)
    expect(screen.queryAllByRole('combobox')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: 'applyModels' })).toBeNull()
  })
```

同时移除/改写依赖 `options`/`current`/`onSubmit` props 的用例（props 删除后类型编译失败即失败信号）。

- [ ] **步骤 2：运行测试验证失败**

```bash
pnpm test -- test/client/plan-card-render.spec.tsx test/client/plan-card-view.spec.tsx
```

预期：FAIL——props 类型不匹配 / 新断言不满足。

- [ ] **步骤 3：实现**

`src/client/PlanCard.tsx`：删除 `options`、`current`、`onSubmit` props 与 `selection`/`applied` state、下拉、应用按钮、`serializeStepModels` 导入、`optionKey` 导出保留（PaeReviewCard 复用）；保留：`args`、`canOpen`、`openFile`、`t`、步骤行、打开文件/目录按钮、degraded 降级渲染。`PlanCardProps` 同步收窄；`SubmitPlanCardView` 移除 modelCatalog/投影/onSubmit 相关逻辑，仅保留 args 解析 + canOpen 计算。

`test/client/plan-card-view.spec.tsx` 同步更新（去下拉用例；保留 running/settled 解析、降级、isLoopback 门控、打开按钮用例；prompt 载荷用例改为断言**不再调用** sessionRemote.prompt——或直接删除该用例并加"无 prompt 调用"断言）。

`test/client/plan-card-render.spec.tsx` 的 `base` fixture 删除 `options`/`current`/`onSubmit` 字段。

- [ ] **步骤 4：运行验证 + 冒烟检查**

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm lint
```

预期：全绿（96 + 任务 2 新增 - 任务 3 删除的用例数净变化按实现为准）。冒烟（宿主已构建时）：`node scripts/dev.mjs` 起 Web UI，执行 `/plan-and-execute 做点什么`——输入座出现自定义审批卡（步骤行+模型下拉+打开按钮+决策按钮），改下拉后 settings 文件出现 `pae-step-models` 段、无需任何消息即生效；点批准进入执行；会话流 toolview 卡为纯展示（无下拉）。若无法交互式冒烟，记录并交验收清单。

- [ ] **步骤 5：Commit**

```bash
git add src/client/ test/client/
git commit -m "refactor: toolview 卡片简化为展示（模型选择入口迁移至审批卡）"
```

---

## 自检

**1. 规格覆盖度**
- 审批卡替换（composer priority -1 + 结构判定）→ 任务 2 ✓
- 每步打开 md 文件 / 单入口打开目录 → 任务 2（openPath → `openWorkspacePath` RPC）✓
- 每步模型下拉，默认当前会话模型 → 任务 2（modelCatalog + `resolveCurrentModel` 投影默认）✓
- 下拉即静默保存，无应用按钮 → 任务 2 `onModelChange` 直接 `settings.update` ✓
- 不走消息 / 不走斜杠命令 → 任务 1 桥接 + 任务 2（settings 通道；命令保留但 UI 不再调用）✓
- 只改当前项目 → 全部改动在插件仓库；dsh 仅只读参考 ✓
- toolview 简化 → 任务 3 ✓

**2. 占位符扫描**：`findLatestSubmitPlanArgs` 的实现以宿主节点形状为准——任务 2 步骤 3 已给函数契约、宿主参考文件（ui-chat conversation-nodes）与测试 fixture 要求，非 TODO；`PaeReviewCardView` 的 hooks/props 接线给出宿主参考（QuestionComposer props 形态）与数据来源，实现时可从宿主确认精确字段名。

**3. 类型一致性**：`PaeReviewCardProps`（sessionId/pending/args/canOpen/options/current/openPath/settings/t）与 `PlanCardProps`（args/canOpen/openFile/t）互不重叠；`buildSettingsPatch` 返回 `Record<string, Record<number, {provider, model}>>` 与 `settings.update` 的 `Record<string, JsonValue>` 参数兼容（数字键对象为 JSON 安全）；`questionView` 的 `ReviewView` 与 PaeReviewCard 的 `review` 消费一致；`PAE_MODELS_NS` 在 settings.ts 定义、client 与宿主共用同一常量（跨 bundle 值复制，字符串常量无单例问题）。

**已知限制（沿袭 + 新增）**：刷新页面后下拉显示重置（已生效映射持续）；settings 命名空间残留键不清理（DD8）；`/plan-and-execute-set-models` 命令保留但不再被 UI 调用（兼容）。
