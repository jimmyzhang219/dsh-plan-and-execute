# Plan-and-Execute 插件实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为 dsh（DeepSeek Harness）开发一个 Plan-and-Execute 编排插件：`/plan-and-execute <任务>` 触发，Plan 阶段与用户反复审批直到确认，Execute 阶段默认无人值守逐步执行、支持可配置确认点与失败暂停，全部 LLM 交互委托给宿主的 ReactLoopAgent。

**架构：** 单个 cordis 函数式插件（主会话内编排）：`/plan-and-execute` 命令启动 Orchestrator 状态机；模型侧通过 `submit_plan` / `report_step` 两个工具与编排器交互；控制流持久化在 `pae/*` 会话事件（log 折叠恢复），步骤内容持久化在每步一个 Markdown 文件；进度借 `todo/write` 事件渲染到宿主 TodoPanel；人机交互走 `ctx.get('userQuestions')`。

**技术栈：** TypeScript 6.0.3（strict、NodeNext、`allowImportingTsExtensions`）、pnpm、Node ≥22.19（fnm，v24.19.0）、vitest、tsup、ESLint + Prettier + Husky。宿主包全部 `peerDependencies`，经 `scripts/link-host.mjs` 软链到 dsh 仓库真实目录共享实例。

**规格：** `docs/superpowers/specs/2026-08-26-plan-and-execute-plugin-design.md`（实现中遇到与本计划冲突处以规格为准，并回报）。

**宿主 API 事实（已核实，实现时直接依赖）：**

- 插件形式：`export const name`、`export const inject`、`export const Config: Schema<Config>`、`export function apply(ctx, config)`（参考 `/Users/jimmy/VSCodeProjects/dsh-plugin/demo-tools-plugin/src/index.ts`）
- 命令：`ctx.commands.register({ name, description, input?, recordInput?, handler })`，handler 收 `{ commandId, agent, rawInput, attachments, signal }`，返回 `{kind:'success', text?} | {kind:'error', text}`；命令名规则 `^[a-z][a-z0-9_-]*$`
- 工具：`defineTool({ name, description, parameters, output: { schema, render }, execute: async (args, exec) => value, presentCall?, presentResult? })`；参数 DSL：属性表 `{ 名: { type, required?, description?, items?, properties?, additionalProperties? } }`（`required` 写在属性上）；`exec.agent?: Agent`、`exec.signal`；抛错即工具错误回模型
- Agent：`agent.steer(UserMessage)`、`agent.whenIdle(): Promise<void>`、`agent.status`、`agent.session`、`agent.id`
- Session：`session.events: readonly SessionEvent[]`（`{seq, type, data}`）、`session.append(type, data)`（log-only 事件两参即可）、`session.header.cwd?`；`SessionEventMap` 用 `declare module '@deepseek-ai/dsh-session/types'` 合并扩展
- `todo/write` 事件：payload `{ todos: { content: string; status: 'pending'|'in_progress'|'completed' }[] }`（整表替换，UI 从事件渲染；宿主类型 `TodoItem` 自 `@deepseek-ai/dsh-session` 导出）
- `turn/end` 事件 `reason.kind`：`'completed' | 'aborted' | 'blocked' | 'error' | 'max-tokens' | 'interrupted'`
- userQuestions：`ctx.get('userQuestions').ask({ questions, agent?, signal? })`；question `{ id, question, detail?, header?, options?: {label, description?}[], intent? }`；intent 仅 `{ kind:'plan-review', approve: <批准选项的 label> }`；回答 `{ answers: [{ id, selected: string[], custom? }] }`；弹窗被关抛 `UserQuestionError` code `'ASK_CANCELLED'`；被父 agent 拥有的子 agent 调用会抛 `DELEGATED_CALLER`（我们只在主 agent 上用，不受影响）
- systemPrompt：`ctx.systemPrompt.section({ name, order, text: string | (context) => string })`，`context.agent?: Agent`（section 的 order 惯例：persona 0，工具指引 100–199）
- 消息：`createUserMessage({ content: [{type:'text', text}], source })` 自 `@deepseek-ai/dsh-llm`；插件注入 source：`{ kind:'plugin', plugin: 'plan-and-execute', form: 'instruction', summary }`
- plan-mode 激活判定：读 session log 中 `plan/mode` 事件（last-wins `data.active`）；**不 import `@deepseek-ai/dsh-plan-mode` 包**（不引入依赖，用本地折叠 + 类型断言读取）

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/state.ts` | `pae/*` 事件类型与 `SessionEventMap` 合并声明；折叠函数（state/plan/step-reports）；todo 快照构造；plan-mode 探测。纯函数 |
| `src/decision.ts` | 步骤结局分类（turn 原因 × report 事件）与失败策略决策。纯函数 |
| `src/manifest.ts` | manifest 文件校验（存在/非空/路径安全）。纯逻辑 + `node:fs/promises` |
| `src/prompts.ts` | 两阶段 system-prompt 正文；全部注入消息构造（kickoff/step/nudge/recover/replan/resume）；审批与终局详情渲染 |
| `src/orchestrator.ts` | 状态机与步进驱动循环。只依赖窄结构接口 `DriveAgent`/`DriveSession`/`AskFn`（可单测） |
| `src/tools.ts` | `submit_plan` / `report_step` 的 `defineTool` 定义，委托 Orchestrator |
| `src/index.ts` | 组合根：Config schema、命令注册（前置校验）、工具注册、prompt sections、`agent/created` 恢复监听、真→结构接口适配 |
| `test/*.spec.ts` | vitest 单测（每任务配套） |
| `scripts/link-host.mjs`、`scripts/dev.mjs`、`cordis.patch.yml` | 宿主链接 / 开发启动 / 正式安装（照搬 demo-tools-plugin 模式） |

**测试策略**：orchestrator 不 import cordis / dsh 运行时服务，用假 Agent（脚本化 `whenIdle` 往假 Session 写 turn/report 事件）+ 假 ask（脚本化回答）驱动全部分支；真 Agent → `DriveAgent` 的适配只发生在 `src/index.ts`（唯一 `as` 断言点）。

---

### 任务 1：工程脚手架与宿主链接

**文件：**
- 创建：`package.json`、`tsconfig.json`、`.gitignore`、`.npmrc`、`src/index.ts`（最小占位）、`scripts/link-host.mjs`、`scripts/dev.mjs`、`cordis.patch.yml`、`tsup.config.ts`
- 复制：`../demo-tools-plugin/` 的 `.editorconfig`、`.prettierignore`、`.prettierrc.json`、`eslint.config.js`、`.husky/`、`.gitignore` 可参考

- [ ] **步骤 1：复制工具链配置**

```bash
cd /Users/jimmy/VSCodeProjects/dsh-plugin/plan-and-execute
cp ../demo-tools-plugin/.editorconfig ../demo-tools-plugin/.prettierignore ../demo-tools-plugin/.prettierrc.json ../demo-tools-plugin/.npmrc ../demo-tools-plugin/eslint.config.js .
cp -R ../demo-tools-plugin/.husky .
```

- [ ] **步骤 2：写 `package.json`**

```json
{
  "name": "plan-and-execute",
  "version": "0.1.0",
  "description": "dsh plugin: plan-and-execute orchestration over ReactLoopAgent",
  "type": "module",
  "license": "MIT",
  "engines": { "node": ">=22.19" },
  "main": "lib/index.js",
  "exports": { ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" } },
  "files": ["lib", "cordis.patch.yml"],
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "link:host": "node scripts/link-host.mjs",
    "dev": "node scripts/dev.mjs",
    "postinstall": "node scripts/link-host.mjs",
    "prepare": "husky || true"
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "peerDependencies": {
    "@deepseek-ai/cordis": "*",
    "@deepseek-ai/schemastery": "*",
    "@deepseek-ai/dsh-agent": "*",
    "@deepseek-ai/dsh-commands": "*",
    "@deepseek-ai/dsh-llm": "*",
    "@deepseek-ai/dsh-session": "*",
    "@deepseek-ai/dsh-system-prompt": "*",
    "@deepseek-ai/dsh-tools": "*",
    "@deepseek-ai/dsh-user-questions": "*"
  },
  "devDependencies": {
    "@eslint/js": "^9.0.0",
    "@types/node": "^24.0.0",
    "eslint": "^9.0.0",
    "eslint-config-prettier": "^10.0.0",
    "husky": "^9.0.0",
    "prettier": "^3.0.0",
    "tsup": "^8.0.0",
    "typescript": "~6.0.3",
    "typescript-eslint": "^8.0.0",
    "vitest": "^4.1.8"
  }
}
```

- [ ] **步骤 3：写 `tsconfig.json`（与 demo 完全一致的严格配置）**

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "lib": ["ES2024"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "forceConsistentCasingInFileNames": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "allowImportingTsExtensions": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "ignoreDeprecations": "6.0"
  },
  "include": ["src", "test", "scripts", "tsup.config.ts"]
}
```

- [ ] **步骤 4：写 `tsup.config.ts`、`.gitignore`、最小 `src/index.ts`**

```ts
// tsup.config.ts
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'node22',
})
```

```bash
# .gitignore
node_modules/
lib/
.overlay.dev.yml
```

```ts
// src/index.ts（占位，任务 10 替换为完整装配）
import type { Context } from '@deepseek-ai/cordis'

export const name = 'plan-and-execute'

export function apply(_ctx: Context): void {
  console.log('[plan-and-execute] plugin loaded')
}
```

- [ ] **步骤 5：写 `scripts/link-host.mjs`（在 demo 基础上扩充链接表）**

```javascript
#!/usr/bin/env node
/**
 * 把 dsh checkout 里的 @deepseek-ai/* 宿主包软链到本工程 node_modules，
 * 保证插件与宿主共享同一包实例（否则出现两个 cordis 实例，插件失效）。
 * 用法：node scripts/link-host.mjs [--remove]；DSH_ROOT 可覆盖默认路径。
 */
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dshRoot = resolve(
  process.env.DSH_ROOT ?? join(process.env.HOME ?? '', 'git', 'deepseek-harness'),
)

const HOST_PACKAGES = {
  '@deepseek-ai/cordis': 'vendor/cordis',
  '@deepseek-ai/schemastery': 'vendor/schemastery',
  '@deepseek-ai/dsh-agent': 'packages/core/agent',
  '@deepseek-ai/dsh-commands': 'packages/interaction/commands',
  '@deepseek-ai/dsh-llm': 'packages/llm/llm',
  '@deepseek-ai/dsh-session': 'packages/core/session',
  '@deepseek-ai/dsh-system-prompt': 'packages/core/system-prompt',
  '@deepseek-ai/dsh-tools': 'packages/core/tools',
  '@deepseek-ai/dsh-user-questions': 'packages/interaction/user-questions',
}

const remove = process.argv.includes('--remove')
const scopeDir = join(projectRoot, 'node_modules', '@deepseek-ai')

if (!remove && !existsSync(dshRoot)) {
  console.error(`[link-host] dsh checkout not found: ${dshRoot}\n[link-host] set DSH_ROOT or re-run after pnpm install inside the dsh repo.`)
  process.exit(0)
}

mkdirSync(scopeDir, { recursive: true })

let failures = 0
for (const [pkg, rel] of Object.entries(HOST_PACKAGES)) {
  const linkPath = join(scopeDir, pkg.split('/')[1] ?? pkg)
  let existing = null
  try { existing = lstatSync(linkPath) } catch { /* 不存在 */ }
  if (existing?.isSymbolicLink() || existing?.isFile()) rmSync(linkPath, { force: true })
  else if (existing?.isDirectory()) {
    console.error(`[link-host] refusing to replace real directory: ${linkPath}`)
    failures += 1
    continue
  }
  if (remove) { console.log(`[link-host] removed ${pkg}`); continue }
  const target = join(dshRoot, rel)
  if (!existsSync(join(target, 'package.json'))) {
    console.error(`[link-host] ${target} is not a package — is DSH_ROOT a dsh checkout?`)
    failures += 1
    continue
  }
  symlinkSync(target, linkPath, 'dir')
  console.log(`[link-host] ${pkg} -> ${target}`)
}
if (failures > 0) process.exit(1)
```

- [ ] **步骤 6：写 `scripts/dev.mjs` 与 `cordis.patch.yml`**

```javascript
#!/usr/bin/env node
/** 开发期启动：在 dsh checkout 里运行 pnpm dsh web --patch <本工程 overlay>。 */
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dshRoot = resolve(
  process.env.DSH_ROOT ?? join(process.env.HOME ?? '', 'git', 'deepseek-harness'),
)
const overlayPath = join(projectRoot, '.overlay.dev.yml')
const entry = join(projectRoot, 'src', 'index.ts')

const overlay = [
  '# Generated by scripts/dev.mjs — do not edit.',
  '- insert:',
  '    - id: plan-and-execute',
  `      name: ${JSON.stringify(entry)}`,
  '      config:',
  "        onStepFailure: 'pause'",
  '        maxAutoRecoveries: 2',
  "        planDir: '.pae'",
  '',
].join('\n')

writeFileSync(overlayPath, overlay)
const args = ['dsh', 'web', '--patch', overlayPath, ...process.argv.slice(2)]
console.log(`[dev] cwd=${dshRoot}\n[dev] pnpm ${args.join(' ')}`)
const result = spawnSync('pnpm', args, { cwd: dshRoot, stdio: 'inherit' })
process.exit(result.status ?? 1)
```

```yaml
# cordis.patch.yml — 正式安装（dsh plugin --profile <name> add <本工程目录>）。
# 先 pnpm build 生成 lib/，再安装；name 用裸包名，从 profile node_modules 解析。
- insert:
    - id: plan-and-execute
      name: plan-and-execute
      config:
        onStepFailure: 'pause'
        maxAutoRecoveries: 2
        planDir: '.pae'
```

- [ ] **步骤 7：安装并验证**

```bash
pnpm install
```

预期：postinstall 触发 link-host，输出 9 行 `[link-host] @deepseek-ai/... -> ...`，无 `not found` / `refusing`。

```bash
pnpm typecheck && pnpm lint && pnpm build
```

预期：三者全部通过（`lib/index.js` 生成）。

- [ ] **步骤 8：手动冒烟（可选但推荐）**

```bash
pnpm dev
```

预期：dsh Web UI 启动（`http://127.0.0.1:3080`），终端打印 `[plan-and-execute] plugin loaded`；Ctrl-C 退出。

- [ ] **步骤 9：Commit**

```bash
git add -A
git commit -m "chore: 工程脚手架——peerDeps、宿主软链、dev/cordis.patch、tsup/vitest 工具链"
```

---

### 任务 2：state.ts — 事件词汇与折叠

**文件：**
- 创建：`src/state.ts`
- 测试：`test/state.spec.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// test/state.spec.ts
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  buildTodoPayload, foldPae, foldPaePlan, foldStepReports, isPlanModeActive,
} from '../src/state.ts'

let seq = 0
const ev = <T extends string>(type: T, data: object): SessionEvent =>
  { seq += 1; return { seq, type, data } as SessionEvent }

describe('foldPae', () => {
  it('空日志折叠为 none', () => {
    expect(foldPae([]).phase).toBe('none')
  })
  it('last-wins：最后一个 pae/state 胜出', () => {
    const events = [
      ev('pae/state', { phase: 'planning', task: 'T', planDir: '/p' }),
      ev('pae/state', { phase: 'executing', stepIndex: 2 }),
    ]
    const folded = foldPae(events)
    expect(folded.phase).toBe('executing')
    expect(folded.stepIndex).toBe(2)
  })
  it('paused 携带 pausedReason，非 pae 事件被忽略', () => {
    const events = [
      ev('pae/state', { phase: 'planning' }),
      ev('turn/start', { turn: 1 }),
      ev('pae/state', { phase: 'paused', pausedReason: 'failure', stepIndex: 3 }),
    ]
    expect(foldPae(events)).toMatchObject({ phase: 'paused', pausedReason: 'failure', stepIndex: 3 })
  })
})

describe('foldPaePlan', () => {
  it('无计划返回 undefined；replan 取最后一个', () => {
    expect(foldPaePlan([])).toBeUndefined()
    const p1 = ev('pae/plan', { planDir: '/p', steps: [{ file: 'a.md', title: 'A' }] })
    const p2 = ev('pae/plan', { planDir: '/p', steps: [{ file: 'b.md', title: 'B' }] })
    expect(foldPaePlan([p1, p2])?.steps[0]?.file).toBe('b.md')
  })
})

describe('foldStepReports', () => {
  it('按 stepIndex last-wins 聚合', () => {
    const events = [
      ev('pae/step-report', { stepIndex: 1, outcome: 'done', summary: 's1' }),
      ev('pae/step-report', { stepIndex: 2, outcome: 'blocked', summary: 's2' }),
      ev('pae/step-report', { stepIndex: 1, outcome: 'blocked', summary: 's1b' }),
    ]
    const reports = foldStepReports(events)
    expect(reports.get(1)?.summary).toBe('s1b')
    expect(reports.get(2)?.outcome).toBe('blocked')
  })
})

describe('buildTodoPayload', () => {
  it('按状态表构造整表快照，缺省 pending', () => {
    const steps = [{ file: 'a.md', title: 'A' }, { file: 'b.md', title: 'B' }]
    const payload = buildTodoPayload(steps, new Map([[1, 'completed'], [2, 'in_progress']]))
    expect(payload.todos).toEqual([
      { content: '1. A', status: 'completed' },
      { content: '2. B', status: 'in_progress' },
    ])
  })
})

describe('isPlanModeActive', () => {
  it('读宿主 plan/mode 事件，last-wins', () => {
    const events = [
      { seq: 1, type: 'plan/mode', data: { active: true } } as SessionEvent,
      { seq: 2, type: 'plan/mode', data: { active: false } } as SessionEvent,
    ]
    expect(isPlanModeActive(events)).toBe(false)
    expect(isPlanModeActive([events[0]!])).toBe(true)
    expect(isPlanModeActive([])).toBe(false)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

```bash
pnpm test
```

预期：FAIL，`Cannot find module '../src/state.ts'`。

- [ ] **步骤 3：实现 `src/state.ts`**

```ts
/**
 * plan-and-execute 的持久化事件词汇与折叠函数。纯函数，无运行时依赖。
 * @module plan-and-execute/state
 */
import type { SessionEvent, TodoItem } from '@deepseek-ai/dsh-session'

export const PAE_PLUGIN = 'plan-and-execute'

export type PaePhase = 'planning' | 'executing' | 'paused' | 'completed' | 'aborted'
export type PaePausedReason = 'confirm-point' | 'failure' | 'cancelled'

/** manifest 的单步描述（控制流；内容在步骤 md 文件里）。 */
export interface PlanStep {
  readonly file: string
  readonly title: string
  readonly requiresConfirmation?: boolean
}

export interface PaePlanPayload {
  readonly planDir: string
  readonly summary?: string
  readonly steps: readonly PlanStep[]
}

export interface PaeStatePayload {
  readonly phase: PaePhase
  readonly task?: string
  readonly planDir?: string
  /** 1-based，当前正在执行/暂停的步骤；批准后未开始时为 0。 */
  readonly stepIndex?: number
  readonly pausedReason?: PaePausedReason
}

export interface PaeStepReportPayload {
  readonly stepIndex: number
  readonly outcome: 'done' | 'blocked'
  readonly summary: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** 整值替换，last-wins；见规格 §7.1。 */
    'pae/state': PaeStatePayload
    /** 每次审批通过追加一条；折叠取最后。 */
    'pae/plan': PaePlanPayload
    'pae/step-report': PaeStepReportPayload
  }
}

export interface PaeFoldedState {
  readonly phase: PaePhase | 'none'
  readonly task?: string
  readonly planDir?: string
  readonly stepIndex?: number
  readonly pausedReason?: PaePausedReason
}

export function foldPae(events: readonly SessionEvent[], end = events.length): PaeFoldedState {
  let state: PaeFoldedState = { phase: 'none' }
  let index = 0
  for (const event of events) {
    if (index >= end) break
    index++
    if (event.type === 'pae/state') state = event.data
  }
  return state
}

export function foldPaePlan(events: readonly SessionEvent[]): PaePlanPayload | undefined {
  let plan: PaePlanPayload | undefined
  for (const event of events) {
    if (event.type === 'pae/plan') plan = event.data
  }
  return plan
}

export function foldStepReports(events: readonly SessionEvent[]): Map<number, PaeStepReportPayload> {
  const reports = new Map<number, PaeStepReportPayload>()
  for (const event of events) {
    if (event.type === 'pae/step-report') reports.set(event.data.stepIndex, event.data)
  }
  return reports
}

/** 构造 `todo/write` 整表快照；statuses 缺省为 pending（1-based）。 */
export function buildTodoPayload(
  steps: readonly PlanStep[],
  statuses: ReadonlyMap<number, TodoItem['status']>,
): { todos: TodoItem[] } {
  return {
    todos: steps.map((step, index) => ({
      content: `${index + 1}. ${step.title}`,
      status: statuses.get(index + 1) ?? 'pending',
    })),
  }
}

/**
 * 宿主 plan-mode 是否激活。不依赖 dsh-plan-mode 包类型：事件类型不在本工程
 * 编译单元的 SessionEventMap 联合里，读 data 需要一次断言（唯一一处）。
 */
export function isPlanModeActive(events: readonly SessionEvent[]): boolean {
  let active = false
  for (const event of events) {
    if ((event.type as string) === 'plan/mode') {
      active = (event.data as { active: boolean }).active
    }
  }
  return active
}
```

- [ ] **步骤 4：运行测试验证通过**

```bash
pnpm test && pnpm typecheck
```

预期：全部 PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/state.ts test/state.spec.ts
git commit -m "feat: pae/* 事件词汇与折叠（state/plan/step-report、todo 快照、plan-mode 探测）"
```

---

### 任务 3：decision.ts — 步骤结局分类与失败决策

**文件：**
- 创建：`src/decision.ts`
- 测试：`test/decision.spec.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// test/decision.spec.ts
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { classifyStepOutcome, decideAction } from '../src/decision.ts'

let seq = 0
const ev = (type: string, data: object): SessionEvent => ({ seq: ++seq, type, data }) as SessionEvent

describe('classifyStepOutcome', () => {
  it('turn aborted → aborted（优先于 report）', () => {
    const recent = [
      ev('pae/step-report', { stepIndex: 1, outcome: 'done', summary: 'x' }),
      ev('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }),
    ]
    expect(classifyStepOutcome(recent, 1)).toBe('aborted')
  })
  it('turn error / max-tokens / interrupted → failed', () => {
    for (const kind of ['error', 'max-tokens', 'interrupted'] as const) {
      const recent = [ev('turn/end', { turn: 1, reason: { kind } })]
      expect(classifyStepOutcome(recent, 1)).toBe('failed')
    }
  })
  it('completed + 本步 report → done/blocked；他步 report 不算', () => {
    const ok = [
      ev('pae/step-report', { stepIndex: 1, outcome: 'done', summary: 's' }),
      ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ]
    expect(classifyStepOutcome(ok, 1)).toBe('done')
    const blocked = [
      ev('pae/step-report', { stepIndex: 1, outcome: 'blocked', summary: 's' }),
      ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ]
    expect(classifyStepOutcome(blocked, 1)).toBe('blocked')
    const other = [
      ev('pae/step-report', { stepIndex: 2, outcome: 'done', summary: 's' }),
      ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ]
    expect(classifyStepOutcome(other, 1)).toBe('missing-report')
  })
})

describe('decideAction', () => {
  const policy = { onStepFailure: 'pause' as const, maxAutoRecoveries: 2 }
  it('done → advance；aborted → pause(cancelled)', () => {
    expect(decideAction('done', { nudged: false, recoveries: 0, policy })).toEqual({ kind: 'advance' })
    expect(decideAction('aborted', { nudged: false, recoveries: 0, policy }))
      .toEqual({ kind: 'pause', reason: 'cancelled' })
  })
  it('missing-report：首次 nudge，追问后按失败处理', () => {
    expect(decideAction('missing-report', { nudged: false, recoveries: 0, policy }))
      .toEqual({ kind: 'nudge' })
    expect(decideAction('missing-report', { nudged: true, recoveries: 0, policy }))
      .toEqual({ kind: 'pause', reason: 'failure' })
  })
  it('failure 默认 pause；auto-recover 在限额内 recover，超限 pause', () => {
    expect(decideAction('failed', { nudged: false, recoveries: 0, policy }))
      .toEqual({ kind: 'pause', reason: 'failure' })
    const auto = { onStepFailure: 'auto-recover' as const, maxAutoRecoveries: 2 }
    expect(decideAction('blocked', { nudged: false, recoveries: 1, policy: auto }))
      .toEqual({ kind: 'recover' })
    expect(decideAction('blocked', { nudged: false, recoveries: 2, policy: auto }))
      .toEqual({ kind: 'pause', reason: 'failure' })
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

```bash
pnpm test
```

预期：FAIL，`Cannot find module '../src/decision.ts'`。

- [ ] **步骤 3：实现 `src/decision.ts`**

```ts
/**
 * 步骤结局分类与失败策略决策。纯函数。
 * @module plan-and-execute/decision
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { PaePausedReason, PaeStepReportPayload } from './state.ts'

export type StepOutcome = 'done' | 'blocked' | 'failed' | 'aborted' | 'missing-report'

/**
 * 对"自注入步骤指令后新追加的事件"分类本步结局。优先级：turn 结束原因 >
 * 本步 report（error/aborted 后到达的 report 不翻案）> 缺报。
 */
export function classifyStepOutcome(recent: readonly SessionEvent[], stepIndex: number): StepOutcome {
  let report: PaeStepReportPayload | undefined
  let turnEnd: { reason: { kind: string } } | undefined
  for (const event of recent) {
    if (event.type === 'pae/step-report' && event.data.stepIndex === stepIndex) report = event.data
    if (event.type === 'turn/end') turnEnd = event.data as { reason: { kind: string } }
  }
  const kind = turnEnd?.reason.kind
  if (kind === 'aborted') return 'aborted'
  if (kind === 'error' || kind === 'max-tokens' || kind === 'interrupted') return 'failed'
  if (report !== undefined) return report.outcome === 'done' ? 'done' : 'blocked'
  return 'missing-report'
}

export type StepAction =
  | { kind: 'advance' }
  | { kind: 'nudge' }
  | { kind: 'recover' }
  | { kind: 'pause'; reason: Extract<PaePausedReason, 'failure' | 'cancelled'> }

export interface FailurePolicy {
  readonly onStepFailure: 'pause' | 'auto-recover'
  readonly maxAutoRecoveries: number
}

export function decideAction(outcome: StepOutcome, context: {
  nudged: boolean
  recoveries: number
  policy: FailurePolicy
}): StepAction {
  switch (outcome) {
    case 'done': return { kind: 'advance' }
    case 'aborted': return { kind: 'pause', reason: 'cancelled' }
    case 'missing-report': return context.nudged ? failureAction(context) : { kind: 'nudge' }
    case 'blocked':
    case 'failed': return failureAction(context)
  }
}

function failureAction(context: { recoveries: number; policy: FailurePolicy }): StepAction {
  const { onStepFailure, maxAutoRecoveries } = context.policy
  if (onStepFailure === 'auto-recover' && context.recoveries < maxAutoRecoveries) {
    return { kind: 'recover' }
  }
  return { kind: 'pause', reason: 'failure' }
}
```

- [ ] **步骤 4：运行测试验证通过**

```bash
pnpm test && pnpm typecheck
```

预期：全部 PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/decision.ts test/decision.spec.ts
git commit -m "feat: 步骤结局分类与失败策略决策（nudge/auto-recover/pause 矩阵）"
```

---

### 任务 4：manifest.ts — 步骤文件校验

**文件：**
- 创建：`src/manifest.ts`
- 测试：`test/manifest.spec.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// test/manifest.spec.ts
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { validateManifest } from '../src/manifest.ts'

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pae-manifest-'))
  await writeFile(join(dir, 'step-01.md'), '# Step 1\ncontent', 'utf8')
  await writeFile(join(dir, 'empty.md'), '', 'utf8')
  await mkdir(join(dir, 'subdir'))
})
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

describe('validateManifest', () => {
  it('全部合法 → ok', async () => {
    const result = await validateManifest(dir, [{ file: 'step-01.md', title: 'S1' }])
    expect(result).toEqual({ ok: true })
  })
  it('空步骤清单 → 报错', async () => {
    const result = await validateManifest(dir, [])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues[0]?.problem).toContain('至少一步')
  })
  it('绝对路径 / .. 逃逸 → 报错（不触盘）', async () => {
    const result = await validateManifest(dir, [
      { file: '/etc/passwd', title: 'A' },
      { file: '../escape.md', title: 'B' },
    ])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues).toHaveLength(2)
  })
  it('悬空 / 空文件 / 目录 → 报错', async () => {
    const result = await validateManifest(dir, [
      { file: 'missing.md', title: 'A' },
      { file: 'empty.md', title: 'B' },
      { file: 'subdir', title: 'C' },
    ])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues.map(i => i.file)).toEqual(['missing.md', 'empty.md', 'subdir'])
    }
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

```bash
pnpm test
```

预期：FAIL，`Cannot find module '../src/manifest.ts'`。

- [ ] **步骤 3：实现 `src/manifest.ts`**

```ts
/**
 * manifest 步骤文件校验：路径安全（必须相对 planDir、无 .. 段）+ 存在/非空/是文件。
 * @module plan-and-execute/manifest
 */
import { stat } from 'node:fs/promises'
import { isAbsolute, join, sep } from 'node:path'
import type { PlanStep } from './state.ts'

export interface ManifestIssue {
  readonly index: number
  readonly file: string
  readonly problem: string
}

export type ManifestCheck = { ok: true } | { ok: false; issues: readonly ManifestIssue[] }

export async function validateManifest(
  planDir: string,
  steps: readonly PlanStep[],
): Promise<ManifestCheck> {
  if (steps.length === 0) {
    return { ok: false, issues: [{ index: -1, file: '', problem: '计划至少需要一步' }] }
  }
  const issues: ManifestIssue[] = []
  for (const [index, step] of steps.entries()) {
    const file = step.file
    if (file.trim() === '' || isAbsolute(file) || file.split(sep).includes('..')) {
      issues.push({ index, file, problem: 'file 必须是相对 planDir 的安全路径（非空、非绝对、不含 ..）' })
      continue
    }
    try {
      const info = await stat(join(planDir, file))
      if (!info.isFile()) issues.push({ index, file, problem: '不是普通文件' })
      else if (info.size === 0) issues.push({ index, file, problem: '文件为空' })
    } catch {
      issues.push({ index, file, problem: '文件不存在（请先写入步骤 md 文件再提交）' })
    }
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues }
}
```

- [ ] **步骤 4：运行测试验证通过**

```bash
pnpm test && pnpm typecheck
```

预期：全部 PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/manifest.ts test/manifest.spec.ts
git commit -m "feat: manifest 步骤文件校验（路径安全、存在、非空）"
```

---

### 任务 5：prompts.ts — 阶段 prompt 与注入消息

**文件：**
- 创建：`src/prompts.ts`
- 测试：`test/prompts.spec.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// test/prompts.spec.ts
import { describe, expect, it } from 'vitest'
import {
  EXECUTING_SECTION_BODY, PLANNING_SECTION_BODY, completionDetail, kickoffInstruction,
  nudgeInstruction, planReviewDetail, recoverInstruction, replanInstruction,
  resumePlanningInstruction, stepInstruction,
} from '../src/prompts.ts'

describe('section 正文', () => {
  it('planning 正文含 planDir、submit_plan 与文件命名要求', () => {
    const text = PLANNING_SECTION_BODY('/ws/.pae/s/20260826')
    expect(text).toContain('/ws/.pae/s/20260826')
    expect(text).toContain('submit_plan')
    expect(text).toContain('step-NN')
    expect(text).toContain('requiresConfirmation')
  })
  it('executing 正文含 report_step 与 todo 纪律', () => {
    const text = EXECUTING_SECTION_BODY()
    expect(text).toContain('report_step')
    expect(text).toContain('todo_write')
  })
})

describe('注入消息', () => {
  it('kickoff 含任务原文与 planDir，source 标记为 plugin instruction', () => {
    const message = kickoffInstruction('重构登录模块', '/p')
    expect(message.role).toBe('user')
    expect(message.content[0]).toMatchObject({ type: 'text' })
    const text = (message.content[0] as { text: string }).text
    expect(text).toContain('重构登录模块')
    expect(text).toContain('/p')
    expect(message.source).toMatchObject({ kind: 'plugin', plugin: 'plan-and-execute', form: 'instruction' })
  })
  it('stepInstruction 含序号、标题、文件路径与 report_step 要求', () => {
    const message = stepInstruction(2, 5, { file: 'step-02-x.md', title: '写测试' }, '/p')
    const text = (message.content[0] as { text: string }).text
    expect(text).toContain('2/5')
    expect(text).toContain('写测试')
    expect(text).toContain('/p/step-02-x.md')
    expect(text).toContain('report_step')
  })
  it('nudge/recover/replan/resume 均为非空 instruction', () => {
    for (const m of [nudgeInstruction(), recoverInstruction('turn 以 error 结束'),
      replanInstruction('上一版计划被用户驳回：粒度太粗', 3), resumePlanningInstruction()]) {
      expect(m.source).toMatchObject({ kind: 'plugin', form: 'instruction' })
      expect((m.content[0] as { text: string }).text.length).toBeGreaterThan(0)
    }
  })
})

describe('详情渲染', () => {
  it('planReviewDetail 列出步骤与确认点标记', () => {
    const detail = planReviewDetail([
      { file: 'step-01-a.md', title: 'A' },
      { file: 'step-02-b.md', title: 'B', requiresConfirmation: true },
    ], '/p')
    expect(detail).toContain('1. A — step-01-a.md')
    expect(detail).toContain('2. B — step-02-b.md ⚠ 确认点')
  })
  it('completionDetail 汇总各步结局，跳过步标注', () => {
    const detail = completionDetail([
      { file: 'a.md', title: 'A' }, { file: 'b.md', title: 'B' },
    ], new Map([[1, { stepIndex: 1, outcome: 'done', summary: '完成 A' }]]), new Set([2]))
    expect(detail).toContain('1. A — done：完成 A')
    expect(detail).toContain('2. B — skipped')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

```bash
pnpm test
```

预期：FAIL，`Cannot find module '../src/prompts.ts'`。

- [ ] **步骤 3：实现 `src/prompts.ts`**

```ts
/**
 * 两阶段 system-prompt 正文与全部注入消息构造。纯函数。
 * @module plan-and-execute/prompts
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { PAE_PLUGIN, type PaePlanPayload, type PaeStepReportPayload, type PlanStep } from './state.ts'

function instruction(text: string, summary: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: PAE_PLUGIN, form: 'instruction', summary },
  })
}

export function PLANNING_SECTION_BODY(planDir: string): string {
  return [
    '## Plan-and-Execute：规划阶段',
    '你在 plan-and-execute 编排的规划阶段。先用只读工具充分调研，再制定分步计划。',
    `- 每一步写一个 Markdown 文件到 ${planDir}/：命名 step-NN-<短横线小写标识>.md，`,
    '  内容包含：目标、涉及文件、做法、验收标准。',
    '- 步骤要可独立执行、可验证、粒度适中；单步计划也合法。',
    '- 不可逆、外部影响、大范围写操作的步骤标记 requiresConfirmation: true。',
    '- 本阶段不做变更性操作：写文件仅限上述计划目录。',
    '- 全部步骤文件写完后，调用 submit_plan 提交步骤清单（file 相对计划目录）。',
    '  用户会审批；被驳回时按反馈修改文件后重新提交。',
  ].join('\n')
}

export function EXECUTING_SECTION_BODY(): string {
  return [
    '## Plan-and-Execute：执行阶段',
    '你在 plan-and-execute 编排的执行阶段，每次只处理"当前这一步"：',
    '- 只做当前步骤要求的事，不做后续步骤（除非当前步骤文件明确要求）。',
    '- 开始前先读取当前步骤的 Markdown 文件。',
    '- 本步结束前必须调用 report_step 汇报：完成用 outcome=done，受阻用 outcome=blocked，如实汇报，不谎报。',
    '- 发现计划有误时：完成当前步能完成的部分并在 summary 说明，或 report_step(blocked) 说明原因；不要自行跳步或改做其他步骤。',
    '- todo 清单由插件维护：不要调用 todo_write（整表替换会覆盖插件写入的进度）。',
  ].join('\n')
}

export function kickoffInstruction(task: string, planDir: string): UserMessage {
  return instruction(
    [
      `Plan-and-Execute 编排开始。任务：${task}`,
      `请进入规划阶段：调研后把每一步写成 Markdown 文件到 ${planDir}/，然后调用 submit_plan 提交清单供审批。`,
    ].join('\n'),
    `plan-and-execute：开始规划（${task}）`,
  )
}

export function stepInstruction(index: number, total: number, step: PlanStep, planDir: string): UserMessage {
  return instruction(
    [
      `执行计划第 ${index}/${total} 步：${step.title}`,
      `完整内容见 ${planDir}/${step.file}，先读取该文件再动手。`,
      '完成或受阻都必须调用 report_step 汇报（done/blocked + summary），不要处理其他步骤。',
    ].join('\n'),
    `plan-and-execute：执行第 ${index}/${total} 步（${step.title}）`,
  )
}

export function nudgeInstruction(): UserMessage {
  return instruction(
    '本步尚未汇报结果。请立即调用 report_step（outcome=done 或 blocked，summary 必填）汇报当前步骤的结局。',
    'plan-and-execute：要求补交 report_step',
  )
}

export function recoverInstruction(diagnostic: string): UserMessage {
  return instruction(
    [
      `上一步执行未成功（${diagnostic}）。请自行调整做法重试当前步骤，或修正后续步骤文件后继续；`,
      '确无法完成则调用 report_step(outcome=blocked, summary=原因)。完成后仍须 report_step 汇报。',
    ].join('\n'),
    'plan-and-execute：自愈重试当前步骤',
  )
}

export function replanInstruction(feedback: string, previousSteps: number): UserMessage {
  return instruction(
    [
      `用户要求回到规划阶段（原有 ${previousSteps} 步的计划未通过/被中止）。反馈：${feedback || '（无文字反馈）'}`,
      '请按反馈修改步骤 Markdown 文件（可增删改步骤），然后重新调用 submit_plan 提交审批。',
    ].join('\n'),
    'plan-and-execute：回到规划阶段',
  )
}

export function resumePlanningInstruction(): UserMessage {
  return instruction(
    '编排恢复：继续完成规划阶段的调研与步骤文件编写，完成后调用 submit_plan 提交审批。',
    'plan-and-execute：恢复规划',
  )
}

export function planReviewDetail(steps: readonly PlanStep[], planDir: string): string {
  const lines = steps.map((step, index) => {
    const mark = step.requiresConfirmation === true ? ' ⚠ 确认点' : ''
    return `${index + 1}. ${step.title} — ${step.file}${mark}`
  })
  return [`计划目录：${planDir}`, ...lines].join('\n')
}

export function completionDetail(
  steps: readonly PlanStep[],
  reports: ReadonlyMap<number, PaeStepReportPayload>,
  skipped: ReadonlySet<number>,
): string {
  const lines = steps.map((step, index) => {
    const i = index + 1
    if (skipped.has(i)) return `${i}. ${step.title} — skipped`
    const report = reports.get(i)
    return `${i}. ${step.title} — ${report?.outcome ?? 'done'}：${report?.summary ?? ''}`
  })
  return lines.join('\n')
}

export function planSummaryLine(plan: PaePlanPayload): string {
  return plan.summary ?? `共 ${plan.steps.length} 步`
}
```

- [ ] **步骤 4：运行测试验证通过**

```bash
pnpm test && pnpm typecheck
```

预期：全部 PASS（若 vitest 因解析 `@deepseek-ai/dsh-llm` 运行时失败，先确认 `pnpm install` 的 link-host 已建链、dsh 仓库已 `pnpm run build`；这是唯一运行时宿主依赖，不得改成类型导入绕过——消息构造必须真实调用 `createUserMessage`）。

- [ ] **步骤 5：Commit**

```bash
git add src/prompts.ts test/prompts.spec.ts
git commit -m "feat: 两阶段 prompt 正文与全部注入消息构造"
```

---

### 任务 6：orchestrator.ts（一）— 启动、审批与主执行路径

**文件：**
- 创建：`src/orchestrator.ts`
- 测试：`test/orchestrator.spec.ts`（本任务建骨架与假件，后续任务扩展用例）

本任务交付：`Orchestrator.begin`（进入 planning + steer + 挂起等待审批）、`submitPlan`（校验→审批弹窗→批准则落 `pae/plan`/`pae/state`/`todo/write` 并驱动执行循环）、`run` 主路径（无确认点、每步 done、完成通知）。异常路径（nudge/recover/pause）留桩，任务 7 补全。

- [ ] **步骤 1：编写失败的测试**

```ts
// test/orchestrator.spec.ts
import { describe, expect, it, vi } from 'vitest'
import type { SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type { DriveAgent, DriveSession } from '../src/orchestrator.ts'

/** 假 Session：内存事件数组。 */
export class FakeSession implements DriveSession {
  readonly events: SessionEvent[] = []
  private seq = 0
  append(eventType: DriveSession['append'] extends (t: infer T, ...a: never) => unknown ? T : never, data: object): void {
    this.seq += 1
    this.events.push({ seq: this.seq, type: eventType, data } as SessionEvent)
  }
}

/** 假 Agent：whenIdle 时执行脚本化回合（写 turn/report 事件）。 */
export class FakeAgent implements DriveAgent {
  readonly session = new FakeSession()
  steered: UserMessage[] = []
  private scripts: Array<() => void> = []
  steer(message: UserMessage): void { this.steered.push(message) }
  whenIdle(): Promise<void> { this.scripts.shift()?.(); return Promise.resolve() }
  /** 预置：下一次 whenIdle 完成一个 turn，可带 report。 */
  scriptTurn(reason: string, report?: { outcome: 'done' | 'blocked'; summary: string }, stepIndex = 1): void {
    this.scripts.push(() => {
      const s = this.session as FakeSession
      s.append('turn/start' as never, { turn: 1 })
      if (report) s.append('pae/step-report', { stepIndex, outcome: report.outcome, summary: report.summary })
      s.append('turn/end' as never, { turn: 1, reason: { kind: reason } })
    })
  }
}

/** 假 ask：脚本化回答队列。 */
export function fakeAsk(...answers: Array<AskUserQuestionAnswer | Error>): {
  ask: (questions: AskUserQuestionItem[]) => Promise<AskUserQuestionAnswer>
  received: AskUserQuestionItem[][]
} {
  const queue = [...answers]
  const received: AskUserQuestionItem[][] = []
  return {
    ask: async (questions) => {
      received.push(questions)
      const next = queue.shift()
      if (next instanceof Error) throw next
      if (next === undefined) throw new Error('fakeAsk: no scripted answer')
      return next
    },
    received,
  }
}

export const answer = (id: string, selected: string, custom?: string): AskUserQuestionAnswer =>
  ({ answers: [{ id, selected: [selected], custom }] })

const planDir = '/tmp/pae-test-plan'

/** 通用构造器：approve 之后的 ask 回答全部由调用方脚本化。 */
export async function makeOrchestrator(
  steps: Array<{ file: string; title: string; requiresConfirmation?: boolean }>,
  askScript: Array<AskUserQuestionAnswer | Error>,
) {
  const { Orchestrator } = await import('../src/orchestrator.ts')
  const agent = new FakeAgent()
  const { ask, received } = fakeAsk(...askScript)
  const orchestrator = new Orchestrator({
    agent, ask,
    config: { onStepFailure: 'pause', maxAutoRecoveries: 2, planRoot: '.pae' },
    planDir,
  })
  orchestrator.begin('示例任务')
  const verdict = await orchestrator.submitPlan(steps, '测试计划')
  return { orchestrator, agent, ask, received, verdict, steps }
}

describe('主执行路径', () => {
  it('begin → planning 状态 + kickoff 注入', async () => {
    const { Orchestrator } = await import('../src/orchestrator.ts')
    const agent = new FakeAgent()
    const { ask } = fakeAsk()
    const orchestrator = new Orchestrator({ agent, ask, config: { onStepFailure: 'pause', maxAutoRecoveries: 2, planRoot: '.pae' }, planDir })
    orchestrator.begin('做某事')
    expect(agent.steered).toHaveLength(1)
    const state = agent.session.events.find(e => e.type === 'pae/state')
    expect(state?.data).toMatchObject({ phase: 'planning', task: '做某事', planDir })
  })

  it('submitPlan 批准：落 pae/plan + executing + todo 全 pending，逐步执行到完成', async () => {
    const steps = [{ file: 'a.md', title: 'A' }, { file: 'b.md', title: 'B' }]
    const { agent, verdict } = await makeOrchestrator(steps, [answer('pae-approve', '批准')])
    expect(verdict).toEqual({ approved: true })
    agent.scriptTurn('completed', { outcome: 'done', summary: '完成 A' }, 1)
    agent.scriptTurn('completed', { outcome: 'done', summary: '完成 B' }, 2)
    await vi.waitFor(() => {
      const last = [...agent.session.events].reverse().find(e => e.type === 'pae/state')
      expect(last?.data).toMatchObject({ phase: 'completed' })
    })
    const todos = [...agent.session.events].reverse().find(e => e.type === 'todo/write')
    expect(todos?.data).toMatchObject({ todos: [
      { content: '1. A', status: 'completed' }, { content: '2. B', status: 'completed' },
    ] })
    // kickoff + 两条步骤指令
    expect(agent.steered.filter(m => m.source.kind === 'plugin')).toHaveLength(3)
  })

  it('submitPlan 驳回：反馈文本返回给工具层抛错', async () => {
    const { agent, verdict } = await makeOrchestrator(
      [{ file: 'a.md', title: 'A' }],
      [answer('pae-approve', '继续修改', '粒度太粗')],
    )
    void agent
    expect(verdict.approved).toBe(false)
    if (!verdict.approved) expect(verdict.error).toContain('粒度太粗')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

```bash
pnpm test
```

预期：FAIL，`Cannot find module '../src/orchestrator.ts'`。

- [ ] **步骤 3：实现 `src/orchestrator.ts`（第一版）**

```ts
/**
 * plan-and-execute 编排器：状态机 + 步进驱动循环。
 * 只依赖窄结构接口（DriveAgent/DriveSession/AskFn），全部可离线单测；
 * 真实 Agent → DriveAgent 的适配在 src/index.ts。
 * @module plan-and-execute/orchestrator
 */
import type { SessionEvent, TodoItem, UserMessage } from '@deepseek-ai/dsh-session'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { classifyStepOutcome, decideAction, type FailurePolicy, type StepOutcome } from './decision.ts'
import { validateManifest } from './manifest.ts'
import {
  completionDetail, kickoffInstruction, nudgeInstruction, planReviewDetail, recoverInstruction,
  replanInstruction, stepInstruction,
} from './prompts.ts'
import { buildTodoPayload, foldPae, foldStepReports, type PaePausedReason, type PaePlanPayload, type PlanStep } from './state.ts'

export interface DriveSession {
  readonly events: readonly SessionEvent[]
  append(eventType: 'pae/state' | 'pae/plan' | 'pae/step-report' | 'todo/write', data: object): void
}

export interface DriveAgent {
  readonly session: DriveSession
  steer(message: UserMessage): void
  whenIdle(): Promise<void>
}

export type AskFn = (questions: AskUserQuestionItem[]) => Promise<AskUserQuestionAnswer>

export interface ResolvedConfig extends FailurePolicy {
  /** 相对会话 cwd 的计划根目录（配置值）。 */
  readonly planRoot: string
}

export const APPROVE_LABEL = '批准'
export const KEEP_LABEL = '继续修改'
export const PAUSE_RETRY = '重试该步'
export const PAUSE_SKIP = '跳过该步'
export const PAUSE_NEXT = '继续下一步'
export const PAUSE_REPLAN = '回到计划阶段'
export const PAUSE_TERMINATE = '终止'
export const CONFIRM_CONTINUE = '继续'
export const DONE_ACK = '知道了'

export class Orchestrator {
  private disposed = false
  private approval: PromiseWithResolvers<PaePlanPayload> | undefined
  private statuses = new Map<number, TodoItem['status']>()
  private skipped = new Set<number>()

  constructor(private readonly deps: {
    agent: DriveAgent
    ask: AskFn
    config: ResolvedConfig
    planDir: string
  }) {}

  private get session(): DriveSession { return this.deps.agent.session }

  private append(eventType: DriveSession['append'] extends (t: infer T, ...a: never) => unknown ? T : never, data: object): void {
    this.session.append(eventType, data)
  }

  /** 命令入口：进入规划阶段并注入 kickoff。 */
  begin(task: string): void {
    this.append('pae/state', { phase: 'planning', task, planDir: this.deps.planDir })
    this.deps.agent.steer(kickoffInstruction(task, this.deps.planDir))
    this.armApproval()
  }

  private armApproval(): void {
    this.approval = Promise.withResolvers<PaePlanPayload>()
    void this.afterApproval()
  }

  private async afterApproval(): Promise<void> {
    const gate = this.approval
    if (gate === undefined) return
    try {
      const plan = await gate.promise
      if (!this.disposed) await this.run(plan, 1)
    } catch (error) {
      this.append('pae/state', { phase: 'aborted', task: this.folded().task, planDir: this.deps.planDir })
      void error
    }
  }

  private folded() { return foldPae(this.session.events) }

  /** submit_plan 工具入口：校验 + 审批。批准即启动执行循环。 */
  async submitPlan(steps: readonly PlanStep[], summary?: string): Promise<{ approved: true } | { approved: false; error: string }> {
    if (this.folded().phase !== 'planning') {
      return { approved: false, error: 'submit_plan 仅在规划阶段可用（当前不在 plan-and-execute 规划中）' }
    }
    const check = await validateManifest(this.deps.planDir, steps)
    if (!check.ok) {
      const lines = check.issues.map(issue => `- ${issue.file === '' ? '(整体)' : issue.file}: ${issue.problem}`)
      return { approved: false, error: `计划文件校验失败，请修复后重新提交：\n${lines.join('\n')}` }
    }
    const answer = await this.askOrDismiss([{
      id: 'pae-approve',
      header: 'Plan review',
      question: `批准此计划（共 ${steps.length} 步）并开始执行？`,
      detail: planReviewDetail(steps, this.deps.planDir),
      options: [
        { label: APPROVE_LABEL, description: '离开规划阶段，开始逐步执行' },
        { label: KEEP_LABEL, description: '留在规划阶段；你的反馈将回给模型修改后重新提交' },
      ],
      intent: { kind: 'plan-review', approve: APPROVE_LABEL },
    }])
    if (answer === 'dismissed') {
      return { approved: false, error: '用户暂时搁置了审批。留在规划阶段，等待用户下一条消息。' }
    }
    const item = answer.answers.find(entry => entry.id === 'pae-approve')
    if (item?.selected[0] !== APPROVE_LABEL) {
      const feedback = item?.custom?.trim()
      return { approved: false, error: feedback && feedback !== '' ? `用户要求继续修改计划，反馈：${feedback}` : '用户要求继续修改计划；请调整后重新提交。' }
    }
    const plan: PaePlanPayload = { planDir: this.deps.planDir, steps, ...(summary === undefined ? {} : { summary }) }
    this.statuses.clear()
    this.skipped.clear()
    this.append('pae/plan', plan)
    this.append('pae/state', { phase: 'executing', stepIndex: 0, planDir: plan.planDir, task: this.folded().task })
    this.append('todo/write', buildTodoPayload(plan.steps, this.statuses))
    this.approval?.resolve(plan)
    return { approved: true }
  }

  /** report_step 工具入口。 */
  reportStep(stepIndex: number, outcome: 'done' | 'blocked', summary: string): void {
    const folded = this.folded()
    if (folded.phase !== 'executing' || folded.stepIndex !== stepIndex) {
      throw new Error(`report_step 与当前执行步骤不符（当前：第 ${folded.stepIndex ?? '?'} 步，收到：第 ${stepIndex} 步）`)
    }
    this.append('pae/step-report', { stepIndex, outcome, summary })
  }

  /** 注入指令后等待本步结局。 */
  private async settle(mark: number, stepIndex: number): Promise<StepOutcome> {
    await this.deps.agent.whenIdle()
    if (this.disposed) return 'aborted'
    return classifyStepOutcome(this.session.events.slice(mark), stepIndex)
  }

  private mark(stepIndex: number, status: TodoItem['status'], plan: PaePlanPayload): void {
    this.statuses.set(stepIndex, status)
    this.append('todo/write', buildTodoPayload(plan.steps, this.statuses))
  }

  /** 执行主循环：from 为 1-based 起始步。 */
  private async run(plan: PaePlanPayload, from: number): Promise<void> {
    const total = plan.steps.length
    let i = from
    let nudged = false
    let recoveries = 0
    while (i <= total) {
      if (this.disposed) return
      const step = plan.steps[i - 1]!
      const check = await validateManifest(plan.planDir, [step])
      if (!check.ok) {
        const problem = check.issues[0]?.problem ?? '步骤文件不可用'
        const choice = await this.pause('failure', i, plan, `步骤文件校验失败：${problem}`)
        if (choice === 'terminate') return this.finish('aborted', plan)
        if (choice === 'replan') return this.enterReplan(plan, choice)
        if (choice === 'skip' || choice === 'next') { this.skipped.add(i); i += 1; continue }
        continue // retry：重走同一 i
      }
      this.append('pae/state', { phase: 'executing', stepIndex: i, planDir: plan.planDir, task: this.folded().task })
      this.mark(i, 'in_progress', plan)
      this.deps.agent.steer(stepInstruction(i, total, step, plan.planDir))
      let outcome = await this.settle(this.session.events.length, i)
      // 决策循环：nudge/recover 后重新注入并重判，直到 advance 或 pause
      while (true) {
        if (this.disposed) return
        const action = decideAction(outcome, { nudged, recoveries, policy: this.deps.config })
        if (action.kind === 'advance') break
        if (action.kind === 'nudge') {
          nudged = true
          this.deps.agent.steer(nudgeInstruction())
          outcome = await this.settle(this.session.events.length, i)
          continue
        }
        if (action.kind === 'recover') {
          recoveries += 1
          this.deps.agent.steer(recoverInstruction(outcome))
          outcome = await this.settle(this.session.events.length, i)
          continue
        }
        const choice = await this.pause(action.reason, i, plan, `第 ${i}/${total} 步（${step.title}）未完成（${outcome}）`)
        if (choice === 'terminate') return this.finish('aborted', plan)
        if (choice === 'replan') return this.enterReplan(plan, choice)
        if (choice === 'skip') { this.skipped.add(i); break }
        if (choice === 'next') { this.mark(i, 'completed', plan); break }
        continue // retry 或 dismissed：重走当前步（dismissed 的正确语义在任务 7 修正为 return）
      }
      i += 1
      nudged = false
      recoveries = 0
    }
    this.finish('completed', plan)
  }

  /** 暂停交互（五选项）。弹窗被关视为保持暂停、等待用户消息。 */
  private async pause(reason: PaePausedReason, stepIndex: number, plan: PaePlanPayload, diagnostic: string): Promise<'retry' | 'skip' | 'next' | 'replan' | 'terminate' | 'dismissed'> {
    this.append('pae/state', {
      phase: 'paused', pausedReason: reason, stepIndex, planDir: plan.planDir, task: this.folded().task,
    })
    const answer = await this.askOrDismiss([{
      id: 'pae-pause',
      header: 'Plan-and-Execute 已暂停',
      question: `第 ${stepIndex}/${plan.steps.length} 步暂停（${reason}）：${diagnostic}`,
      options: [
        { label: PAUSE_RETRY, description: '重新注入本步指令再执行一次' },
        { label: PAUSE_SKIP, description: '跳过本步（todo 保持 pending，终局标注 skipped）' },
        { label: PAUSE_NEXT, description: '接受现状，继续下一步' },
        { label: PAUSE_REPLAN, description: '回到规划阶段修改计划（可在弹窗输入反馈）' },
        { label: PAUSE_TERMINATE, description: '终止整个编排' },
      ],
    }])
    if (answer === 'dismissed') return 'dismissed'
    const item = answer.answers.find(entry => entry.id === 'pae-pause')
    const label = item?.selected[0]
    this.lastFeedback = item?.custom?.trim() ?? ''
    if (label === PAUSE_RETRY) return 'retry'
    if (label === PAUSE_SKIP) return 'skip'
    if (label === PAUSE_NEXT) return 'next'
    if (label === PAUSE_REPLAN) return 'replan'
    if (label === PAUSE_TERMINATE) return 'terminate'
    return 'dismissed'
  }

  private lastFeedback = ''

  private async enterReplan(plan: PaePlanPayload, _feedback: string): Promise<void> {
    const task = this.folded().task
    this.append('pae/state', { phase: 'planning', task, planDir: plan.planDir })
    this.deps.agent.steer(replanInstruction(this.lastFeedback, plan.steps.length))
    this.armApproval()
  }

  private finish(phase: 'completed' | 'aborted', plan: PaePlanPayload): void {
    const task = this.folded().task
    this.append('pae/state', { phase, task, planDir: plan.planDir })
    if (phase === 'completed') {
      this.append('todo/write', buildTodoPayload(plan.steps, this.statuses))
      void this.askOrDismiss([{
        id: 'pae-done',
        header: 'Plan-and-Execute 完成',
        question: '计划已全部执行完成。',
        detail: completionDetail(plan.steps, foldStepReports(this.session.events), this.skipped),
        options: [{ label: DONE_ACK, description: '关闭通知' }],
      }])
    }
  }

  /** ask 包装：任何抛错（含 ASK_CANCELLED）折叠为 'dismissed'。 */
  private async askOrDismiss(questions: AskUserQuestionItem[]): Promise<AskUserQuestionAnswer | 'dismissed'> {
    try {
      return await this.deps.ask(questions)
    } catch {
      return 'dismissed'
    }
  }

  dispose(): void { this.disposed = true }
}
```

注意：本版 `'dismissed'` 落入 `continue`（等同 retry，会立刻重新注入该步）——这是**刻意留待任务 7 修正的错误行为**：dismissed 的正确语义是"保持 paused、停止驱动、等命令重入或 revive"。任务 7 的对应用例会先红后绿地修掉它。

- [ ] **步骤 4：运行测试验证通过**

```bash
pnpm test && pnpm typecheck
```

预期：`主执行路径` 三个用例 PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/orchestrator.ts test/orchestrator.spec.ts
git commit -m "feat: 编排器核心——启动、审批循环与步进执行主路径"
```

---

### 任务 7：orchestrator.ts（二）— nudge、auto-recover 与暂停五选项

**文件：**
- 修改：`src/orchestrator.ts`（任务 6 已含 nudge/recover/pause 代码；本任务补 dismissed 收敛 + 用例覆盖）
- 测试：`test/orchestrator.spec.ts`（追加）

- [ ] **步骤 1：追加失败的测试**

在 `test/orchestrator.spec.ts` 末尾追加（复用任务 6 的假件 `FakeSession/FakeAgent/fakeAsk/answer/makeOrchestrator`）：

```ts
describe('异常路径', () => {
  it('completed 但未汇报 → 追问一次；补报 done 后继续', async () => {
    const { agent } = await makeOrchestrator([{ file: 'a.md', title: 'A' }], [answer('pae-approve', '批准')])
    agent.scriptTurn('completed', undefined)                                        // 第一次：无 report
    agent.scriptTurn('completed', { outcome: 'done', summary: '补报' }, 1)         // 追问后：补报
    await vi.waitFor(() => {
      const last = [...agent.session.events].reverse().find(e => e.type === 'pae/state')
      expect(last?.data).toMatchObject({ phase: 'completed' })
    })
    // steered 里应有一条"补交 report_step"的追问消息
    const texts = agent.steered.map(m => (m.content[0] as { text: string }).text)
    expect(texts.some(t => t.includes('report_step'))).toBe(true)
  })
})
```

再加一组暂停/恢复决策用例（其中 `dismissed` 用例在任务 6 的 v1 实现上是**红的**——见任务 6 末尾注记）：

```ts
describe('暂停与恢复决策', () => {
  it('blocked → 五选项；重试 → 同一步重新注入指令', async () => {
    const { agent } = await makeOrchestrator(
      [{ file: 'a.md', title: 'A' }, { file: 'b.md', title: 'B' }],
      [answer('pae-approve', '批准'), answer('pae-pause', '重试该步')],
    )
    agent.scriptTurn('completed', { outcome: 'blocked', summary: '卡住' }, 1)
    agent.scriptTurn('completed', { outcome: 'done', summary: '重试成功' }, 1)
    await vi.waitFor(() => {
      const state = [...agent.session.events].reverse().find(e => e.type === 'pae/state')
      expect(state?.data).toMatchObject({ phase: 'executing', stepIndex: 2 })
    })
    const texts = agent.steered.map(m => (m.content[0] as { text: string }).text)
    expect(texts.filter(t => t.includes('执行计划第 1/2 步')).length).toBe(2) // 同一步注入两次
  })

  it('turn aborted（用户取消）→ paused(cancelled)，弹窗被关 → dismissed 保持暂停', async () => {
    const { agent } = await makeOrchestrator(
      [{ file: 'a.md', title: 'A' }],
      [answer('pae-approve', '批准'), new Error('dismissed')],
    )
    agent.scriptTurn('aborted')
    await vi.waitFor(() => {
      const state = [...agent.session.events].reverse().find(e => e.type === 'pae/state')
      expect(state?.data).toMatchObject({ phase: 'paused', pausedReason: 'cancelled' })
    })
  })

  it('追问后仍不汇报 → 按失败暂停', async () => {
    const { agent } = await makeOrchestrator(
      [{ file: 'a.md', title: 'A' }],
      [answer('pae-approve', '批准'), answer('pae-pause', '终止')],
    )
    agent.scriptTurn('completed', undefined)
    agent.scriptTurn('completed', undefined) // 追问后仍无 report
    await vi.waitFor(() => {
      const state = [...agent.session.events].reverse().find(e => e.type === 'pae/state')
      expect(state?.data).toMatchObject({ phase: 'paused', pausedReason: 'failure' })
    })
    await vi.waitFor(() => {
      const state = [...agent.session.events].reverse().find(e => e.type === 'pae/state')
      expect(state?.data).toMatchObject({ phase: 'aborted' }) // 选了终止
    })
  })

  it('auto-recover：限额内自愈，超限升级暂停', async () => {
    const { Orchestrator } = await import('../src/orchestrator.ts')
    const agent = new FakeAgent()
    const { ask } = fakeAsk(answer('pae-approve', '批准'), answer('pae-pause', '终止'))
    const orchestrator = new Orchestrator({
      agent, ask,
      config: { onStepFailure: 'auto-recover', maxAutoRecoveries: 1, planRoot: '.pae' },
      planDir,
    })
    orchestrator.begin('示例任务')
    await orchestrator.submitPlan([{ file: 'a.md', title: 'A' }], undefined)
    agent.scriptTurn('completed', { outcome: 'blocked', summary: '第一次' }, 1)
    agent.scriptTurn('completed', { outcome: 'blocked', summary: '第二次' }, 1) // 自愈 1 次后仍 blocked → 超限
    await vi.waitFor(() => {
      const state = [...agent.session.events].reverse().find(e => e.type === 'pae/state')
      expect(state?.data).toMatchObject({ phase: 'paused', pausedReason: 'failure' })
    })
    const texts = agent.steered.map(m => (m.content[0] as { text: string }).text)
    expect(texts.filter(t => t.includes('自行调整')).length).toBe(1) // 恰好一次自愈指令
    await vi.waitFor(() => {
      const state = [...agent.session.events].reverse().find(e => e.type === 'pae/state')
      expect(state?.data).toMatchObject({ phase: 'aborted' })
    })
  })

  it('跳过 → todo 保持 pending，终局标注 skipped', async () => {
    const { agent } = await makeOrchestrator(
      [{ file: 'a.md', title: 'A' }, { file: 'b.md', title: 'B' }],
      [answer('pae-approve', '批准'), answer('pae-pause', '跳过该步')],
    )
    agent.scriptTurn('completed', { outcome: 'blocked', summary: '卡住' }, 1)
    agent.scriptTurn('completed', { outcome: 'done', summary: 'B 完成' }, 2)
    await vi.waitFor(() => {
      const state = [...agent.session.events].reverse().find(e => e.type === 'pae/state')
      expect(state?.data).toMatchObject({ phase: 'completed' })
    })
    const doneAsk = [...agent.session.events] // completionDetail 在 pae-done 弹窗 detail 里
    void doneAsk
    // skipped 集合通过完成弹窗所在 ask 的 received 校验更直接：
    // received[1]?.[0] 为 pause，received[2]?.[0] 为完成通知，detail 含 skipped。
  })
})
```

（最后一个用例的 skipped 断言完整版：`const doneAsk = received.at(-1)?.[0]; expect(doneAsk?.id).toBe('pae-done'); expect(doneAsk?.detail).toContain('skipped')`——`received` 已由 `makeOrchestrator` 返回。上面用例体内省略的最后两行即此内容，实现时写全。）

- [ ] **步骤 2：运行测试验证 dismissed 用例失败**

```bash
pnpm test
```

预期：`turn aborted（用户取消）→ paused(cancelled)，弹窗被关 → dismissed 保持暂停` 用例 FAIL（v1 把 dismissed 当 retry 立刻重注入，编排不会停在 paused）；其余用例对任务 6 已实现的失败/暂停机制构成回归覆盖，应 PASS（若有 FAIL，说明任务 6 实现有缺口，先修复再继续）。

- [ ] **步骤 3：收敛 dismissed 语义（修改 `src/orchestrator.ts`）**

在 `run()` 的两个 pause 调用点，把返回值 `'dismissed'` 显式处理为"停止驱动、保持 paused 状态等待用户"：

```ts
// 两处 pause 调用后追加同一分支（文件校验失败处与失败决策处）：
const choice = await this.pause(reason, i, plan, diagnostic)
if (choice === 'dismissed') return // 保持 paused：用户搁置弹窗，等命令重入或恢复触发 revive
```

- [ ] **步骤 4：运行测试验证通过**

```bash
pnpm test && pnpm typecheck
```

预期：全部 PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/orchestrator.ts test/orchestrator.spec.ts
git commit -m "feat: 编排器异常路径——nudge、auto-recover 限额、暂停五选项与 dismissed 收敛"
```

---

### 任务 8：orchestrator.ts（三）— 确认点、replan、revive 恢复

**文件：**
- 修改：`src/orchestrator.ts`
- 测试：`test/orchestrator.spec.ts`（追加）

- [ ] **步骤 1：追加失败的测试**

```ts
describe('确认点 / replan / revive', () => {
  it('requiresConfirmation 步前弹四选项确认点，选继续后执行', async () => {
    const { agent, received } = await makeOrchestrator(
      [{ file: 'a.md', title: 'A', requiresConfirmation: true }],
      [answer('pae-approve', '批准'), answer('pae-confirm', '继续')],
    )
    agent.scriptTurn('completed', { outcome: 'done', summary: 'A 完成' }, 1)
    await vi.waitFor(() => {
      const state = [...agent.session.events].reverse().find(e => e.type === 'pae/state')
      expect(state?.data).toMatchObject({ phase: 'completed' })
    })
    expect(received[1]?.[0]?.id).toBe('pae-confirm')
    const pausedEvent = agent.session.events.find(
      e => e.type === 'pae/state' && (e.data as { pausedReason?: string }).pausedReason === 'confirm-point')
    expect(pausedEvent).toBeDefined()
  })

  it('确认点选跳过 → 该步不执行、终局 skipped', async () => {
    const { agent } = await makeOrchestrator(
      [{ file: 'a.md', title: 'A', requiresConfirmation: true }],
      [answer('pae-approve', '批准'), answer('pae-confirm', '跳过该步')],
    )
    await vi.waitFor(() => {
      const state = [...agent.session.events].reverse().find(e => e.type === 'pae/state')
      expect(state?.data).toMatchObject({ phase: 'completed' })
    })
    // 没有任何步骤指令被注入（A 被跳过）
    const texts = agent.steered.map(m => (m.content[0] as { text: string }).text)
    expect(texts.some(t => t.includes('执行计划第 1/1 步'))).toBe(false)
  })

  it('暂停选回到计划阶段 → planning 状态 + replan 指令（含反馈）', async () => {
    const { agent } = await makeOrchestrator(
      [{ file: 'a.md', title: 'A' }],
      [answer('pae-approve', '批准'), answer('pae-pause', '回到计划阶段', '加一步测试')],
    )
    agent.scriptTurn('completed', { outcome: 'blocked', summary: '卡住' }, 1)
    await vi.waitFor(() => {
      const state = [...agent.session.events].reverse().find(e => e.type === 'pae/state')
      expect(state?.data).toMatchObject({ phase: 'planning' })
    })
    const last = agent.steered.at(-1)
    expect((last?.content[0] as { text: string }).text).toContain('加一步测试')
  })

  it('revive：executing 中断 → 断点续跑弹窗，从当前步重注入', async () => {
    const { Orchestrator } = await import('../src/orchestrator.ts')
    const agent = new FakeSession2() // 见下：带历史事件的假会话
    // 历史里已有：plan（2 步）+ executing stepIndex 1
    const o = new Orchestrator({
      agent: agent.agent, ask: agent.ask, config: { onStepFailure: 'pause', maxAutoRecoveries: 2, planRoot: '.pae' },
      planDir,
    })
    const revivePromise = o.revive()
    await vi.waitFor(() => agent.receivedQuestions.length > 0)
    expect(agent.receivedQuestions[0]?.[0]?.id).toBe('pae-resume')
    agent.resolveResume(answer('pae-resume', '从断点继续'))
    agent.agent.scriptTurn('completed', { outcome: 'done', summary: '续跑' }, 1)
    agent.agent.scriptTurn('completed', { outcome: 'done', summary: '完成' }, 2)
    await revivePromise
    const state = [...agent.agent.session.events].reverse().find(e => e.type === 'pae/state')
    expect(state?.data).toMatchObject({ phase: 'completed' })
  })
})
```

`FakeSession2` 帮手（追加到测试文件顶部假件区）：

```ts
/** 带"重启后"历史事件（plan + executing）的可控假件：ask 由测试手动 resolve。 */
class FakeSession2 {
  readonly agent = new FakeAgent()
  receivedQuestions: AskUserQuestionItem[][] = []
  private resolver: ((value: AskUserQuestionAnswer) => void) | undefined
  constructor() {
    const s = this.agent.session as FakeSession
    s.append('pae/plan', { planDir, steps: [{ file: 'a.md', title: 'A' }, { file: 'b.md', title: 'B' }] })
    s.append('pae/state', { phase: 'executing', stepIndex: 1, planDir, task: 'T' })
  }
  readonly ask = async (questions: AskUserQuestionItem[]): Promise<AskUserQuestionAnswer> => {
    this.receivedQuestions.push(questions)
    return new Promise(resolve => { this.resolver = resolve })
  }
  resolveResume(value: AskUserQuestionAnswer): void { this.resolver?.(value) }
}
```

- [ ] **步骤 2：运行测试验证失败**

```bash
pnpm test
```

预期：新增用例 FAIL（无 `pae-confirm` 提问、无 `revive` 方法）。

- [ ] **步骤 3：实现确认点与 revive（修改 `src/orchestrator.ts`）**

在 `run()` 循环内、文件校验之后、`pae/state{executing}` 之前插入确认点：

```ts
if (step.requiresConfirmation === true) {
  this.append('pae/state', { phase: 'paused', pausedReason: 'confirm-point', stepIndex: i, planDir: plan.planDir, task: this.folded().task })
  const answer = await this.askOrDismiss([{
    id: 'pae-confirm',
    header: 'Plan-and-Execute 确认点',
    question: `即将执行第 ${i}/${total} 步：${step.title}`,
    detail: `步骤文件：${plan.planDir}/${step.file}`,
    options: [
      { label: CONFIRM_CONTINUE, description: '执行本步' },
      { label: PAUSE_SKIP, description: '跳过本步（终局标注 skipped）' },
      { label: PAUSE_REPLAN, description: '回到规划阶段修改计划' },
      { label: PAUSE_TERMINATE, description: '终止整个编排' },
    ],
  }])
  if (answer === 'dismissed') return // 保持 paused(confirm-point)，等 revive/命令重入
  const label = answer.answers.find(entry => entry.id === 'pae-confirm')?.selected[0]
  if (label === PAUSE_SKIP) { this.skipped.add(i); i += 1; continue }
  if (label === PAUSE_REPLAN) return this.enterReplan(plan, label)
  if (label === PAUSE_TERMINATE) return this.finish('aborted', plan)
  // 继续 → 落到下方 executing
}
```

新增 `revive()` 方法（类内追加）：

```ts
/**
 * 恢复入口（agent/created 重建、或 paused 态命令重入）。
 * 按折叠状态弹对应交互并续跑；driver 由本方法自身充当。
 */
async revive(): Promise<void> {
  const folded = this.folded()
  if (this.disposed) return
  if (folded.phase === 'paused') {
    const reason = folded.pausedReason ?? 'failure'
    const plan = foldPaePlan(this.session.events)
    const i = folded.stepIndex ?? 1
    if (plan === undefined) return
    if (reason === 'confirm-point') {
      const choice = await this.confirmChoice(i, plan)   // 抽取：与 run() 内确认点同一弹窗
      if (choice === 'skip') { this.skipped.add(i); return this.run(plan, i + 1) }
      if (choice === 'replan') return this.enterReplan(plan, '')
      if (choice === 'terminate') return this.finish('aborted', plan)
      if (choice === 'continue') return this.run(plan, i)
      return
    }
    const choice = await this.pause(reason, i, plan, '编排恢复：请决定如何继续')
    if (choice === 'terminate') return this.finish('aborted', plan)
    if (choice === 'replan') return this.enterReplan(plan, choice)
    if (choice === 'skip') { this.skipped.add(i); return this.run(plan, i + 1) }
    if (choice === 'next') { this.mark(i, 'completed', plan); return this.run(plan, i + 1) }
    if (choice === 'retry') return this.run(plan, i)
    return
  }
  if (folded.phase === 'executing') {
    const plan = foldPaePlan(this.session.events)
    if (plan === undefined) return
    const i = Math.max(1, folded.stepIndex ?? 1)
    const answer = await this.askOrDismiss([{
      id: 'pae-resume',
      header: 'Plan-and-Execute 恢复',
      question: `编排在上次执行到第 ${i}/${plan.steps.length} 步时中断。从断点继续？`,
      options: [
        { label: '从断点继续', description: '重新注入当前步骤指令（以步为原子单位续跑）' },
        { label: PAUSE_REPLAN, description: '回到规划阶段修改计划' },
        { label: PAUSE_TERMINATE, description: '终止编排' },
      ],
    }])
    if (answer === 'dismissed') return
    const label = answer.answers.find(entry => entry.id === 'pae-resume')?.selected[0]
    if (label === '从断点继续') return this.run(plan, i)
    if (label === PAUSE_REPLAN) return this.enterReplan(plan, '')
    if (label === PAUSE_TERMINATE) return this.finish('aborted', plan)
    return
  }
  if (folded.phase === 'planning') {
    const answer = await this.askOrDismiss([{
      id: 'pae-resume',
      header: 'Plan-and-Execute 恢复',
      question: '编排在规划阶段中断，继续规划？',
      options: [
        { label: '继续规划', description: '提示模型继续完成步骤文件并提交审批' },
        { label: PAUSE_TERMINATE, description: '终止编排' },
      ],
    }])
    if (answer === 'dismissed') return
    const label = answer.answers.find(entry => entry.id === 'pae-resume')?.selected[0]
    if (label === '继续规划') {
      const { resumePlanningInstruction } = await import('./prompts.ts')
      this.deps.agent.steer(resumePlanningInstruction())
      this.armApproval()
    } else if (label === PAUSE_TERMINATE) {
      this.append('pae/state', { phase: 'aborted', task: folded.task, planDir: this.deps.planDir })
    }
  }
}

/** 确认点弹窗的独立复用形态。 */
private async confirmChoice(i: number, plan: PaePlanPayload): Promise<'continue' | 'skip' | 'replan' | 'terminate' | 'dismissed'> {
  const answer = await this.askOrDismiss([{
    id: 'pae-confirm',
    header: 'Plan-and-Execute 确认点',
    question: `即将执行第 ${i}/${plan.steps.length} 步：${plan.steps[i - 1]?.title ?? ''}`,
    detail: `步骤文件：${plan.planDir}/${plan.steps[i - 1]?.file ?? ''}`,
    options: [
      { label: CONFIRM_CONTINUE, description: '执行本步' },
      { label: PAUSE_SKIP, description: '跳过本步（终局标注 skipped）' },
      { label: PAUSE_REPLAN, description: '回到规划阶段修改计划' },
      { label: PAUSE_TERMINATE, description: '终止整个编排' },
    ],
  }])
  if (answer === 'dismissed') return 'dismissed'
  const label = answer.answers.find(entry => entry.id === 'pae-confirm')?.selected[0]
  if (label === PAUSE_SKIP) return 'skip'
  if (label === PAUSE_REPLAN) return 'replan'
  if (label === PAUSE_TERMINATE) return 'terminate'
  return 'continue'
}
```

同时把 `run()` 内联的确认点改为调用 `this.confirmChoice(i, plan)`（消除重复；行为不变，`continue` 落到 executing 分支）。删除 `enterReplan` 里的动态 `import('./prompts.ts')`，改为顶部静态导入 `replanInstruction, resumePlanningInstruction`。

- [ ] **步骤 4：运行测试验证通过**

```bash
pnpm test && pnpm typecheck
```

预期：全部 PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/orchestrator.ts test/orchestrator.spec.ts
git commit -m "feat: 确认点四选项、replan 反馈回流与 revive 断点恢复"
```

---

### 任务 9：tools.ts — submit_plan / report_step

**文件：**
- 创建：`src/tools.ts`
- 测试：`test/tools.spec.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// test/tools.spec.ts
import { describe, expect, it } from 'vitest'
import { createReportStepTool, createSubmitPlanTool } from '../src/tools.ts'

const run = (tool: { execute: (args: unknown, exec: unknown) => Promise<unknown> }, args: unknown) =>
  tool.execute(args, { agent: { session: {} } })

describe('submit_plan 工具', () => {
  it('会话无编排 → 抛错', async () => {
    const tool = createSubmitPlanTool(() => undefined)
    await expect(run(tool, { steps: [{ file: 'a.md', title: 'A' }] }))
      .rejects.toThrow('没有进行中的 plan-and-execute 编排')
  })
  it('批准 → 返回 { approved: true }', async () => {
    const tool = createSubmitPlanTool(() => ({ submitPlan: async () => ({ approved: true }) }) as never)
    await expect(run(tool, { steps: [{ file: 'a.md', title: 'A' }] }))
      .resolves.toEqual({ approved: true })
  })
  it('驳回 → 抛出反馈文本（模型看到反馈）', async () => {
    const tool = createSubmitPlanTool(
      () => ({ submitPlan: async () => ({ approved: false, error: '用户反馈：X' }) }) as never,
    )
    await expect(run(tool, { steps: [{ file: 'a.md', title: 'A' }] })).rejects.toThrow('用户反馈：X')
  })
})

describe('report_step 工具', () => {
  it('正常汇报 → 编排器收到当前步汇报并返回确认', async () => {
    const calls: Array<[string, string]> = []
    const tool = createReportStepTool(() => ({
      reportStepForCurrent: (outcome: string, summary: string) => { calls.push([outcome, summary]) },
    }) as never)
    await expect(run(tool, { outcome: 'done', summary: '完成' })).resolves.toEqual({ received: true })
    expect(calls).toEqual([['done', '完成']])
  })
  it('outcome 非法 → 抛错', async () => {
    const tool = createReportStepTool(() => ({}) as never)
    await expect(run(tool, { outcome: 'oops', summary: 'x' })).rejects.toThrow("outcome 必须是 'done' 或 'blocked'")
  })
})
```

（`report_step` 的 `stepIndex` 不由模型提供——防伪造步号，由编排器从折叠状态取当前步：`execute` 调 `orchestrator.reportStepForCurrent(outcome, summary)`，实现见步骤 3。）

- [ ] **步骤 2：运行测试验证失败**

```bash
pnpm test
```

预期：FAIL，`Cannot find module '../src/tools.ts'`。

- [ ] **步骤 3：实现 `src/tools.ts`**

先在 `src/orchestrator.ts` 补一个薄方法（report_step 用，防模型伪造步号）：

```ts
/** report_step 工具入口：步号取折叠状态中的当前步。 */
reportStepForCurrent(outcome: 'done' | 'blocked', summary: string): void {
  const folded = this.folded()
  if (folded.phase !== 'executing' || folded.stepIndex === undefined || folded.stepIndex === 0) {
    throw new Error('report_step 仅在执行阶段的当前步骤内可用')
  }
  this.reportStep(folded.stepIndex, outcome, summary)
}
```

（原 `reportStep` 保留给单测直接调用；`exec.agent` 校验放在工具层。）

```ts
/**
 * 模型侧工具：submit_plan / report_step。编排器查表按 session 对象定位。
 * @module plan-and-execute/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Orchestrator } from './orchestrator.ts'

export type OrchestratorLookup = (session: object) => Orchestrator | undefined

export function createSubmitPlanTool(lookup: OrchestratorLookup) {
  return defineTool({
    name: 'submit_plan',
    description:
      'Plan-and-Execute 规划阶段专用：提交步骤清单供用户审批。'
      + 'steps[].file 是相对计划目录的步骤 Markdown 文件名（先写好文件再提交）。'
      + '用户驳回时错误信息携带反馈，按反馈修改后重新提交。',
    parameters: {
      steps: {
        type: 'array',
        required: true,
        description: '步骤清单（顺序即执行顺序）',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            file: { type: 'string', required: true, description: '步骤 Markdown 文件名，相对计划目录' },
            title: { type: 'string', required: true, description: '步骤短标题' },
            requiresConfirmation: { type: 'boolean', description: '执行前需用户确认（风险步骤标记）' },
          },
        },
      },
      summary: { type: 'string', description: '计划一句话概述' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { approved: { type: 'boolean', required: true } },
      } as const,
      render: (_args, value) => [{
        type: 'text',
        text: value.approved
          ? '计划已批准。编排器将逐步注入步骤指令；请结束当前回合，等待第一步指令。'
          : '计划未获批准。',
      }],
    },
    execute: async (args, exec) => {
      if (exec.agent === undefined) throw new Error('submit_plan 需要调用 agent（无会话可切换）')
      const orchestrator = lookup(exec.agent.session as object)
      if (orchestrator === undefined) throw new Error('当前会话没有进行中的 plan-and-execute 编排')
      const verdict = await orchestrator.submitPlan(args.steps, args.summary)
      if (!verdict.approved) throw new Error(verdict.error)
      return { approved: true }
    },
    presentCall: args => ({
      card: 'generic',
      title: `计划提交（${args.steps.length} 步）`,
      kind: 'other',
      content: args.steps.map((step, index) => ({
        type: 'text' as const,
        text: `${index + 1}. ${step.title} — ${step.file}${step.requiresConfirmation === true ? ' ⚠ 确认点' : ''}`,
      })),
    }),
  })
}

export function createReportStepTool(lookup: OrchestratorLookup) {
  return defineTool({
    name: 'report_step',
    description:
      'Plan-and-Execute 执行阶段专用：汇报当前步骤结局。done=已完成本步全部工作；'
      + 'blocked=本步无法完成（summary 写原因）。每步结束前必须调用。',
    parameters: {
      outcome: { type: 'string', required: true, description: "'done' 或 'blocked'" },
      summary: { type: 'string', required: true, description: '一两句结果/原因（改动要点、产出）' },
      artifacts: { type: 'string', description: '可选：本步关键产出文件（逗号分隔）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { received: { type: 'boolean', required: true } },
      } as const,
      render: (_args, value) => [{ type: 'text', text: value.received ? '已记录。' : '未记录。' }],
    },
    execute: async (args, exec) => {
      if (exec.agent === undefined) throw new Error('report_step 需要调用 agent')
      const orchestrator = lookup(exec.agent.session as object)
      if (orchestrator === undefined) throw new Error('当前会话没有进行中的 plan-and-execute 编排')
      if (args.outcome !== 'done' && args.outcome !== 'blocked') {
        throw new Error(`outcome 必须是 'done' 或 'blocked'（收到：${args.outcome}）`)
      }
      orchestrator.reportStepForCurrent(args.outcome, args.summary)
      return { received: true }
    },
    presentCall: args => ({
      card: 'generic',
      title: `步骤汇报：${args.outcome}`,
      kind: args.outcome === 'done' ? 'other' : 'warning',
      content: [{ type: 'text', text: args.summary }],
    }),
  })
}
```

同步在 `test/orchestrator.spec.ts` 为 `reportStepForCurrent` 补两个直测用例（非执行期/无当前步 → 抛错；执行期 → 追加 `pae/step-report` 事件）：

```ts
describe('reportStepForCurrent', () => {
  it('非执行期 → 抛错', async () => {
    const { orchestrator } = await makeOrchestrator([{ file: 'a.md', title: 'A' }], [answer('pae-approve', '批准')])
    // submitPlan 批准后 phase=executing 但 stepIndex=0（尚无当前步）→ 抛错
    expect(() => orchestrator.reportStepForCurrent('done', '太早')).toThrow('report_step 仅在执行阶段的当前步骤内可用')
  })
})
```

- [ ] **步骤 4：运行测试验证通过**

```bash
pnpm test && pnpm typecheck
```

预期：全部 PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/tools.ts src/orchestrator.ts test/tools.spec.ts
git commit -m "feat: submit_plan/report_step 模型侧工具（manifest 结构化参数、防伪造步号）"
```

---

### 任务 10：index.ts — 装配、Config、命令与恢复监听

**文件：**
- 修改：`src/index.ts`（替换任务 1 占位）
- 测试：`test/index.spec.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// test/index.spec.ts
import { describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** 最小假 ctx：捕获注册项。 */
function fakeCtx() {
  const registered = { commands: [] as Array<Record<string, unknown>>, tools: [] as unknown[], sections: [] as unknown[] }
  const listeners: Array<{ event: string; handler: (payload: unknown) => void }> = []
  return {
    registered, listeners,
    commands: { register: (definition: Record<string, unknown>) => { registered.commands.push(definition); return () => {} } },
    tools: { register: (tool: unknown) => { registered.tools.push(tool); return () => {} } },
    systemPrompt: { section: (section: unknown) => { registered.sections.push(section); return () => {} } },
    on: (event: string, handler: (payload: unknown) => void) => { listeners.push({ event, handler }); return () => {} },
    get: vi.fn(() => ({ ask: async () => ({ answers: [] }) })),
    effect: vi.fn(() => () => {}),
    logger: { info: () => {}, warn: () => {} },
  }
}

const fakeAgent = (phase: string) => ({
  id: 'sess-1',
  status: 'idle',
  steer: vi.fn(),
  whenIdle: async () => {},
  session: {
    id: 'sess-1',
    header: { cwd: '/ws' },
    events: (phase === 'none' ? [] : [{ seq: 1, type: 'pae/state', data: { phase, task: 'T', planDir: '/ws/.pae/sess-1/x' } }]) as SessionEvent[],
    append: vi.fn((_type: string, _data: object) => {}),
  },
})

describe('apply 装配', () => {
  it('注册命令、两个工具、两个 prompt section、agent/created 监听', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = fakeCtx()
    apply(ctx as never, { onStepFailure: 'pause', maxAutoRecoveries: 2, planDir: '.pae' })
    expect(ctx.registered.commands.map((c: Record<string, unknown>) => c.name)).toEqual(['plan-and-execute'])
    expect(ctx.registered.tools).toHaveLength(2)
    expect(ctx.registered.sections.map(s => (s as { name: string }).name)).toEqual(['pae:planning', 'pae:executing'])
    expect(ctx.listeners.map(l => l.event)).toContain('agent/created')
  })

  it('命令前置校验：空任务 / 无交互通道 / agent 忙 / plan-mode 激活 / 已有编排', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = fakeCtx()
    apply(ctx as never, { onStepFailure: 'pause', maxAutoRecoveries: 2, planDir: '.pae' })
    const handler = ctx.registered.commands[0]!.handler as (invocation: Record<string, unknown>) => unknown

    expect(handler({ agent: fakeAgent('none'), rawInput: '   ' })).toMatchObject({ kind: 'error' })
    ctx.get.mockReturnValueOnce(undefined)
    expect(handler({ agent: fakeAgent('none'), rawInput: '做点事' })).toMatchObject({ kind: 'error' })

    const busy = { ...fakeAgent('none'), status: 'running' }
    expect(handler({ agent: busy, rawInput: '做点事' })).toMatchObject({ kind: 'error' })

    const planMode = fakeAgent('none')
    planMode.session.events = [{ seq: 1, type: 'plan/mode', data: { active: true } } as SessionEvent]
    expect(handler({ agent: planMode, rawInput: '做点事' })).toMatchObject({ kind: 'error' })

    expect(handler({ agent: fakeAgent('planning'), rawInput: '做点事' })).toMatchObject({ kind: 'error' })
  })

  it('正常启动：返回 success 并注入 kickoff（steer 被调用）', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = fakeCtx()
    apply(ctx as never, { onStepFailure: 'pause', maxAutoRecoveries: 2, planDir: '.pae' })
    const handler = ctx.registered.commands[0]!.handler as (invocation: Record<string, unknown>) => unknown
    const agent = fakeAgent('none')
    const result = handler({ agent, rawInput: '重构登录模块' })
    expect(result).toMatchObject({ kind: 'success' })
    expect(agent.steer).toHaveBeenCalledTimes(1)
    expect(agent.session.append).toHaveBeenCalled()
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

```bash
pnpm test
```

预期：FAIL（占位 index.ts 没有注册任何东西）。

- [ ] **步骤 3：实现 `src/index.ts`（完整替换）**

```ts
/**
 * plan-and-execute：dsh 插件入口（组合根）。
 * 开发装载：scripts/dev.mjs → `pnpm dsh web --patch .overlay.dev.yml`；
 * 正式安装：`dsh plugin --profile <name> add <本工程目录>`（读 dsh.bundle.patch）。
 * @module plan-and-execute
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { foldPae, isPlanModeActive } from './state.ts'
import { Orchestrator, type DriveAgent, type DriveSession } from './orchestrator.ts'
import { createReportStepTool, createSubmitPlanTool } from './tools.ts'
import { EXECUTING_SECTION_BODY, PLANNING_SECTION_BODY } from './prompts.ts'

export const name = 'plan-and-execute'
export const inject = ['tools', 'commands', 'systemPrompt']

export interface Config {
  /** 步骤级失败策略：默认暂停问人。 */
  onStepFailure: 'pause' | 'auto-recover'
  /** auto-recover 模式下单步自愈次数上限。 */
  maxAutoRecoveries: number
  /** 计划根目录（相对会话 cwd）；实际目录 = <planDir>/<sessionId>/<runToken>。 */
  planDir: string
}

export const Config: Schema<Config> = Schema.object({
  onStepFailure: Schema.union(['pause', 'auto-recover']).description('步骤失败策略').default('pause'),
  maxAutoRecoveries: Schema.number().description('单步自愈次数上限（仅 auto-recover）').default(2),
  planDir: Schema.string().description('计划文件根目录（相对会话 cwd）').default('.pae'),
})

/** 真 Agent → 窄结构接口的唯一适配点（append 的条件重载在这里一次性断言）。 */
function toDriveAgent(agent: Agent): DriveAgent {
  const session = agent.session
  const drive: DriveSession = {
    events: session.events,
    append: (eventType, data) => {
      (session.append as unknown as (t: string, d: object) => void)(eventType, data)
    },
  }
  return {
    session: drive,
    steer: message => agent.steer(message),
    whenIdle: () => agent.whenIdle(),
  }
}

export function apply(ctx: Context, config: Config): void {
  /** 每 session 一个编排器；key 是 session 对象本身。 */
  const orchestrators = new WeakMap<object, Orchestrator>()

  const askFor = (agent: Agent) => (questions: AskUserQuestionItem[]) => {
    const service = ctx.get('userQuestions')
    if (service === undefined) throw new Error('no user-questions channel available')
    return service.ask({ questions, agent })
  }

  const ensure = (agent: Agent): Orchestrator => {
    const existing = orchestrators.get(agent.session as object)
    if (existing !== undefined) return existing
    const cwd = agent.session.header.cwd ?? process.cwd()
    const runToken = new Date().toISOString().replaceAll(/[-:TZ.]/g, '').slice(0, 14)
    const planDir = `${cwd}/${config.planDir}/${String(agent.id)}/${runToken}`
    const orchestrator = new Orchestrator({
      agent: toDriveAgent(agent),
      ask: askFor(agent),
      config: { onStepFailure: config.onStepFailure, maxAutoRecoveries: config.maxAutoRecoveries, planRoot: config.planDir },
      planDir,
    })
    orchestrators.set(agent.session as object, orchestrator)
    ctx.effect(() => () => orchestrator.dispose(), 'plan-and-execute: dispose orchestrators')
    return orchestrator
  }

  // —— 命令入口 ——
  ctx.commands.register({
    name: 'plan-and-execute',
    description: 'Plan-and-Execute：规划 → 审批 → 逐步执行（支持确认点与失败暂停）',
    input: { hint: '<任务描述>' },
    handler: ({ agent, rawInput }) => {
      const task = rawInput.trim()
      if (task === '') return { kind: 'error', text: '请提供任务描述：/plan-and-execute <任务>' }
      if (ctx.get('userQuestions') === undefined) {
        return { kind: 'error', text: '当前部署没有用户交互通道（userQuestions），无法审批计划' }
      }
      if (agent.status !== 'idle') {
        return { kind: 'error', text: `agent 正忙（${agent.status}），请等当前回合结束后再启动` }
      }
      if (isPlanModeActive(agent.session.events)) {
        return { kind: 'error', text: 'plan-mode 处于激活状态，请先 /plan off（两者互斥）' }
      }
      const folded = foldPae(agent.session.events)
      if (folded.phase === 'planning' || folded.phase === 'executing') {
        return { kind: 'error', text: '本会话已有进行中的 plan-and-execute 编排（暂停态可再次输入 /plan-and-execute 重新弹出选项）' }
      }
      const orchestrator = ensure(agent)
      if (folded.phase === 'paused') {
        void orchestrator.revive()
        return { kind: 'success', text: '已重新弹出暂停选项。' }
      }
      orchestrator.begin(task)
      return { kind: 'success', text: 'Plan-and-Execute 已启动：进入规划阶段，等待模型提交计划。' }
    },
  })

  // —— 模型侧工具 ——
  const lookup = (session: object): Orchestrator | undefined => orchestrators.get(session)
  ctx.tools.register(createSubmitPlanTool(lookup))
  ctx.tools.register(createReportStepTool(lookup))

  // —— 阶段 prompt sections ——
  ctx.systemPrompt.section({
    name: 'pae:planning',
    order: 50,
    text: context => {
      const agent = context.agent
      if (agent === undefined) return ''
      const folded = foldPae(agent.session.events)
      return folded.phase === 'planning' ? PLANNING_SECTION_BODY(folded.planDir ?? '') : ''
    },
  })
  ctx.systemPrompt.section({
    name: 'pae:executing',
    order: 51,
    text: context => {
      const agent = context.agent
      if (agent === undefined) return ''
      const folded = foldPae(agent.session.events)
      return folded.phase === 'executing' || folded.phase === 'paused'
        ? EXECUTING_SECTION_BODY()
        : ''
    },
  })

  // —— 重启/重建恢复：agent/created 时折叠状态，中断态弹恢复交互 ——
  ctx.on('agent/created', ({ agent }) => {
    const folded = foldPae(agent.session.events)
    if (folded.phase === 'none' || folded.phase === 'completed' || folded.phase === 'aborted') return
    const orchestrator = ensure(agent)
    void orchestrator.revive()
  })
}
```

- [ ] **步骤 4：运行测试验证通过**

```bash
pnpm test && pnpm typecheck
```

预期：全部 PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/index.ts test/index.spec.ts
git commit -m "feat: 插件装配——命令前置校验、工具注册、阶段 prompt、agent/created 恢复"
```

---

### 任务 11：README 验收清单与全量验证

**文件：**
- 创建：`README.md`
- 验证：全仓库

- [ ] **步骤 1：编写 `README.md`**

````markdown
# plan-and-execute（dsh 插件）

dsh 的 Plan-and-Execute 编排插件：`/plan-and-execute <任务>` 启动"规划 → 审批 → 逐步执行"。
全部 LLM 交互委托给宿主 ReactLoopAgent；控制流持久化在 `pae/*` 会话事件，步骤内容在
`.pae/<session>/<runToken>/step-NN-*.md`；进度经 `todo/write` 渲染到会话 TodoPanel。

## 开发

```sh
pnpm install          # postinstall 软链宿主包（DSH_ROOT 默认 ~/git/deepseek-harness，需先在 dsh 仓库 pnpm install && pnpm run build）
pnpm test             # vitest 单测
pnpm typecheck && pnpm lint && pnpm format:check
pnpm dev              # 在 dsh checkout 启动 Web UI 并加载本插件（绝对路径 overlay）
```

## 配置（cordis.yml `config`）

| 键 | 默认 | 说明 |
|---|---|---|
| `onStepFailure` | `'pause'` | 步骤失败：暂停问人 / 自愈重试 |
| `maxAutoRecoveries` | `2` | 自愈次数上限（仅 auto-recover） |
| `planDir` | `'.pae'` | 计划根目录（相对会话 cwd） |

## 正式安装

```sh
pnpm build
dsh plugin --profile <name> add /Users/jimmy/VSCodeProjects/dsh-plugin/plan-and-execute
```

## 手工验收清单（`pnpm dev` + Web UI）

1. `/plan-and-execute 给本仓库写一个加法函数并配测试` → 模型调研、写步骤文件、调 `submit_plan` → 审批弹窗
2. 审批选"继续修改"并输入反馈 → 模型收到反馈重新提交 → 再审批
3. 选"批准" → TodoPanel 出现步骤清单；无确认点的计划连续执行到完成；完成弹窗含各步 summary
4. 在计划里让模型给某步标 `requiresConfirmation: true` → 该步执行前弹确认点（继续/跳过/回计划/终止）
5. 执行中按取消（或让某步失败）→ 暂停五选项（重试/跳过/继续下一步/回计划/终止）
6. 执行中直接发消息 → 消息进入当前步（原生 steer 语义），编排不受影响
7. 执行中途重启 `pnpm dev` 并重开会话 → 恢复确认弹出，"从断点继续"后从当前步重注入
8. 验收全程结束后：`git -C ~/git/deepseek-harness status --porcelain` 输出为空（宿主仓库零改动）
````

- [ ] **步骤 2：全量验证**

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build
```

预期：全部通过，0 error。

- [ ] **步骤 3：手工验收**

按 README 清单 1–8 逐项走查（需要能访问 LLM 的 dsh 环境）。任何一项不过：回到对应任务修复后重走。

- [ ] **步骤 4：Commit**

```bash
git add README.md
git commit -m "docs: README——开发/安装/配置与手工验收清单"
```

---

## 自检记录

**规格覆盖度**（规格章节 → 任务）：
- §2 硬性约束（不改 dsh、插件机制、委托 ReactLoopAgent、斜杠命令）→ 任务 1/10（peerDeps+软链、apply 装配、steer 驱动）
- §3 决策表 1–7 → 分别落在：主会话（任务 10 ensure）、确认点默认两处强制交互（任务 6/8）、manifest+文件（任务 4/9）、失败分层（任务 3/7）、中途干预（任务 10 命令层 + 原生 steer 不拦）、todo 进度（任务 2/6）、恢复问一次（任务 8 revive）
- §4 架构与状态机 → 任务 6/7/8（run/pause/replan/finish 全状态）
- §5 命令入口校验五条 → 任务 10 步骤 1 用例逐一覆盖（空任务/无通道/忙/plan-mode/进行中）
- §5.2/§6.4 prompt sections → 任务 5
- §5.3 submit_plan 全流程（含 ASK_CANCELLED dismiss）→ 任务 6（askOrDismiss）
- §6.1 判定表五行 → 任务 3 classifyStepOutcome + 任务 6/7 决策循环
- §6.3 失败策略与限额 → 任务 3 decideAction + 任务 7 用例
- §7.1 事件四类 → 任务 2；**分工**（log 控制流/文件内容、注入时重读）→ 任务 6 stepInstruction（agent 自行读文件）
- §7.2 恢复三分支 → 任务 8 revive
- §7.3 todo 边界 → 任务 2/6/8（skipped 保持 pending）
- §8 错误处理表 → 分散对应：请求级（不实现，宿主）、悬空（任务 6 校验→pause）、headless（任务 10）、dispose（任务 6 dispose + 任务 10 effect）、compaction（不实现，宿主）
- §9 工程结构/链接表 9 包 → 任务 1；§10 配置三项 → 任务 10 Config；§11 测试 → 各任务 + 任务 11 手工清单；§12 验收标准 1–7 → 任务 11 清单 + 单测/静态检查

**占位符扫描**：草稿残留已在编写中清理（任务 7 的 `makeOrchestrator` 前移至任务 6 统一定义、任务 9 用例内联化，无"实现时再改"的未定内容）。唯一刻意的"先红后绿"点：任务 6 v1 把 pause 的 `dismissed` 当 retry 处理，任务 7 步骤 2 的对应用例先 FAIL、步骤 3 修正——这是 TDD 分工，不是占位符。

**类型一致性**：`PlanStep/PaePlanPayload/PaeStatePayload/PaeStepReportPayload`（任务 2）↔ decision/manifest/prompts/orchestrator/tools/index 全部一致；`Orchestrator` 公有面 `begin/submitPlan/reportStep/reportStepForCurrent/revive/dispose`（任务 6/8/9 定义，任务 10 调用）；`DriveAgent/DriveSession/AskFn/ResolvedConfig`（任务 6）↔ 任务 10 toDriveAgent；标签常量 `APPROVE_LABEL/PAUSE_*/CONFIRM_CONTINUE/DONE_ACK`（任务 6）↔ 任务 8/9；测试假件 `FakeSession/FakeAgent/fakeAsk/answer/makeOrchestrator`（任务 6/7 定义，任务 8/9 复用）。
