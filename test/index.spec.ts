import { describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { PaePhase } from '../src/state.ts'

/** 最小假 ctx：捕获注册项。 */
function fakeCtx() {
  const registered = {
    commands: [] as Array<Record<string, unknown>>,
    tools: [] as unknown[],
    sections: [] as unknown[],
  }
  const listeners: Array<{ event: string; handler: (payload: unknown) => void }> = []
  return {
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
    get: vi.fn<(key: string) => unknown>(() => ({ ask: async () => ({ answers: [] }) })),
    effect: vi.fn(() => () => {}),
    logger: { info: () => {}, warn: () => {} },
  }
}

const fakeAgent = (phase: 'none' | PaePhase) => {
  const events: SessionEvent[] = phase === 'none'
    ? []
    : [{ seq: 1, time: 1, type: 'pae/state', data: { phase, task: 'T', planDir: '/ws/.pae/sess-1/x' } }]
  return {
    id: 'sess-1',
    status: 'idle',
    steer: vi.fn(),
    whenIdle: async () => {},
    session: {
      id: 'sess-1',
      header: { cwd: '/ws' },
      events,
      append: vi.fn((_type: string, _data: object) => {}),
    },
  }
}

describe('apply 装配', () => {
  it('注册命令、两个工具、两个 prompt section、agent/created 监听', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = fakeCtx()
    apply(ctx as never, { onStepFailure: 'pause', maxAutoRecoveries: 2, planDir: '.pae' })
    expect(ctx.registered.commands.map(c => c.name)).toEqual(['plan-and-execute'])
    expect(ctx.registered.tools).toHaveLength(2)
    expect(ctx.registered.sections.map(s => (s as { name: string }).name)).toEqual([
      'pae:planning',
      'pae:executing',
    ])
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

    expect(handler({ agent: fakeAgent('planning'), rawInput: '做点事' })).toMatchObject({
      kind: 'error',
    })
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
