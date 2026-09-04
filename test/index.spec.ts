import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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
  /** settings 假服务：register 逐用例可改写（抛错模拟重复注册降级路径）。 */
  const settings = { register: vi.fn(() => {}) }
  /**
   * agents 假服务：resume 记录调用（冷会话补执行路径；fire 由注册表驱动、
   * 其行为在 schedule.spec 覆盖）。
   */
  const agents = { resume: vi.fn(async () => ({ agent: {}, dispose: async () => {} })) }
  const ctx = {
    registered,
    listeners,
    sessionTitle,
    llm,
    settings,
    agents,
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
      if (key === 'settings') return settings
      if (key === 'agents') return agents
      return { ask: async () => ({ answers: [] }) }
    }),
    effect: vi.fn(() => () => {}),
    logger: { info: () => {}, warn: vi.fn() },
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

const fakeAgent = (_phase: 'none' | PaePhase) => {
  /** 会话日志底（宿主 Session 为追加型；测试换底以注入 plan/mode 等事件）。 */
  let events: SessionEvent[] = []
  return {
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
      surface: { nodes: [], replaceGeneration: 0 },
      append: vi.fn((_type: string, _data: object) => {}),
      // 当前宿主 Session 形状：无 .events 属性，snapshotEvents() 返回全量日志只读快照
      snapshotEvents: () => [...events],
      // 测试专用：整体替换事件日志（宿主 Session 无此方法）
      seedEvents: (next: readonly SessionEvent[]) => {
        events = [...next]
      },
    },
  }
}

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

/** 取 settings/updated 桥接监听器（命令已删除，桥接是唯一写路径）。 */
function settingsListenerOf(ctx: ReturnType<typeof fakeCtx>) {
  return ctx.listeners.find((l) => l.event === 'settings/updated')?.handler as
    ((ns: string, next: unknown, prev: unknown, source: string) => Promise<unknown>) | undefined
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
    planMode.session.seedEvents([
      { seq: 1, type: 'plan/mode', data: { active: true } } as SessionEvent,
    ])
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
    // 用户原文 + kickoff 指令
    expect(agent.steer).toHaveBeenCalledTimes(2)
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
    expect(agent.steer).toHaveBeenCalledTimes(2)
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
    expect(agent.steer).toHaveBeenCalledTimes(2)
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
    expect(agent.steer).toHaveBeenCalledTimes(2)
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
    // 经 settings/updated 桥接喂入映射（命令已删除，桥接是唯一写路径）
    await settingsListenerOf(ctx)!(
      'pae-step-models',
      { 'sess-1': { 1: { provider: 'p1', model: 'm1' } } },
      {},
      'user',
    )
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
    // 步骤 2 的映射不影响步骤 1 的请求（透传）
    await settingsListenerOf(ctx)!(
      'pae-step-models',
      { 'sess-1': { 2: { provider: 'p2', model: 'm2' } } },
      {},
      'user',
    )
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
    // 经 settings/updated 桥接喂入映射（命令已删除，桥接是唯一写路径）
    const listener = settingsListenerOf(ctx)!
    await listener(
      'pae-step-models',
      { 'sess-1': { 1: { provider: 'p1', model: 'm1' } } },
      {},
      'user',
    )
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
    // 步骤 2 的映射不影响步骤 1 的请求（透传）
    const listener = settingsListenerOf(ctx)!
    await listener(
      'pae-step-models',
      { 'sess-1': { 2: { provider: 'p2', model: 'm2' } } },
      {},
      'user',
    )
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

describe('todos 补写（新回合首个 agent/request）', () => {
  /** 取 ensure 注册的 todos 刷新监听器（agent/request 的第二个 handler，模型 waterfall 之后）。 */
  function todosRefreshOf(agent: ReturnType<typeof fakeAgent>) {
    const onMock = agent.ctx.on as Mock
    const handlers = onMock.mock.calls.filter(([event]) => event === 'agent/request')
    return handlers[1]?.[1] as
      | ((
          payload: { turn?: unknown },
          next: () => Promise<LlmCallConfig>,
        ) => Promise<LlmCallConfig>)
      | undefined
  }

  it('executing 新回合首个请求 → 补发 todo/write（宿主 turn/start 清空投影后恢复面板）', async () => {
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
    const handler = todosRefreshOf(agent)
    expect(handler).toBeDefined()
    await handler!({ turn: 2 }, async () => ({ provider: 's', model: 'm' }))
    expect(agent.session.append).toHaveBeenCalledWith(
      'todo/write',
      expect.objectContaining({ todos: expect.any(Array) }),
    )
    // 同一回合的后续请求不再补写
    const before = (agent.session.append as Mock).mock.calls.filter(
      ([t]) => t === 'todo/write',
    ).length
    await handler!({ turn: 2 }, async () => ({ provider: 's', model: 'm' }))
    expect(
      (agent.session.append as Mock).mock.calls.filter(([t]) => t === 'todo/write'),
    ).toHaveLength(before)
  })

  it('planning 阶段新回合 → 不补写（refreshTodos 阶段守卫）', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = fakeCtx()
    apply(ctx as never, { onStepFailure: 'pause', maxAutoRecoveries: 2, planDir: '.pae' })
    await seedState('planning')
    const agent = fakeAgent('planning')
    await fireCreated(ctx, agent)
    const handler = todosRefreshOf(agent)
    await handler!({ turn: 1 }, async () => ({ provider: 's', model: 'm' }))
    expect(agent.session.append).not.toHaveBeenCalledWith('todo/write', expect.anything())
  })
})

describe('settings/updated 桥接', () => {
  it('本命名空间变更 → 解析校验后 applyStepModels（按 sessionId 定位编排器）', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = fakeCtx()
    apply(ctx as never, { onStepFailure: 'pause', maxAutoRecoveries: 2, planDir: '.pae' })
    await seedState('planning', {
      plan: { planDir: join(cwd, '.pae', 'sess-1'), steps: [{ file: 'a.md', title: 'A' }] },
    })
    const agent = fakeAgent('planning')
    await fireCreated(ctx, agent)
    const listener = settingsListenerOf(ctx)!
    expect(listener).toBeDefined()
    listener!('pae-step-models', { 'sess-1': { 1: { provider: 'a', model: 'm' } } }, {}, 'user')
    await vi.waitFor(async () => {
      expect(ctx.llm.resolveCallConfig).toHaveBeenCalledWith({ provider: 'a', model: 'm' })
      const raw = await readFile(join(cwd, '.pae', 'sess-1', 'orchestrator.json'), 'utf8')
      expect(JSON.parse(raw).stepModels).toEqual({ 1: { provider: 'a', model: 'm' } })
    })
  })

  it('非本命名空间 → 不处理', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = fakeCtx()
    apply(ctx as never, { onStepFailure: 'pause', maxAutoRecoveries: 2, planDir: '.pae' })
    await seedState('planning', {
      plan: { planDir: join(cwd, '.pae', 'sess-1'), steps: [{ file: 'a.md', title: 'A' }] },
    })
    const agent = fakeAgent('planning')
    await fireCreated(ctx, agent)
    const listener = settingsListenerOf(ctx)!
    expect(listener).toBeDefined()
    listener!('other-ns', { 'sess-1': { 1: { provider: 'a', model: 'm' } } }, {}, 'user')
    expect(ctx.llm.resolveCallConfig).not.toHaveBeenCalled()
    const raw = await readFile(join(cwd, '.pae', 'sess-1', 'orchestrator.json'), 'utf8')
    expect(JSON.parse(raw)).not.toHaveProperty('stepModels')
  })

  it('非法条目丢弃、合法条目生效（混合载荷不抛）', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = fakeCtx()
    apply(ctx as never, { onStepFailure: 'pause', maxAutoRecoveries: 2, planDir: '.pae' })
    await seedState('planning', {
      plan: {
        planDir: join(cwd, '.pae', 'sess-1'),
        steps: [
          { file: 'a.md', title: 'A' },
          { file: 'b.md', title: 'B' },
        ],
      },
    })
    const agent = fakeAgent('planning')
    await fireCreated(ctx, agent)
    const listener = settingsListenerOf(ctx)!
    expect(listener).toBeDefined()
    listener!(
      'pae-step-models',
      { 'sess-1': { 1: { provider: 42 }, 2: { provider: 'b', model: 'm2' } } },
      {},
      'user',
    )
    await vi.waitFor(async () => {
      expect(ctx.llm.resolveCallConfig).toHaveBeenCalledWith({ provider: 'b', model: 'm2' })
      const raw = await readFile(join(cwd, '.pae', 'sess-1', 'orchestrator.json'), 'utf8')
      expect(JSON.parse(raw).stepModels).toEqual({ 2: { provider: 'b', model: 'm2' } })
    })
  })

  it('applyStepModels 抛错（目录只读落盘失败）→ 监听器返回 rejected promise（宿主容器可接住记 warn）', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = fakeCtx()
    apply(ctx as never, { onStepFailure: 'pause', maxAutoRecoveries: 2, planDir: '.pae' })
    await seedState('planning', {
      plan: { planDir: join(cwd, '.pae', 'sess-1'), steps: [{ file: 'a.md', title: 'A' }] },
    })
    const agent = fakeAgent('planning')
    await fireCreated(ctx, agent)
    const listener = settingsListenerOf(ctx)!
    expect(listener).toBeDefined()
    // 目录只读 → save 的 writeFile 抛 EACCES → applyStepModels 抛出 → IIFE 拒绝
    await chmod(join(cwd, '.pae', 'sess-1'), 0o500)
    try {
      await expect(
        listener!(
          'pae-step-models',
          { 'sess-1': { 1: { provider: 'a', model: 'm' } } },
          {},
          'user',
        ),
      ).rejects.toThrow()
    } finally {
      await chmod(join(cwd, '.pae', 'sess-1'), 0o700)
    }
  })

  it('解析出步骤但 resolveCallConfig 全失败 → 跳过本次应用（既有选择保留，不清空）', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = fakeCtx()
    apply(ctx as never, { onStepFailure: 'pause', maxAutoRecoveries: 2, planDir: '.pae' })
    await seedState('planning', {
      plan: { planDir: join(cwd, '.pae', 'sess-1'), steps: [{ file: 'a.md', title: 'A' }] },
      stepModels: { 1: { provider: 'p1', model: 'm1' } },
    })
    const agent = fakeAgent('planning')
    await fireCreated(ctx, agent)
    const listener = settingsListenerOf(ctx)!
    expect(listener).toBeDefined()
    ctx.llm.resolveCallConfig.mockRejectedValue(new Error('unknown model'))
    await listener!(
      'pae-step-models',
      { 'sess-1': { 1: { provider: 'a', model: 'm' } } },
      {},
      'user',
    )
    await vi.waitFor(async () => {
      const raw = await readFile(join(cwd, '.pae', 'sess-1', 'orchestrator.json'), 'utf8')
      expect(JSON.parse(raw).stepModels).toEqual({ 1: { provider: 'p1', model: 'm1' } })
    })
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('全部步骤模型不可用'))
  })

  it('settings.register 抛错（重复注册）→ 降级不崩、无桥接监听', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = fakeCtx()
    ctx.settings.register.mockImplementation(() => {
      throw new Error('settings namespace "pae-step-models" is already registered')
    })
    expect(() =>
      apply(ctx as never, { onStepFailure: 'pause', maxAutoRecoveries: 2, planDir: '.pae' }),
    ).not.toThrow()
    expect(ctx.listeners.map((l) => l.event)).not.toContain('settings/updated')
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('settings 命名空间注册失败'),
    )
  })
})

describe('定时排期接线', () => {
  it('注册 pae-schedule settings 命名空间', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = fakeCtx()
    apply(ctx as never, { onStepFailure: 'pause', maxAutoRecoveries: 2, planDir: '.pae' })
    expect(ctx.settings.register).toHaveBeenCalledWith('pae-step-models', expect.anything())
    expect(ctx.settings.register).toHaveBeenCalledWith('pae-schedule', expect.anything())
  })

  it('settings/updated（pae-schedule）对未知会话不抛（幂等容错）', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = fakeCtx()
    apply(ctx as never, { onStepFailure: 'pause', maxAutoRecoveries: 2, planDir: '.pae' })
    const bridge = settingsListenerOf(ctx)
    await expect(
      bridge!('pae-schedule', { ghost: { at: 1_800_000_000_000 } }, {}, 'client'),
    ).resolves.toBeUndefined()
  })

  it('agent/created 对 scheduled 阶段触发 revive（不提前返回，弹回显卡）', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = fakeCtx()
    apply(ctx as never, { onStepFailure: 'pause', maxAutoRecoveries: 2, planDir: '.pae' })
    await seedState('scheduled', {
      scheduledAt: Date.now() + 60_000,
      plan: { planDir: join(cwd, '.pae', 'sess-1'), steps: [{ file: 'a.md', title: 'A' }] },
    })
    await writeFile(join(cwd, '.pae', 'sess-1', 'a.md'), '# A\n内容', 'utf8')
    const agent = fakeAgent('none')
    await fireCreated(ctx, agent)
    // revive 的 scheduled 分支复弹 plan-review ask → 必经 userQuestions 服务
    expect(ctx.get).toHaveBeenCalledWith('userQuestions')
  })
})
