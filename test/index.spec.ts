import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { PersistedOrchestratorState } from '../src/persist.ts'
import type { PaePhase } from '../src/state.ts'

/** 最小假 ctx：捕获注册项。inject 同步执行 setup 并回传 ctx 本体。 */
function fakeCtx() {
  const registered = {
    commands: [] as Array<Record<string, unknown>>,
    tools: [] as unknown[],
    sections: [] as unknown[],
  }
  const listeners: Array<{ event: string; handler: (payload: unknown) => void }> = []
  const ctx = {
    registered,
    listeners,
    commands: {
      register: (definition: Record<string, unknown>) => {
        registered.commands.push(definition)
        return () => {}
      },
    },
    tools: {
      register: (tool: unknown) => {
        registered.tools.push(tool)
        return () => {}
      },
    },
    systemPrompt: {
      section: (section: unknown) => {
        registered.sections.push(section)
        return () => {}
      },
    },
    on: (event: string, handler: (payload: unknown) => void) => {
      listeners.push({ event, handler })
      return () => {}
    },
    inject: (_services: string[], setup: (child: unknown) => void) => {
      setup(ctx)
      return () => {}
    },
    get: vi.fn<(key: string) => unknown>(() => ({ ask: async () => ({ answers: [] }) })),
    effect: vi.fn(() => () => {}),
    logger: { info: () => {}, warn: () => {} },
  }
  return ctx
}

let cwd: string
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'pae-index-'))
})
afterAll(async () => {
  if (cwd !== undefined) await rm(cwd, { recursive: true, force: true })
})

const fakeAgent = (_phase: 'none' | PaePhase) => ({
  id: 'sess-1',
  status: 'idle',
  steer: vi.fn(),
  whenIdle: async () => {},
  ctx: {
    tools: {
      restrict: vi.fn((_filter: unknown) => () => {}),
    },
  },
  session: {
    id: 'sess-1',
    header: { cwd },
    events: [] as SessionEvent[],
    append: vi.fn((_type: string, _data: object) => {}),
  },
})

/** 写入 orchestrator.json 模拟既有编排状态（命令校验读文件）。 */
async function seedState(
  phase: PaePhase,
  extra: Partial<PersistedOrchestratorState> = {},
): Promise<void> {
  const dir = join(cwd, '.pae', 'sess-1')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'orchestrator.json'),
    JSON.stringify({
      phase,
      planDir: dir,
      stepReports: [],
      statuses: {},
      skipped: [],
      ...extra,
    } satisfies PersistedOrchestratorState),
    'utf8',
  )
}

describe('apply 装配', () => {
  it('注册命令、两个工具、两个 prompt section、agent/created 监听', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = fakeCtx()
    apply(ctx as never, { onStepFailure: 'pause', maxAutoRecoveries: 2, planDir: '.pae' })
    expect(ctx.registered.commands.map((c) => c.name)).toEqual(['plan-and-execute'])
    expect(ctx.registered.tools).toHaveLength(2)
    expect(ctx.registered.sections.map((s) => (s as { name: string }).name)).toEqual([
      'pae:planning',
      'pae:executing',
    ])
    expect(ctx.listeners.map((l) => l.event)).toContain('agent/created')
  })

  it('命令前置校验：空任务 / 无交互通道 / agent 忙 / plan-mode 激活 / 已有编排', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = fakeCtx()
    apply(ctx as never, { onStepFailure: 'pause', maxAutoRecoveries: 2, planDir: '.pae' })
    const handler = ctx.registered.commands[0]!.handler as (
      invocation: Record<string, unknown>,
    ) => Promise<unknown>

    await expect(handler({ agent: fakeAgent('none'), rawInput: '   ' })).resolves.toMatchObject({
      kind: 'error',
    })
    ctx.get.mockReturnValueOnce(undefined)
    await expect(handler({ agent: fakeAgent('none'), rawInput: '做点事' })).resolves.toMatchObject({
      kind: 'error',
    })

    const busy = { ...fakeAgent('none'), status: 'running' }
    await expect(handler({ agent: busy, rawInput: '做点事' })).resolves.toMatchObject({
      kind: 'error',
    })

    const planMode = fakeAgent('none')
    planMode.session.events = [
      { seq: 1, type: 'plan/mode', data: { active: true } } as SessionEvent,
    ]
    await expect(handler({ agent: planMode, rawInput: '做点事' })).resolves.toMatchObject({
      kind: 'error',
    })

    await seedState('planning')
    await expect(handler({ agent: fakeAgent('none'), rawInput: '做点事' })).resolves.toMatchObject({
      kind: 'error',
    })
  })

  it('正常启动：返回 success 并注入 kickoff（steer 被调用）', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = fakeCtx()
    apply(ctx as never, { onStepFailure: 'pause', maxAutoRecoveries: 2, planDir: '.pae' })
    const handler = ctx.registered.commands[0]!.handler as (
      invocation: Record<string, unknown>,
    ) => Promise<unknown>
    const agent = fakeAgent('none')
    const result = await handler({ agent, rawInput: '重构登录模块' })
    expect(result).toMatchObject({ kind: 'success' })
    expect(agent.steer).toHaveBeenCalledTimes(1)
  })

  it('启动编排 → 对该 agent deny exit_plan_mode（agent-scoped restrict）', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = fakeCtx()
    apply(ctx as never, { onStepFailure: 'pause', maxAutoRecoveries: 2, planDir: '.pae' })
    const handler = ctx.registered.commands[0]!.handler as (
      invocation: Record<string, unknown>,
    ) => Promise<unknown>
    const agent = fakeAgent('none')
    await handler({ agent, rawInput: '重构登录模块' })
    expect(agent.ctx.tools.restrict).toHaveBeenCalledWith({ deny: ['exit_plan_mode'] })
  })

  it('已有编排进行中 → 不重复 restrict（幂等）', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = fakeCtx()
    apply(ctx as never, { onStepFailure: 'pause', maxAutoRecoveries: 2, planDir: '.pae' })
    const handler = ctx.registered.commands[0]!.handler as (
      invocation: Record<string, unknown>,
    ) => Promise<unknown>
    await seedState('planning')
    const agent = fakeAgent('none')
    await handler({ agent, rawInput: '重构登录模块' })
    expect(agent.ctx.tools.restrict).not.toHaveBeenCalled()
  })

  it('部署无 plan-mode（restrict 抛错）→ 容错，编排正常启动', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = fakeCtx()
    apply(ctx as never, { onStepFailure: 'pause', maxAutoRecoveries: 2, planDir: '.pae' })
    const handler = ctx.registered.commands[0]!.handler as (
      invocation: Record<string, unknown>,
    ) => Promise<unknown>
    const agent = fakeAgent('none')
    agent.ctx.tools.restrict.mockImplementationOnce(() => {
      throw new Error('tools.restrict() names unknown global tool "exit_plan_mode"')
    })
    const result = await handler({ agent, rawInput: '重构登录模块' })
    expect(result).toMatchObject({ kind: 'success' })
    expect(agent.steer).toHaveBeenCalledTimes(1)
  })

  it('paused 态命令重入 → 重新弹出暂停选项', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = fakeCtx()
    apply(ctx as never, { onStepFailure: 'pause', maxAutoRecoveries: 2, planDir: '.pae' })
    const handler = ctx.registered.commands[0]!.handler as (
      invocation: Record<string, unknown>,
    ) => Promise<unknown>
    await seedState('paused', { pausedReason: 'failure', stepIndex: 2 })
    const agent = fakeAgent('none')
    const result = await handler({ agent, rawInput: '继续' })
    expect(result).toMatchObject({ kind: 'success', text: expect.stringContaining('暂停') })
  })
})
