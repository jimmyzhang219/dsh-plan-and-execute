# Web UI 步骤卡片（打开文件/目录 + 每步模型选择）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 Web UI 为 plan-and-execute 的 `submit_plan` 工具渲染自定义卡片：卡片级单入口「打开计划目录」、每步「打开文件」（宿主机默认应用查看/编辑）、每步一个 LLM 下拉（列出 dsh 已配置模型，默认选中当前会话模型），所选模型在 execute 阶段按步生效。

**架构：**
- 新增 client half（`dsh.client: { platform: 'web' }`，React 可用），注册 `tool.call.toolview`（key=`submit_plan`）替换客户端自派生的 generic 卡片。**宿主零改动**（dsh 仓库只读）。
- 打开文件/目录走现成通道：toolview owner 的 `openFile(path)` → `session/openWorkspacePath` RPC → 宿主机 `open`/`xdg-open`。
- 模型数据：`ctx.remote.session.modelCatalog()`（provider 分组的 ModelCatalog）；默认值 = 会话当前模型（modelSelection 投影 `next ?? lastUsed ?? catalog.default`）。
- 选择经 `session.prompt` 私有命令 `/plan-and-execute-set-models <json>` 持久化到 `orchestrator.json`（`stepModels`: stepIndex → `{provider, model}`）；执行期由 per-agent `agent/request` waterfall（与宿主 `installModelSelection` 同一机制）按当前步覆盖 `LlmCallConfig`。

**技术栈：** TypeScript、React（客户端）、tsup 双构建（node esm host / browser cjs client）、vitest（node + jsdom）。

---

## 设计决策记录（调研结论的落点，实现时不再重查）

| # | 决策 | 依据 |
|---|---|---|
| D1 | `presentCall` 卡片内容 Web UI 不消费，必须注册 toolview 自定义卡片 | `packages/core/tools/README.md:89`；客户端从 argsRaw 自派生 GenericToolCard |
| D2 | 打开路径用 `openFile`（owner props 自带），目录即 `openFile(目录路径)` | `client/ui-tool/.../contract/slots.ts:29-44`；`api/session-controller/src/index.ts:269-297`；`util/native-command/path-opener.ts:182`（macOS open / Linux xdg-open / Win Invoke-Item） |
| D3 | 打开按钮门控 `isLoopback && canOpenWorkspacePath()`，否则显示路径文本 | `client/ui-deliverables/.../ProducedFiles.tsx:71-73` 范式 |
| D4 | 每步执行切换用 `agent/request` waterfall，**不用** `selectModel` | `selectModel` 会顺带改写全局默认模型（`api/session-controller/src/commands.ts:138` `agentDefaultModel.saveSelection`），且仅 web-app bundle 挂载 |
| D5 | waterfall 在 `agent.ctx` 注册（agent 作用域），后注册者最后覆盖；无 step 模型时透传 | `core/agent/src/model-selection.ts:39-75`（installModelSelection 同机制）；`core/agent-loop/src/agent.ts:476-479` |
| D6 | `session.prompt` 只回 `{accepted:true}` ack，不回命令结果 → 卡片无法查询已持久化选择；选择驻留浏览器 state，apply 后刷新重置为当前会话模型（已知限制） | `api/session-controller/src/types.ts:317-329` |
| D7 | apply 允许在 planning/paused/executing 阶段（不锁 planning），避免审批期间 prompt 排队导致的竞态；waterfall 对当前步即时生效 | 竞态分析：卡片出现在 submit_plan 调用即审批挂起时，queue 处理顺序不可控 |
| D8 | `planDir` 由 submit_plan 参数携带（指令中给的是绝对路径，原样传回，宿主归一化校验）——客户端读不到插件配置值，且 prompt ack-only 无法查询 | `src/prompts.ts:54-60`（kickoff 给出 `${planDir}/`） |
| D9 | `dsh.client.platform` 字面量必须是 `'web'` | `packages/client/modules/src/index.ts:756` |

---

## 文件结构

**修改（宿主侧）：**
- `src/state.ts` — 新增 `PaeStepModel` 类型、`normalizeDir` 纯函数
- `src/persist.ts` — `PersistedOrchestratorState.stepModels` 字段 + snapshot/restore 往返
- `src/orchestrator.ts` — `submitPlan` 加 planDir 校验；`applyStepModels`/`stepModelFor`；状态清理
- `src/tools.ts` — submit_plan 参数加 `planDir`（required）；presentCall 展示
- `src/index.ts` — 新增 `/plan-and-execute-set-models` 命令；`ensure()` 注册 `agent/request` waterfall
- `src/prompts.ts` — 指令措辞明确「submit_plan 的 planDir 参数原样传回」

**新建（client half）：**
- `src/client/index.ts` — client 插件入口（slots 注册在任务 6 完成）
- `src/client/plan-card.ts` — 纯函数层（args 解析 / 模型目录展平 / 默认模型解析 / 载荷构造）
- `src/client/PlanCard.tsx` — 步骤卡片组件（薄视图层）
- `src/client/locale.ts` — 文案（zh/en）

**修改（构建/配置）：**
- `package.json` — `dsh.client` 声明、`exports["./client"]`、`files`、peerDeps
- `tsup.config.ts` — 双构建（host esm / client cjs+browser）
- `tsconfig.json` — 加 `"jsx": "react-jsx"`
- `scripts/link-host.mjs` — HOST_PACKAGES 补 client 包软链

**测试：**
- 修改 `test/state.spec.ts`、`test/persist` 相关（并入 orchestrator.spec）、`test/tools.spec.ts`、`test/orchestrator.spec.ts`、`test/index.spec.ts`、`test/helpers.ts`
- 新建 `test/client/plan-card.spec.ts`（node）、`test/client/plan-card-render.spec.tsx`（jsdom）

---

## 任务 1：client half 构建管线

**文件：**
- 修改：`package.json`、`tsup.config.ts`、`tsconfig.json`、`scripts/link-host.mjs`
- 创建：`src/client/index.ts`
- 测试：`test/index.spec.ts:116`（注册断言更新到本任务末尾）

- [ ] **步骤 1：编写失败测试（client 入口模块可被解析）**

`test/index.spec.ts` 的注册断言更新为包含新命令（任务 4 才实现命令，本任务只断言不崩）：

```ts
// 现有断言 it('注册命令、两个工具、两个 prompt section、agent/created 监听')
// 在 apply 调用前先验证 client 模块可导入（客户端入口不参与 node 侧 apply）：
const { expect } = await import('vitest') // 已导入
```

实际失败信号 = 编译/构建失败，故本任务以构建产物为测试目标，直接实现：

- [ ] **步骤 2：实现构建配置**

`package.json` 增补：

```jsonc
  "exports": {
    ".": {
      "types": "./lib/index.d.ts",
      "default": "./lib/index.js"
    },
    "./client": {
      "types": "./lib/client/index.d.ts",
      "default": "./lib/client/index.js"
    }
  },
  "files": ["lib", "cordis.patch.yml"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": ["slots", "locale", "remote", "remote.session", "connection"]
    }
  },
  "peerDependencies": {
    // 现有条目保留，追加：
    "@deepseek-ai/dsh-client-connection": "*",
    "@deepseek-ai/dsh-client-ui-slots": "*",
    "@deepseek-ai/dsh-client-ui-tool": "*",
    "@deepseek-ai/dsh-api-remotes": "*"
  },
  "devDependencies": {
    // 现有条目保留，追加：
    "@types/react": "^19.0.0",
    "jsdom": "^26.0.0",
    "@testing-library/react": "^16.0.0"
  }
```

`tsup.config.ts` 改为双配置数组（host 在前、clean 归 host；client 在后、不 clean）：

```ts
import { defineConfig } from 'tsup'

/** 浏览器端种子词（dsh ClientModuleSystem 运行时提供，绝不打包）。 */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    target: 'es2024',
    platform: 'node',
    outDir: 'lib',
    dts: true,
    sourcemap: true,
    clean: true,
  },
  {
    entry: ['src/client/index.ts'],
    format: ['cjs'],
    target: 'es2024',
    platform: 'browser',
    outDir: 'lib/client',
    dts: true,
    sourcemap: true,
    clean: false,
    external: CLIENT_EXTERNALS,
  },
])
```

`tsconfig.json` 的 `compilerOptions` 加 `"jsx": "react-jsx"`。

`scripts/link-host.mjs` 的 `HOST_PACKAGES` 追加（client 包类型解析；按 tsc 报错逐个补齐，候选路径）：

```js
  '@deepseek-ai/dsh-client-connection': 'packages/client/connection',
  '@deepseek-ai/dsh-client-ui-slots': 'packages/client/ui-slots',
  '@deepseek-ai/dsh-client-ui-tool': 'packages/client/ui-tool',
  '@deepseek-ai/dsh-api-remotes': 'packages/api/remotes',
```

`src/client/index.ts` 空壳（任务 6 才注册槽位）：

```ts
/**
 * plan-and-execute 的 client half：submit_plan 步骤卡片（toolview）。
 * dsh 浏览器端模块系统加载；React 可用（种子词）。
 * @module plan-and-execute/client
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only：激活 client 侧 Context 合并（slots/remote/locale/connection）。
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-tool'

/** 插件名（与宿主 half 同名，供模块表路由）。 */
export const name = 'plan-and-execute'
/** 必需服务注入：槽位注册表与远程会话面。 */
export const inject = ['slots', 'locale', 'remote', 'remote.session', 'connection']

/** 客户端入口：目前仅日志（槽位注册见任务 6）。 */
export function apply(ctx: Context): void {
  console.log('[plan-and-execute:client] loaded')
  void ctx
}
```

- [ ] **步骤 3：运行验证**

```bash
pnpm build
pnpm typecheck
pnpm test
```

预期：`lib/index.js` 与 `lib/client/index.js` 均产出；typecheck 通过（link-host 若报缺包，按报错把对应 `@deepseek-ai/*` 补进 `HOST_PACKAGES` 后重跑 `pnpm install` 触发 postinstall link）。

- [ ] **步骤 4：Commit**

```bash
git add package.json tsup.config.ts tsconfig.json scripts/link-host.mjs src/client/index.ts
git commit -m "chore: client half 构建管线（dsh.client 声明 + tsup 双构建 + link-host 扩展）"
```

---

## 任务 2：submit_plan 参数携带 planDir 并校验

**文件：**
- 修改：`src/tools.ts`（参数 schema + execute + presentCall）、`src/orchestrator.ts`（submitPlan 签名与校验）、`src/state.ts`（normalizeDir）、`src/prompts.ts`（指令措辞）
- 测试：`test/tools.spec.ts`、`test/orchestrator.spec.ts`、`test/helpers.ts:137`（makeOrchestrator 调用点）

- [ ] **步骤 1：编写失败测试**

`test/state.spec.ts` 追加：

```ts
import { normalizeDir } from '../src/state.ts'

describe('normalizeDir', () => {
  it('去尾部斜杠', () => {
    expect(normalizeDir('/a/b/')).toBe('/a/b')
    expect(normalizeDir('/a/b///')).toBe('/a/b')
    expect(normalizeDir('/a/b')).toBe('/a/b')
  })
})
```

`test/orchestrator.spec.ts` 追加：

```ts
describe('submitPlan planDir 校验', () => {
  it('planDir 与编排目录不一致 → 拒绝', async () => {
    const { Orchestrator } = await import('../src/orchestrator.ts')
    const { FakeAgent, FakeStorage, fakeAsk } = await import('./helpers.ts')
    const { mkdtemp } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const planDir = await mkdtemp(join(tmpdir(), 'pae-dir-'))
    const orchestrator = new Orchestrator({
      agent: new FakeAgent(),
      ask: fakeAsk().ask,
      config: { onStepFailure: 'pause', maxAutoRecoveries: 2, planRoot: '.pae' },
      planDir,
      storage: new FakeStorage(),
    })
    await orchestrator.begin('T')
    const verdict = await orchestrator.submitPlan(`${planDir}/..`, [
      { file: 'a.md', title: 'A' },
    ])
    expect(verdict.approved).toBe(false)
    expect((verdict as { error: string }).error).toContain('planDir')
  })

  it('尾部斜杠差异不算不一致（归一化后相等）', async () => {
    // 同上构造；submitPlan(`${planDir}/`, ...) → approved true（审批回答脚本化）
  })
})
```

`test/tools.spec.ts` 现有 submit_plan 用例：所有 `execute` 调用的 args 对象补 `planDir: '<测试目录>'`；新增断言参数 schema `parameters.planDir.required === true`。

- [ ] **步骤 2：运行测试验证失败**

```bash
pnpm test -- test/state.spec.ts test/orchestrator.spec.ts test/tools.spec.ts
```

预期：FAIL——`submitPlan` 签名尚无 planDir（类型错误）+ normalizeDir 不存在。

- [ ] **步骤 3：实现**

`src/state.ts` 追加：

```ts
/** 目录归一化（去尾部斜杠；planDir 校验用）。 */
export function normalizeDir(path: string): string {
  return path.replace(/\/+$/, '')
}
```

`src/orchestrator.ts` 的 `submitPlan` 签名改为 `(planDir: string, steps, summary?)`，在阶段校验之后、清单校验之前插入：

```ts
    if (normalizeDir(planDir) !== normalizeDir(this.deps.planDir)) {
      return {
        approved: false,
        error: 'planDir 与编排计划目录不一致，请原样传回指令中给出的目录',
      }
    }
```

（`normalizeDir` 从 `./state.ts` 导入。）

`src/tools.ts` submit_plan 参数 schema 追加：

```ts
            planDir: {
              type: 'string',
              required: true,
              description: '计划目录（指令中给出的目录，原样传回）',
            },
```

execute 改为 `orchestrator.submitPlan(args.planDir, args.steps, args.summary)`；presentCall 的 content 首行加 `` `计划目录：${args.planDir}` ``。

`src/prompts.ts` kickoffInstruction（`src/prompts.ts:54-60`）与 `PLANNING_SECTION_BODY` 末尾各加一句：

```ts
      `调用 submit_plan 时，planDir 参数必须原样传回上面的目录（不要改写或省略）。`,
```

`test/helpers.ts:137`：`await orchestrator.submitPlan(planDir, steps, '测试计划')`。

- [ ] **步骤 4：运行测试验证通过**

```bash
pnpm test
pnpm typecheck
```

预期：PASS，全部存量用例通过。

- [ ] **步骤 5：Commit**

```bash
git add src/state.ts src/orchestrator.ts src/tools.ts src/prompts.ts test/
git commit -m "feat: submit_plan 参数携带 planDir 并校验（Web UI 打开路径的数据来源）"
```

---

## 任务 3：stepModels 状态与持久化

**文件：**
- 修改：`src/state.ts`、`src/persist.ts`、`src/orchestrator.ts`
- 测试：`test/orchestrator.spec.ts`、`test/state.spec.ts`

- [ ] **步骤 1：编写失败测试**

`test/orchestrator.spec.ts` 追加：

```ts
describe('applyStepModels / stepModelFor', () => {
  it('planning 阶段 apply 成功并持久化；begin 后 cleared；批准后保留', async () => {
    const { Orchestrator } = await import('../src/orchestrator.ts')
    const { FakeAgent, FakeStorage, fakeAsk } = await import('./helpers.ts')
    const { mkdtemp } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const planDir = await mkdtemp(join(tmpdir(), 'pae-models-'))
    const storage = new FakeStorage()
    const orchestrator = new Orchestrator({
      agent: new FakeAgent(),
      ask: fakeAsk().ask,
      config: { onStepFailure: 'pause', maxAutoRecoveries: 2, planRoot: '.pae' },
      planDir,
      storage,
    })
    await orchestrator.begin('T')
    expect(orchestrator.stepModelFor(1)).toBeUndefined() // planning 阶段不透出
    const result = await orchestrator.applyStepModels({ 1: { provider: 'a', model: 'm' } })
    expect(result).toEqual({ ok: true })
    expect(storage.state?.stepModels).toEqual({ 1: { provider: 'a', model: 'm' } })
    await orchestrator.begin('T2') // 新编排清空映射
    expect(storage.state?.stepModels).toBeUndefined()
  })

  it('无已提交计划 → 拒绝；步骤号越界 → 拒绝', async () => {
    // begin 后（未 submitPlan）applyStepModels → { ok: false, error: contains '计划' }
    // makeOrchestrator([a,b], [answer('pae-approve','批准')]) 批准后 applyStepModels({3:{...}}) → 拒绝（1..2 之外）
  })

  it('executing 阶段 stepModelFor 命中映射；无映射透传 undefined', async () => {
    // makeOrchestrator([a,b], [answer('pae-approve','批准')])
    // applyStepModels({2:{provider:'b',model:'m2'}}) → stepModelFor(2) 命中、stepModelFor(1) undefined
  })

  it('revive 从持久化恢复 stepModels', async () => {
    // FakeRevivedSession 的 storage.state 补 stepModels:{1:{provider:'a',model:'m'}}
    // orchestrator.revive()（ask 挂起）后 stepModelFor(1) 命中
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

```bash
pnpm test -- test/orchestrator.spec.ts
```

预期：FAIL——`applyStepModels`/`stepModelFor` 不存在。

- [ ] **步骤 3：实现**

`src/state.ts` 追加：

```ts
/** 单步模型选择（Web UI 步骤卡片设置；apply 后执行期按步生效）。 */
export interface PaeStepModel {
  /** 注册的 provider 路由。 */
  readonly provider: string
  /** provider 拥有的模型 id。 */
  readonly model: string
  /** adapter 持有的 reasoning effort（可缺省）。 */
  readonly reasoningEffort?: string
}
```

`src/persist.ts`：`PersistedOrchestratorState` 追加：

```ts
  /** 各步模型选择（键为 1-based 步号；缺省 = 用会话当前模型）。 */
  readonly stepModels?: Readonly<Record<number, PaeStepModel>>
```

`snapshotState` 参数类型加 `stepModels: ReadonlyMap<number, PaeStepModel>`，返回对象加：

```ts
    ...(state.stepModels.size === 0 ? {} : { stepModels: Object.fromEntries(state.stepModels) }),
```

`restoreState` 返回类型加 `stepModels: Map<number, PaeStepModel>`，实现加：

```ts
    stepModels: new Map(
      Object.entries(persisted.stepModels ?? {}).map(([k, v]) => [Number(k), v]),
    ),
```

`src/orchestrator.ts`：
- `RuntimeState` 加 `stepModels: Map<number, PaeStepModel>`，初始化 `new Map()`。
- `begin()`（`src/orchestrator.ts:203-221`）与 `enterReplan`（`:490-496`）各加 `this.state.stepModels.clear()`。
- `submitPlan` 批准分支**不清空** stepModels（2026-08-29 裁定：批准不是新计划；begin/enterReplan 已覆盖清理语义；审批前设置的模型必须存活到执行期）。
- 新增两个方法：

```ts
  /**
   * 设置各步执行模型（Web UI 卡片经命令调用）。允许 planning/paused/executing
   * 阶段：paused/executing 下对当前步即时生效（waterfall 逐请求读取）。
   * @returns 失败原因或成功。
   */
  async applyStepModels(
    models: Readonly<Record<number, PaeStepModel>>,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const plan = this.state.plan
    if (
      this.state.phase === 'none' ||
      this.state.phase === 'completed' ||
      this.state.phase === 'aborted'
    ) {
      return { ok: false, error: '当前阶段不可设置步骤模型' }
    }
    for (const key of Object.keys(models)) {
      const index = Number(key)
      if (!Number.isInteger(index) || index < 1) {
        return { ok: false, error: `步骤号 ${key} 不是正整数` }
      }
      if (plan !== undefined && index > plan.steps.length) {
        return { ok: false, error: `步骤号 ${key} 超出计划范围（1..${plan.steps.length}）` }
      }
    }
    this.state.stepModels = new Map(Object.entries(models).map(([k, v]) => [Number(k), v]))
    await this.save()
    return { ok: true }
  }

  /** 当前执行步的模型选择（仅 executing/paused 阶段透出；无映射返回 undefined）。 */
  stepModelFor(stepIndex: number): PaeStepModel | undefined {
    if (this.state.phase !== 'executing' && this.state.phase !== 'paused') return undefined
    return this.state.stepModels.get(stepIndex)
  }
```

- `applyPersisted`（`:619-632`）的 `restoreState` 返回值解构加 `stepModels`：

```ts
    const restored = restoreState(persisted)
    this.state.stepModels = restored.stepModels
```

- [ ] **步骤 4：运行测试验证通过**

```bash
pnpm test
pnpm typecheck
```

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/state.ts src/persist.ts src/orchestrator.ts test/orchestrator.spec.ts test/state.spec.ts
git commit -m "feat: 编排器 stepModels 状态与持久化（applyStepModels/stepModelFor）"
```

---

## 任务 4：set-models 命令 + agent/request waterfall

**文件：**
- 修改：`src/index.ts`、`test/index.spec.ts`、`test/helpers.ts`（如需）
- 测试：`test/index.spec.ts`

- [ ] **步骤 1：编写失败测试**

`test/index.spec.ts`：`fakeAgent` 的 `ctx` 加 `on` 捕获器；`fakeCtx` 的 `get` 加 `llm` 假服务：

```ts
const fakeAgent = (_phase: 'none' | PaePhase) => ({
  id: 'sess-1',
  status: 'idle',
  steer: vi.fn(),
  whenIdle: async () => {},
  ctx: {
    tools: { restrict: vi.fn((_filter: unknown) => () => {}) },
    on: vi.fn((_event: string, _handler: unknown) => () => {}),
  },
  session: {
    id: 'sess-1',
    header: { cwd },
    events: [] as SessionEvent[],
    append: vi.fn((_type: string, _data: object) => {}),
  },
})
```

```ts
// fakeCtx.get 的 llm 分支：
const llm = {
  resolveCallConfig: vi.fn(async (c: { provider: string; model: string }) => ({
    provider: c.provider,
    model: c.model,
  })),
}
// get: (key) => {
//   if (key === 'sessionTitle') return sessionTitle
//   if (key === 'llm') return llm
//   return { ask: async () => ({ answers: [] }) }
// }
```

新用例：

```ts
describe('plan-and-execute-set-models 命令', () => {
  it('合法载荷 → 经 llm 校验后写入编排器（seedState planning + plan）', async () => {
    // seedState('planning', { plan: { planDir: join(cwd,'.pae','sess-1'), steps: [{file:'a.md',title:'A'}] } })
    // apply(ctx)
    // 先触发 agent/created 监听（listeners 里找 'agent/created'，await handler({agent: fakeAgent('planning')}))
    //   —— ensure() 创建编排器 + revive() 从 seedState 加载 plan（lookup 才能命中）
    // 找 name==='plan-and-execute-set-models' 的命令 handler
    // await handler({ agent: fakeAgent('planning'), rawInput: '{"1":{"provider":"deepseek-official","model":"deepseek-v4-flash"}}' })
    // 预期 { kind: 'success' }；llm.resolveCallConfig 被调用
  })
  it('坏 JSON / 非对象 / 缺 provider-model → error，不落盘', () => { /* rawInput 分别为 'x'、'[1]'、'{"1":{"provider":"a"}}' */ })
  it('llm 校验抛错 → error 带模型不可用', () => {
    // llm.resolveCallConfig 改为 reject(new Error('unknown model'))
  })
})

describe('agent/request waterfall 按步切换模型', () => {
  it('executing 且当前步有映射 → 覆盖 provider/model', async () => {
    // seedState('executing', { stepIndex: 1, plan: {...2 步} })
    // apply(ctx); 触发 agent/created 监听（listeners 里找 'agent/created'，handler({agent: fakeAgent('executing')}))
    // const on = agent.ctx.on as Mock；取 'agent/request' handler
    // 先 await orchestrator.applyStepModels? 不行——ensure 后 orchestrator 在 WeakMap；经命令 handler 先 apply：
    //   命令 handler({agent, rawInput:'{"1":{"provider":"p1","model":"m1"}}'})
    // await requestHandler(payload, async () => ({ provider:'s', model:'m', maxTokens: 100 }))
    // 预期返回 { provider:'p1', model:'m1', maxTokens: 100 }（保留其余字段）
  })
  it('当前步无映射 → 原样透传', () => { /* 同上但映射为 {"2": ...} */ })
})
```

- [ ] **步骤 2：运行测试验证失败**

```bash
pnpm test -- test/index.spec.ts
```

预期：FAIL——命令未注册、waterfall 未注册。

- [ ] **步骤 3：实现**

`src/index.ts`：

1. 顶部导入：`import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'`、`import type { PaeStepModel } from './state.ts'`。
2. 把 `const lookup = (session: object): Orchestrator | undefined => orchestrators.get(session)`（现 `src/index.ts:193`）**上移到命令注册块之前**，供两个命令共用。
3. `ensure()`（`src/index.ts:113-136`）在 `orchestrators.set(...)` 之后注册 waterfall：

```ts
    // 每步模型切换：agent/request waterfall 按当前步覆盖 LlmCallConfig。
    // 与宿主 installModelSelection 同一机制（后注册者最后覆盖）；无映射时透传。
    const disposeStepModel = agent.ctx.on(
      'agent/request',
      async (_payload: unknown, next: () => Promise<LlmCallConfig>): Promise<LlmCallConfig> => {
        const resolved = await next()
        const stepIndex = orchestrator.snapshot().stepIndex ?? 0
        const selected = orchestrator.stepModelFor(stepIndex)
        if (selected === undefined) return resolved
        return {
          ...resolved,
          provider: selected.provider,
          model: selected.model,
          ...(selected.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: selected.reasoningEffort }),
        }
      },
    )
    ctx.effect(() => () => disposeStepModel(), 'plan-and-execute: step model waterfall')
```

4. 现有 `ctx.inject(['commands'], ...)` 块内追加第二个命令（`agent` 忙检查复用现有模式，但跳过 plan-mode/标题逻辑）：

```ts
    commandCtx.commands.register({
      name: 'plan-and-execute-set-models',
      description:
        'Plan-and-Execute：设置各步骤执行模型（Web UI 步骤卡片调用）。' +
        '载荷为 JSON：{"1":{"provider":"...","model":"..."}}（步骤号 1-based）。',
      input: { hint: '<json>' },
      handler: async ({ agent, rawInput }) => {
        const orchestrator = lookup(agent.session as object)
        if (orchestrator === undefined) {
          return { kind: 'error', text: '当前会话没有 plan-and-execute 编排' }
        }
        const llm = ctx.get<{
          resolveCallConfig: (c: {
            provider: string
            model: string
          }) => Promise<{ provider: string; model: string; reasoningEffort?: string }>
        }>('llm')
        if (llm === undefined) return { kind: 'error', text: '当前部署没有 llm 服务，无法校验模型' }
        let parsed: unknown
        try {
          parsed = JSON.parse(rawInput.trim())
        } catch {
          return { kind: 'error', text: '载荷不是合法 JSON' }
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          return { kind: 'error', text: '载荷必须是 {步骤号: {provider, model}} 对象' }
        }
        const models: Record<number, PaeStepModel> = {}
        for (const [key, value] of Object.entries(parsed)) {
          const index = Number(key)
          const v = value as { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
          if (
            !Number.isInteger(index) ||
            typeof v?.provider !== 'string' ||
            typeof v?.model !== 'string'
          ) {
            return { kind: 'error', text: `第 ${key} 项缺少 provider/model 字符串字段` }
          }
          let resolved: { provider: string; model: string; reasoningEffort?: string }
          try {
            resolved = await llm.resolveCallConfig({ provider: v.provider, model: v.model })
          } catch (error) {
            return {
              kind: 'error',
              text: `模型 ${v.provider}/${v.model} 不可用：${
                error instanceof Error ? error.message : String(error)
              }`,
            }
          }
          models[index] = {
            provider: resolved.provider,
            model: resolved.model,
            ...(resolved.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: resolved.reasoningEffort }),
            ...(typeof v.reasoningEffort === 'string' ? { reasoningEffort: v.reasoningEffort } : {}),
          }
        }
        const result = await orchestrator.applyStepModels(models)
        return result.ok
          ? { kind: 'success', text: `已设置 ${Object.keys(models).length} 个步骤的模型` }
          : { kind: 'error', text: result.error }
      },
    })
```

- [ ] **步骤 4：运行测试验证通过**

```bash
pnpm test
pnpm typecheck
```

预期：PASS；存量用例 `registered.commands.map(c => c.name)` 断言更新为 `['plan-and-execute', 'plan-and-execute-set-models']`。

- [ ] **步骤 5：Commit**

```bash
git add src/index.ts test/index.spec.ts
git commit -m "feat: set-models 命令 + agent/request waterfall 按步切换模型"
```

---

## 任务 5：client 纯函数层

**文件：**
- 创建：`src/client/plan-card.ts`
- 测试：`test/client/plan-card.spec.ts`

- [ ] **步骤 1：编写失败测试**

`test/client/plan-card.spec.ts`：

```ts
import { describe, expect, it } from 'vitest'
import {
  buildSetModelsPrompt,
  flattenCatalog,
  parseCardArgs,
  resolveCurrentModel,
  serializeStepModels,
} from '../../src/client/plan-card.ts'

const catalog = {
  default: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  routableProviders: ['deepseek-official'],
  groups: [
    {
      id: 'deepseek-official',
      name: 'DeepSeek Official',
      models: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }],
    },
  ],
  failures: [],
}

describe('flattenCatalog', () => {
  it('groups × models → 下拉选项', () => {
    expect(flattenCatalog(catalog)).toEqual([
      { provider: 'deepseek-official', model: 'deepseek-v4-flash', label: 'deepseek-official · deepseek-v4-flash' },
      { provider: 'deepseek-official', model: 'deepseek-v4-pro', label: 'deepseek-official · deepseek-v4-pro' },
    ])
  })
  it('空 groups → 空数组', () => {
    expect(flattenCatalog({ ...catalog, groups: [] })).toEqual([])
  })
})

describe('resolveCurrentModel', () => {
  it('next 优先，其次 lastUsed，最后 catalog.default', () => {
    expect(resolveCurrentModel(catalog, { next: { provider: 'n', model: 'm' }, lastUsed: { provider: 'l', model: 'u' } }))
      .toEqual({ provider: 'n', model: 'm' })
    expect(resolveCurrentModel(catalog, { lastUsed: { provider: 'l', model: 'u' } }))
      .toEqual({ provider: 'l', model: 'u' })
    expect(resolveCurrentModel(catalog, undefined)).toEqual(catalog.default)
  })
})

describe('parseCardArgs', () => {
  it('合法载荷解析 planDir/summary/steps', () => {
    expect(parseCardArgs({ planDir: '.pae/s1', steps: [{ file: 'a.md', title: 'A' }] })).toEqual({
      planDir: '.pae/s1',
      steps: [{ file: 'a.md', title: 'A' }],
    })
  })
  it('缺 planDir / steps 非数组 / 步骤缺 file → undefined', () => {
    expect(parseCardArgs({ steps: [] })).toBeUndefined()
    expect(parseCardArgs({ planDir: '.pae/s1' })).toBeUndefined()
    expect(parseCardArgs({ planDir: '.pae/s1', steps: [{ title: 'A' }] })).toBeUndefined()
    expect(parseCardArgs(null)).toBeUndefined()
  })
})

describe('serializeStepModels', () => {
  it('"provider|model" 值 → {provider, model} 载荷', () => {
    expect(serializeStepModels({ 1: 'a|m' })).toEqual({ 1: { provider: 'a', model: 'm' } })
  })
})

describe('buildSetModelsPrompt', () => {
  it('生成命令文本（JSON.stringify 序列化）', () => {
    expect(buildSetModelsPrompt({ 1: { provider: 'a', model: 'm' } })).toBe(
      '/plan-and-execute-set-models {"1":{"provider":"a","model":"m"}}',
    )
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

```bash
pnpm test -- test/client/plan-card.spec.ts
```

预期：FAIL——模块不存在。

- [ ] **步骤 3：实现**

`src/client/plan-card.ts`：

```ts
/**
 * plan-and-execute 步骤卡片的纯函数层（无 React/DOM 依赖，可 node 单测）。
 * @module plan-and-execute/client/plan-card
 */

/** 卡片载荷（submit_plan 参数）。 */
export interface CardArgs {
  /** 计划目录（相对会话 cwd；打开路径的数据来源）。 */
  readonly planDir: string
  /** 计划一句话概述（可缺省）。 */
  readonly summary?: string
  /** 步骤清单。 */
  readonly steps: ReadonlyArray<{
    readonly file: string
    readonly title: string
    readonly requiresConfirmation?: boolean
  }>
}

/** 下拉选项（provider × model 展平）。 */
export interface ModelOption {
  readonly provider: string
  readonly model: string
  readonly label: string
}

/** 模型目录（与宿主 ModelCatalog 形状一致的最小面）。 */
export interface ModelCatalogLike {
  readonly default: { readonly provider: string; readonly model: string }
  readonly groups: ReadonlyArray<{
    readonly id: string
    readonly models: ReadonlyArray<{ readonly id: string }>
  }>
}

/** 会话模型选择投影（next ?? lastUsed 语义与宿主 ModelDirectory 一致）。 */
export interface ModelSelectionProjectionLike {
  readonly next?: { readonly provider: string; readonly model: string }
  readonly lastUsed?: { readonly provider: string; readonly model: string }
}

/** 校验并解析 submit_plan 原始参数；形状不符返回 undefined。 */
export function parseCardArgs(raw: unknown): CardArgs | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as { planDir?: unknown; summary?: unknown; steps?: unknown }
  if (typeof r.planDir !== 'string' || r.planDir === '') return undefined
  if (!Array.isArray(r.steps)) return undefined
  const steps: CardArgs['steps'] = []
  for (const s of r.steps) {
    const step = s as { file?: unknown; title?: unknown; requiresConfirmation?: unknown }
    if (typeof step?.file !== 'string' || typeof step?.title !== 'string') return undefined
    steps.push({
      file: step.file,
      title: step.title,
      ...(step.requiresConfirmation === true ? { requiresConfirmation: true } : {}),
    })
  }
  return {
    planDir: r.planDir,
    ...(typeof r.summary === 'string' ? { summary: r.summary } : {}),
    steps,
  }
}

/** groups × models 展平为下拉选项（provider 前缀区分同名模型）。 */
export function flattenCatalog(catalog: ModelCatalogLike): ModelOption[] {
  const options: ModelOption[] = []
  for (const group of catalog.groups) {
    for (const model of group.models) {
      options.push({ provider: group.id, model: model.id, label: `${group.id} · ${model.id}` })
    }
  }
  return options
}

/** 当前会话模型：投影 next ?? lastUsed ?? 目录默认。 */
export function resolveCurrentModel(
  catalog: ModelCatalogLike,
  projection: ModelSelectionProjectionLike | undefined,
): { provider: string; model: string } {
  return projection?.next ?? projection?.lastUsed ?? catalog.default
}

/** 选择值 → 命令载荷（provider|model 拼接值还原）。 */
export function serializeStepModels(
  selection: Readonly<Record<number, string>>,
): Record<number, { provider: string; model: string }> {
  const models: Record<number, { provider: string; model: string }> = {}
  for (const [key, value] of Object.entries(selection)) {
    const [provider, model] = value.split('|')
    models[Number(key)] = { provider, model }
  }
  return models
}

/** 生成 set-models 命令文本（session.prompt 载荷）。 */
export function buildSetModelsPrompt(
  models: Readonly<Record<number, { provider: string; model: string }>>,
): string {
  return `/plan-and-execute-set-models ${JSON.stringify(models)}`
}
```

（`ModelCatalog`/`ModelSelectionProjection` 的真实类型在任务 6 注册时从 `@deepseek-ai/dsh-api-remotes/client` 引入并断言兼容；本层用最小形状接口，测试不依赖宿主包。）

- [ ] **步骤 4：运行测试验证通过**

```bash
pnpm test -- test/client/plan-card.spec.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/client/plan-card.ts test/client/plan-card.spec.ts
git commit -m "feat: client 步骤卡片纯函数层（args 解析/模型目录展平/默认模型解析）"
```

---

## 任务 6：PlanCard 组件 + toolview 注册

**文件：**
- 创建：`src/client/PlanCard.tsx`、`src/client/locale.ts`
- 修改：`src/client/index.ts`（注册槽位）
- 测试：`test/client/plan-card-render.spec.tsx`（jsdom）

- [ ] **步骤 1：编写失败测试**

`test/client/plan-card-render.spec.tsx`（文件头 `// @vitest-environment jsdom`）：

```tsx
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { PlanCard } from '../../src/client/PlanCard.tsx'
import type { CardArgs, ModelOption } from '../../src/client/plan-card.ts'

const args: CardArgs = {
  planDir: '.pae/sess-1',
  summary: '测试计划',
  steps: [
    { file: 'a.md', title: '步骤 A' },
    { file: 'b.md', title: '步骤 B', requiresConfirmation: true },
  ],
}
const options: ModelOption[] = [
  { provider: 'deepseek-official', model: 'deepseek-v4-flash', label: 'deepseek-official · deepseek-v4-flash' },
  { provider: 'deepseek-official', model: 'deepseek-v4-pro', label: 'deepseek-official · deepseek-v4-pro' },
]
const current = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }

const base = {
  args,
  canOpen: true,
  options,
  current,
  openFile: vi.fn(),
  onSubmit: vi.fn(async () => {}),
  t: (key: string) => key,
}

describe('PlanCard', () => {
  it('canOpen 时点「打开目录」调 openFile(planDir)', () => {
    render(<PlanCard {...base} />)
    fireEvent.click(screen.getByRole('button', { name: 'openDir' }))
    expect(base.openFile).toHaveBeenCalledWith('.pae/sess-1')
  })

  it('每步「打开文件」调 openFile(planDir/file)', () => {
    render(<PlanCard {...base} />)
    const buttons = screen.getAllByRole('button', { name: 'openFile' })
    fireEvent.click(buttons[1]!)
    expect(base.openFile).toHaveBeenCalledWith('.pae/sess-1/b.md')
  })

  it('canOpen=false → 不渲染打开按钮，显示路径文本', () => {
    render(<PlanCard {...base} canOpen={false} />)
    expect(screen.queryByRole('button', { name: 'openDir' })).toBeNull()
    expect(screen.getByText('.pae/sess-1')).toBeTruthy()
  })

  it('下拉默认 = 当前会话模型', () => {
    render(<PlanCard {...base} />)
    const selects = screen.getAllByRole('combobox')
    expect(selects).toHaveLength(2)
    expect((selects[0] as HTMLSelectElement).value).toBe('deepseek-official|deepseek-v4-flash')
  })

  it('修改下拉并点「应用模型」→ onSubmit 收到 {步骤号: {provider, model}}', async () => {
    render(<PlanCard {...base} />)
    fireEvent.change(screen.getAllByRole('combobox')[0]!, {
      target: { value: 'deepseek-official|deepseek-v4-pro' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'applyModels' }))
    await vi.waitFor(() => {
      expect(base.onSubmit).toHaveBeenCalledWith({
        1: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
        2: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      })
    })
  })

  it('未修改时「应用模型」禁用', () => {
    render(<PlanCard {...base} />)
    expect((screen.getByRole('button', { name: 'applyModels' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

```bash
pnpm test -- test/client/plan-card-render.spec.tsx
```

预期：FAIL——PlanCard 不存在。

- [ ] **步骤 3：实现**

`src/client/locale.ts`：

```ts
/** 步骤卡片文案命名空间（register 的 locale 字段引用）。 */
export const NS = 'plan-and-execute'

/** zh 文案（默认）。 */
export const zh: Record<string, string> = {
  openDir: '打开计划目录',
  openFile: '打开文件',
  applyModels: '应用模型选择',
  applied: '已应用',
  planDir: '计划目录',
  modelUnavailable: '模型目录不可用',
}
```

`src/client/PlanCard.tsx`（纯视图：数据/回调全部由 props 注入，便于 jsdom 测试）：

```tsx
/**
 * submit_plan 步骤卡片：打开文件/目录 + 每步模型下拉。
 * 数据获取与异步（modelCatalog/canOpen/prompt）在注册入口（src/client/index.ts）
 * 的薄包装里完成，本组件只收纯数据 props。
 * @module plan-and-execute/client/PlanCard
 */
import { useState } from 'react'
import type { CardArgs, ModelOption } from './plan-card.ts'
import { serializeStepModels } from './plan-card.ts'

/** 下拉拼接值（provider|model）。 */
export function optionKey(option: { readonly provider: string; readonly model: string }): string {
  return `${option.provider}|${option.model}`
}

export interface PlanCardProps {
  /** submit_plan 解析后的参数。 */
  readonly args: CardArgs
  /** 是否可打开宿主路径（isLoopback && canOpenWorkspacePath，由入口计算）。 */
  readonly canOpen: boolean
  /** 模型下拉选项（flattenCatalog 结果）。 */
  readonly options: readonly ModelOption[]
  /** 当前会话模型（resolveCurrentModel 结果）。 */
  readonly current: { readonly provider: string; readonly model: string }
  /** 打开宿主路径（owner openFile）。 */
  readonly openFile: (path: string) => void
  /** 应用模型选择（入口包装：session.prompt 发送命令；成功乐观置位）。 */
  readonly onSubmit: (models: Record<number, { provider: string; model: string }>) => Promise<void>
  /** locale 翻译。 */
  readonly t: (key: string) => string
}

/** 步骤卡片（受控下拉 + 打开按钮）。 */
export function PlanCard({
  args,
  canOpen,
  options,
  current,
  openFile,
  onSubmit,
  t,
}: PlanCardProps): JSX.Element {
  const defaultValue = optionKey(current)
  const [selection, setSelection] = useState<Record<number, string>>({})
  const [applied, setApplied] = useState(false)
  const dirty = args.steps.some((_step, index) => (selection[index + 1] ?? defaultValue) !== defaultValue)

  const apply = async (): Promise<void> => {
    await onSubmit(serializeStepModels({ ...defaultSelection(args.steps.length, defaultValue), ...selection }))
    setApplied(true)
  }

  return (
    <div data-testid="pae-plan-card">
      <div>
        <strong>{t('planDir')}：{args.planDir}</strong>
        {canOpen ? (
          <button type="button" aria-label={t('openDir')} onClick={() => openFile(args.planDir)}>
            {t('openDir')}
          </button>
        ) : (
          <span>{args.planDir}</span>
        )}
        {args.summary !== undefined ? <p>{args.summary}</p> : null}
      </div>
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
                <button type="button" aria-label={t('openFile')} onClick={() => openFile(`${args.planDir}/${step.file}`)}>
                  {t('openFile')}
                </button>
              ) : null}{' '}
              <select
                aria-label={`model-${i}`}
                value={value}
                onChange={(event) => {
                  setSelection((prev) => ({ ...prev, [i]: event.target.value }))
                  setApplied(false)
                }}
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
      <button type="button" aria-label={t('applyModels')} disabled={!dirty} onClick={() => void apply()}>
        {applied ? t('applied') : t('applyModels')}
      </button>
    </div>
  )
}

/** 全步默认选择（未改动时逐行等于当前会话模型）。 */
function defaultSelection(count: number, defaultValue: string): Record<number, string> {
  const map: Record<number, string> = {}
  for (let i = 1; i <= count; i++) map[i] = defaultValue
  return map
}
```

（`JSX.Element` 返回类型在 React 19 下可用；若 tsc 报 `JSX` 未定义，改为 `ReactElement` 并 `import type { ReactElement } from 'react'`。）

`src/client/index.ts` 注册槽位（替换空壳 apply 主体）：

```ts
import { NS, zh } from './locale.ts'
import { PlanCard, type PlanCardProps } from './PlanCard.tsx'
import { buildSetModelsPrompt, flattenCatalog, parseCardArgs, resolveCurrentModel } from './plan-card.ts'
```

（实现时以 `packages/client/ui-deliverables/src/client/index.ts:35-98` 的 `slots.register` 形态为准：`ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name, key: 'submit_plan', locale: NS, inject: () => ({ sessionRemote: ctx.remote.session, connection: ctx.connection }) }, SubmitPlanCardView))`。`SubmitPlanCardView` 为薄包装：挂载时 `sessionRemote.modelCatalog()` + `sessionRemote.canOpenWorkspacePath()` + `connection.isLoopback` 取数据，`useProjection` 读 modelSelection，组装 `PlanCardProps` 后渲染 `PlanCard`；`onSubmit` 实现为 `sessionRemote.prompt({ requestId: crypto.randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: buildSetModelsPrompt(models) }] })`——`SessionPromptRequest` 形状以 `api/session-controller/src/types.ts:317-324` 为准，locale 提供 `t`（`PropsLocale` 注入面，zh/en 经 `locale` 服务加载 `NS`）。）

- [ ] **步骤 4：运行测试验证通过 + Web 冒烟**

```bash
pnpm test
pnpm build
```

预期：全部 PASS；`lib/client/index.js` 含卡片 bundle。

Web 冒烟（dsh checkout 已构建时）：`node scripts/dev.mjs` 打开 Web UI，执行 `/plan-and-execute 做点什么`，规划完成后 submit_plan 卡片应显示自定义步骤卡片；点「打开目录」宿主机打开文件管理器；改下拉、点「应用模型」，执行阶段 `request/header` 事件应显示对应 provider/model（Web 历史可回溯）。

- [ ] **步骤 5：Commit**

```bash
git add src/client/ test/client/
git commit -m "feat: submit_plan toolview 卡片（打开文件/目录 + 每步模型下拉）"
```

---

## 自检

**1. 规格覆盖度**
- 「打开目录只需一个入口」→ 任务 6 卡片头部单按钮（D2），数据来自任务 2 的 planDir 参数 ✓
- 「每个 Step 点击打开查看/编辑」→ 任务 6 每行「打开文件」（宿主机默认应用打开 md，即查看+编辑）✓
- 「每步模型下拉，默认当前会话模型」→ 任务 5 `resolveCurrentModel`（投影 next ?? lastUsed ?? catalog.default）+ 任务 6 下拉默认值 ✓
- 「下拉列出 dsh 已配置模型」→ 任务 5 `flattenCatalog`（modelCatalog provider 分组展平）✓
- 「所选模型按步执行」→ 任务 3 存储 + 任务 4 waterfall 覆盖 LlmCallConfig ✓
- 「presentCall 不被 Web 消费」→ 任务 6 toolview 替换 generic 卡片（D1）✓
- 硬约束（dsh 仓库零改动、遵守插件机制）→ 全部实现均在插件侧；宿主包仅软链读取 ✓

**2. 占位符扫描**：无 TODO/待定；所有验证步骤有具体命令与预期；类型、函数名（`applyStepModels`/`stepModelFor`/`normalizeDir`/`parseCardArgs`/`flattenCatalog`/`resolveCurrentModel`/`serializeStepModels`/`buildSetModelsPrompt`/`PlanCard`/`optionKey`）在定义处与使用处一致。

**3. 类型一致性**：`PaeStepModel`（state.ts）与 `serializeStepModels` 载荷 `{provider, model}`（后者为命令载荷子集，命令侧补 `reasoningEffort` 可选字段）；`submitPlan(planDir, steps, summary?)` 签名在 orchestrator/tools/helpers 三处同步；`restoreState` 返回值三字段扩为四字段在 orchestrator.applyPersisted 一处解构同步。

**已知限制（验收时确认可接受）**：① 页面刷新后卡片下拉重置为当前会话模型（prompt 只回 ack，无法读回已持久化选择，D6）；② `/plan-and-execute-set-models {json}` 会作为一条用户消息出现在会话历史；③ 远端部署（非 loopback）无打开按钮，只显示路径文本（D3）。
