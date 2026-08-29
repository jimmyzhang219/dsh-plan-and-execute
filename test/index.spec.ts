import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
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
  /** session-title 假服务：默认无标题、rename 记录调用（测试可经 ctx.get 取回改写）。 */
  const sessionTitle = {
    get: vi.fn<(session: unknown) => unknown>(() => undefined),
    rename: vi.fn<(session: unknown, title: string) => unknown>(() => ({
      title: '',
      messageSeqs: [],
      source: { kind: 'user' },
      eventSeq: 1,
      updatedAt: 0,
    })),
  }
  /** llm 假服务：模型可用性校验（resolveCallConfig 逐用例可改写）。 */
  const llm = {
    resolveCallConfig: vi.fn(async (c: { provider: string; model: string }) => ({
      provider: c.provider,
      model: c.model,
    })),
  }
  const ctx = {
    registered,
    listeners,
    sessionTitle,
    llm,
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
    get: vi.fn<(key: string) => unknown>((key) => {
      if (key === 'sessionTitle') return sessionTitle
      if (key === 'llm') return llm
      return { ask: async () => ({ answers: [] }) }
    }),
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
    on: vi.fn((_event: string, _handler: unknown) => () => {}),
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

/**
 * 触发 agent/created 监听并等待其异步 IIFE 完成（读盘 → ensure 注册 waterfall →
 * revive 询问）。此后 lookup 才能命中，且 revive 的状态回写不会晚于后续断言。
 */
async function fireCreated(
  ctx: ReturnType<typeof fakeCtx>,
  agent: ReturnType<typeof fakeAgent>,
): Promise<void> {
  const created = ctx.listeners.find((l) => l.event === 'agent/created')
  expect(created).toBeDefined()
  await created!.handler({ agent })
  await vi.waitFor(() => {
    expect(agent.ctx.on).toHaveBeenCalledWith('agent/request', expect.any(Function))
    expect(ctx.get).toHaveBeenCalledWith('userQuestions')
  })
}

describe('apply 装配', () => {
  it('注册命令、两个工具、两个 prompt section、agent/created 监听', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = fakeCtx()
    apply(ctx as never, { onStepFailure: 'pause', maxAutoRecoveries: 2, planDir: '.pae' })
    expect(ctx.registered.commands.map((c) => c.name)).toEqual([
      'plan-and-execute',
      'plan-and-execute-set-models',
    ])
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

  it('启动编排 → 用任务文本重命名会话标题（无持久化标题时）', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = fakeCtx()
    apply(ctx as never, { onStepFailure: 'pause', maxAutoRecoveries: 2, planDir: '.pae' })
    const handler = ctx.registered.commands[0]!.handler as (
      invocation: Record<string, unknown>,
    ) => Promise<unknown>
    const agent = fakeAgent('none')
    const result = await handler({ agent, rawInput: '重构登录模块' })
    expect(result).toMatchObject({ kind: 'success' })
    expect(ctx.sessionTitle.get).toHaveBeenCalledWith(agent.session)
    expect(ctx.sessionTitle.rename).toHaveBeenCalledWith(agent.session, '重构登录模块')
  })

  it('会话已有持久化标题 → 不覆盖（rename 不被调用）', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = fakeCtx()
    apply(ctx as never, { onStepFailure: 'pause', maxAutoRecoveries: 2, planDir: '.pae' })
    const handler = ctx.registered.commands[0]!.handler as (
      invocation: Record<string, unknown>,
    ) => Promise<unknown>
    ctx.sessionTitle.get.mockReturnValue({
      title: '已有标题',
      messageSeqs: [1],
      source: { kind: 'user' },
      eventSeq: 1,
      updatedAt: 0,
    })
    const agent = fakeAgent('none')
    const result = await handler({ agent, rawInput: '重构登录模块' })
    expect(result).toMatchObject({ kind: 'success' })
    expect(ctx.sessionTitle.rename).not.toHaveBeenCalled()
  })

  it('部署无 session-title 服务 → 跳过重命名，编排正常启动', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = fakeCtx()
    apply(ctx as never, { onStepFailure: 'pause', maxAutoRecoveries: 2, planDir: '.pae' })
    const handler = ctx.registered.commands[0]!.handler as (
      invocation: Record<string, unknown>,
    ) => Promise<unknown>
    ctx.get.mockImplementation((key) =>
      key === 'sessionTitle' ? undefined : { ask: async () => ({ answers: [] }) },
    )
    const agent = fakeAgent('none')
    const result = await handler({ agent, rawInput: '重构登录模块' })
    expect(result).toMatchObject({ kind: 'success' })
    expect(agent.steer).toHaveBeenCalledTimes(1)
  })

  it('rename 抛错（服务异常）→ 容错，编排正常启动', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = fakeCtx()
    apply(ctx as never, { onStepFailure: 'pause', maxAutoRecoveries: 2, planDir: '.pae' })
    const handler = ctx.registered.commands[0]!.handler as (
      invocation: Record<string, unknown>,
    ) => Promise<unknown>
    ctx.sessionTitle.rename.mockImplementation(() => {
      throw new Error('session-title service disposed')
    })
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

describe('plan-and-execute-set-models 命令', () => {
  it('合法载荷 → 经 llm 校验后写入编排器（seedState planning + plan）', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = fakeCtx()
    apply(ctx as never, { onStepFailure: 'pause', maxAutoRecoveries: 2, planDir: '.pae' })
    const handler = ctx.registered.commands[1]!.handler as (
      invocation: Record<string, unknown>,
    ) => Promise<unknown>
    await seedState('planning', {
      plan: { planDir: join(cwd, '.pae', 'sess-1'), steps: [{ file: 'a.md', title: 'A' }] },
    })
    const agent = fakeAgent('planning')
    await fireCreated(ctx, agent)
    const result = await handler({
      agent,
      rawInput: '{"1":{"provider":"deepseek-official","model":"deepseek-v4-flash"}}',
    })
    expect(result).toMatchObject({ kind: 'success' })
    expect(ctx.llm.resolveCallConfig).toHaveBeenCalledWith({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    })
  })

  it('坏 JSON / 非对象 / 缺 provider-model → error，不落盘', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = fakeCtx()
    apply(ctx as never, { onStepFailure: 'pause', maxAutoRecoveries: 2, planDir: '.pae' })
    const handler = ctx.registered.commands[1]!.handler as (
      invocation: Record<string, unknown>,
    ) => Promise<unknown>
    await seedState('planning')
    const agent = fakeAgent('planning')
    await fireCreated(ctx, agent)
    for (const rawInput of ['x', '[1]', '{"1":{"provider":"a"}}']) {
      const result = await handler({ agent, rawInput })
      expect(result).toMatchObject({ kind: 'error' })
    }
    const raw = await readFile(join(cwd, '.pae', 'sess-1', 'orchestrator.json'), 'utf8')
    expect(JSON.parse(raw)).not.toHaveProperty('stepModels')
  })

  it('llm 校验抛错 → error 带模型不可用', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = fakeCtx()
    apply(ctx as never, { onStepFailure: 'pause', maxAutoRecoveries: 2, planDir: '.pae' })
    const handler = ctx.registered.commands[1]!.handler as (
      invocation: Record<string, unknown>,
    ) => Promise<unknown>
    await seedState('planning')
    const agent = fakeAgent('planning')
    ctx.llm.resolveCallConfig.mockRejectedValueOnce(new Error('unknown model'))
    await fireCreated(ctx, agent)
    const result = await handler({
      agent,
      rawInput: '{"1":{"provider":"deepseek-official","model":"deepseek-v4-flash"}}',
    })
    expect(result).toMatchObject({
      kind: 'error',
      text: expect.stringContaining('模型 deepseek-official/deepseek-v4-flash 不可用'),
    })
  })
})

describe('agent/request waterfall 按步切换模型', () => {
  /** 取 fireCreated 后 ensure 注册的 'agent/request' waterfall handler。 */
  function requestHandlerOf(agent: ReturnType<typeof fakeAgent>) {
    const onMock = agent.ctx.on as Mock
    return onMock.mock.calls.find(([event]) => event === 'agent/request')?.[1] as
      ((payload: unknown, next: () => Promise<LlmCallConfig>) => Promise<LlmCallConfig>) | undefined
  }

  it('executing 且当前步有映射 → 覆盖 provider/model，保留其余字段', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = fakeCtx()
    apply(ctx as never, { onStepFailure: 'pause', maxAutoRecoveries: 2, planDir: '.pae' })
    await seedState('executing', {
      stepIndex: 1,
      plan: {
        planDir: join(cwd, '.pae', 'sess-1'),
        steps: [
          { file: 'a.md', title: 'A' },
          { file: 'b.md', title: 'B' },
        ],
      },
    })
    const agent = fakeAgent('executing')
    await fireCreated(ctx, agent)
    const requestHandler = requestHandlerOf(agent)
    expect(requestHandler).toBeDefined()
    const command = ctx.registered.commands[1]!.handler as (
      invocation: Record<string, unknown>,
    ) => Promise<unknown>
    const applied = await command({ agent, rawInput: '{"1":{"provider":"p1","model":"m1"}}' })
    expect(applied).toMatchObject({ kind: 'success' })
    await expect(
      requestHandler!({}, async () => ({ provider: 's', model: 'm', maxTokens: 100 })),
    ).resolves.toEqual({ provider: 'p1', model: 'm1', maxTokens: 100 })
  })

  it('当前步无映射 → 原样透传', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = fakeCtx()
    apply(ctx as never, { onStepFailure: 'pause', maxAutoRecoveries: 2, planDir: '.pae' })
    await seedState('executing', {
      stepIndex: 1,
      plan: {
        planDir: join(cwd, '.pae', 'sess-1'),
        steps: [
          { file: 'a.md', title: 'A' },
          { file: 'b.md', title: 'B' },
        ],
      },
    })
    const agent = fakeAgent('executing')
    await fireCreated(ctx, agent)
    const requestHandler = requestHandlerOf(agent)
    expect(requestHandler).toBeDefined()
    const command = ctx.registered.commands[1]!.handler as (
      invocation: Record<string, unknown>,
    ) => Promise<unknown>
    const applied = await command({ agent, rawInput: '{"2":{"provider":"p2","model":"m2"}}' })
    expect(applied).toMatchObject({ kind: 'success' })
    await expect(
      requestHandler!({}, async () => ({ provider: 's', model: 'm', maxTokens: 100 })),
    ).resolves.toEqual({ provider: 's', model: 'm', maxTokens: 100 })
  })

  it('映射无 effort → 剥离 seed 继承的 reasoningEffort（对齐宿主 installModelSelection）', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = fakeCtx()
    apply(ctx as never, { onStepFailure: 'pause', maxAutoRecoveries: 2, planDir: '.pae' })
    await seedState('executing', {
      stepIndex: 1,
      plan: {
        planDir: join(cwd, '.pae', 'sess-1'),
        steps: [
          { file: 'a.md', title: 'A' },
          { file: 'b.md', title: 'B' },
        ],
      },
    })
    const agent = fakeAgent('executing')
    await fireCreated(ctx, agent)
    const requestHandler = requestHandlerOf(agent)
    expect(requestHandler).toBeDefined()
    const command = ctx.registered.commands[1]!.handler as (
      invocation: Record<string, unknown>,
    ) => Promise<unknown>
    const applied = await command({ agent, rawInput: '{"1":{"provider":"p1","model":"m1"}}' })
    expect(applied).toMatchObject({ kind: 'success' })
    const returned = await requestHandler!({}, async () => ({
      provider: 's',
      model: 'm',
      reasoningEffort: 'high' as LlmCallConfig['reasoningEffort'],
    }))
    expect(returned.provider).toBe('p1')
    expect(returned.model).toBe('m1')
    // 映射不带 effort → 继承的 effort 必须被删除（否则不支持的组合会在 prepareCall 抛错）
    expect('reasoningEffort' in returned).toBe(false)
  })

  it('映射带 effort → 覆盖 seed（seed 的 high 被剥离、映射的 low 生效）', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = fakeCtx()
    apply(ctx as never, { onStepFailure: 'pause', maxAutoRecoveries: 2, planDir: '.pae' })
    await seedState('executing', {
      stepIndex: 1,
      plan: {
        planDir: join(cwd, '.pae', 'sess-1'),
        steps: [
          { file: 'a.md', title: 'A' },
          { file: 'b.md', title: 'B' },
        ],
      },
    })
    const agent = fakeAgent('executing')
    await fireCreated(ctx, agent)
    const requestHandler = requestHandlerOf(agent)
    expect(requestHandler).toBeDefined()
    const command = ctx.registered.commands[1]!.handler as (
      invocation: Record<string, unknown>,
    ) => Promise<unknown>
    const applied = await command({
      agent,
      rawInput: '{"1":{"provider":"p1","model":"m1","reasoningEffort":"low"}}',
    })
    expect(applied).toMatchObject({ kind: 'success' })
    const returned = await requestHandler!({}, async () => ({
      provider: 's',
      model: 'm',
      reasoningEffort: 'high' as LlmCallConfig['reasoningEffort'],
    }))
    expect(returned.reasoningEffort).toBe('low')
  })

  it('无映射 → 透传原样（含 seed 的 reasoningEffort）', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = fakeCtx()
    apply(ctx as never, { onStepFailure: 'pause', maxAutoRecoveries: 2, planDir: '.pae' })
    await seedState('executing', {
      stepIndex: 1,
      plan: {
        planDir: join(cwd, '.pae', 'sess-1'),
        steps: [
          { file: 'a.md', title: 'A' },
          { file: 'b.md', title: 'B' },
        ],
      },
    })
    const agent = fakeAgent('executing')
    await fireCreated(ctx, agent)
    const requestHandler = requestHandlerOf(agent)
    expect(requestHandler).toBeDefined()
    const command = ctx.registered.commands[1]!.handler as (
      invocation: Record<string, unknown>,
    ) => Promise<unknown>
    const applied = await command({ agent, rawInput: '{"2":{"provider":"p2","model":"m2"}}' })
    expect(applied).toMatchObject({ kind: 'success' })
    const returned = await requestHandler!({}, async () => ({
      provider: 's',
      model: 'm',
      reasoningEffort: 'high' as LlmCallConfig['reasoningEffort'],
    }))
    expect(returned.provider).toBe('s')
    expect(returned.model).toBe('m')
    expect(returned.reasoningEffort).toBe('high')
  })
})
