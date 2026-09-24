import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Config } from '../src/index.ts'
import type { PersistedOrchestratorState } from '../src/persist.ts'
import { type PaePhase } from '../src/state.ts'
import { fakeImageBlock } from './helpers.ts'

/** 最小假 ctx：捕获注册项。inject 同步执行 setup 并回传 ctx 本体。 */
function fakeCtx() {
  const registered = {
    commands: [] as Array<Record<string, unknown>>,
    tools: [] as unknown[],
    sections: [] as unknown[],
  }
  const listeners: Array<{ event: string; handler: (payload: unknown) => void }> = []
  /** inject 服务名记录（断言 apply 挂载了可选注入依赖）。 */
  const injectCalls: string[][] = []
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
  /**
   * agents 假服务：resume 记录调用（冷会话补执行路径；fire 由注册表驱动、
   * 其行为在 schedule.spec 覆盖）。
   */
  const agents = { resume: vi.fn(async () => ({ agent: {}, dispose: async () => {} })) }
  const ctx = {
    registered,
    listeners,
    injectCalls,
    /**
     * 可选注入服务的宿主假件：默认 undefined（fake 无可用服务时回调收到 ctx、
     * 属性为 undefined——对应宿主服务未组合的降级）；测试按需改写为假服务。
     */
    workspaceRegistry: undefined as { archivedSessionIds: readonly string[] } | undefined,
    sessionPersistence: undefined as
      { list(): Promise<ReadonlyArray<{ id: string; cwd?: string }>> } | undefined,
    sessionTitle,
    llm,
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
    inject: (services: string[], setup: (child: unknown) => void) => {
      injectCalls.push(services)
      setup(ctx)
      return () => {}
    },
    get: vi.fn<(key: string) => unknown>((key) => {
      if (key === 'sessionTitle') return sessionTitle
      if (key === 'llm') return llm
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
  /** surface 节点（测试可推入；宿主 0.1.7 起系统提示占 node 0）。 */
  let surfaceNodes: number[] = []
  /** 模型投影（hasSystemHead 只读首条 role）。 */
  let derived: Array<{ role: string }> = []
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
      surface: {
        get nodes(): readonly number[] {
          return surfaceNodes
        },
        replaceGeneration: 0,
      },
      append: vi.fn((_type: string, _data: object): unknown => undefined),
      // 当前宿主 Session 形状：无 .events 属性，snapshotEvents() 返回全量日志只读快照
      snapshotEvents: () => [...events],
      // 宿主模型投影（hasSystemHead 的判定依据；测试专用可写）
      deriveMessages: () => derived,
      // 测试专用：整体替换事件日志（宿主 Session 无此方法）
      seedEvents: (next: readonly SessionEvent[]) => {
        events = [...next]
      },
      /** 测试专用：布置 surface 节点与模型投影（同长度，首条 role 决定系统头判定）。 */
      seedSurface: (nodes: readonly number[], roles: readonly string[]) => {
        surfaceNodes = [...nodes]
        derived = roles.map((role) => ({ role }))
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

/** 取 loader/volatile-update 监听器（volatile 通道值提交后宿主唯一的派发路径）。 */
function volatileListenerOf(ctx: ReturnType<typeof fakeCtx>) {
  return ctx.listeners.find((l) => l.event === 'loader/volatile-update')?.handler as
    (() => void) | undefined
}

/** 通道假引用：宿主 volatile Config 语义（get 读当前值；测试用 set 模拟 loader 就地提交）。 */
interface FakeVolatile<T> {
  get(): T
  set(next: T): void
}

/** 步模型通道载荷（与 Config.paeStepModels 同形）。 */
type StepModelsValue = Record<string, Record<string, { provider: string; model: string }>>

/** 会话查看脉冲通道载荷（与 Config.paeSessionPings 同形）。 */
type PingsValue = Record<string, { t: number }>

/** 可喂值的插件配置（两个通道引用默认空表）。 */
type ChannelConfig = Config & {
  paeStepModels: FakeVolatile<StepModelsValue>
  paeSessionPings: FakeVolatile<PingsValue>
}

/** 建可喂值配置（测试直接 set 通道值再触发 volatile 监听器）。 */
function channelConfig(): ChannelConfig {
  const ref = <T>(value: T): FakeVolatile<T> => {
    let current = value
    return {
      get: () => current,
      set: (next) => {
        current = next
      },
    }
  }
  return {
    onStepFailure: 'pause',
    maxAutoRecoveries: 2,
    planDir: '.pae',
    paeStepModels: ref<StepModelsValue>({}),
    paeSessionPings: ref<PingsValue>({}),
  }
}

/**
 * 喂一次步模型通道值并触发宿主派发（宿主应用是异步 fire-and-forget，调用方自行等可观测效果）。
 * @param ctx - 假 ctx（取 volatile 监听器）。
 * @param config - channelConfig() 产物（通道引用）。
 * @param sessionId - 会话键。
 * @param section - 该会话的步骤号 → 模型。
 */
function feedStepModels(
  ctx: ReturnType<typeof fakeCtx>,
  config: ChannelConfig,
  sessionId: string,
  section: StepModelsValue[string],
): void {
  config.paeStepModels.set({ [sessionId]: section })
  volatileListenerOf(ctx)!()
}

/**
 * 喂一次会话查看脉冲并触发宿主派发。
 * @param ctx - 假 ctx（取 volatile 监听器）。
 * @param config - channelConfig() 产物（通道引用）。
 * @param sessionId - 会话键。
 * @param at - 脉冲时刻（epoch ms）。
 */
function feedPing(
  ctx: ReturnType<typeof fakeCtx>,
  config: ChannelConfig,
  sessionId: string,
  at: number,
): void {
  config.paeSessionPings.set({ [sessionId]: { t: at } })
  volatileListenerOf(ctx)!()
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
      // plan/mode 不在本工程编译单元的 SessionEventMap（宿主 plan-mode 拥有），双断言放宽
      { seq: 1, time: 0, type: 'plan/mode', data: { active: true } } as unknown as SessionEvent,
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

  it('驱动适配器暴露实时事件视图（创建后追加的 turn/end 必须可见，否则 settle 分类失准）', async () => {
    const { toDriveAgent } = await import('../src/index.ts')
    const agent = fakeAgent('none')
    const drive = toDriveAgent(agent as never)
    expect(drive.session.events).toHaveLength(0)
    // 适配器创建之后会话才追加回合边界（真实宿主：step 期间产生）
    agent.session.seedEvents([
      {
        seq: 1,
        time: 0,
        type: 'turn/end',
        data: { turn: 1, reason: { kind: 'aborted' } },
      } as unknown as SessionEvent,
    ])
    expect(drive.session.events).toHaveLength(1)
  })

  it('锚定绕开系统提示节点（宿主 0.1.7：系统提示占 surface node 0，只允许 system/message 覆盖它）', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = fakeCtx()
    apply(ctx as never, { onStepFailure: 'pause', maxAutoRecoveries: 2, planDir: '.pae' })
    const handler = ctx.registered.commands[0]!.handler as (
      invocation: Record<string, unknown>,
    ) => Promise<unknown>
    const agent = fakeAgent('none')
    // 既有历史：系统提示（seq 7）+ 两条旧消息
    agent.session.seedSurface([7, 8, 9], ['system', 'user', 'assistant'])
    agent.session.append.mockReturnValue({ seq: 10 })
    await handler({ agent, rawInput: '重构登录模块' })
    // 整面 replace 从首个非系统节点开始：system node 7 不在遮蔽区间内
    expect(agent.session.append).toHaveBeenCalledWith('user/message', expect.anything(), {
      surfaceOp: { op: 'replace', startSeq: 8, endSeq: 9 },
      sourceEventSeqs: [8, 9],
    })
  })

  it('系统提示为唯一表面节点 → 不 replace（无模型历史可遮蔽），仅 steer', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = fakeCtx()
    apply(ctx as never, { onStepFailure: 'pause', maxAutoRecoveries: 2, planDir: '.pae' })
    const handler = ctx.registered.commands[0]!.handler as (
      invocation: Record<string, unknown>,
    ) => Promise<unknown>
    const agent = fakeAgent('none')
    agent.session.seedSurface([7], ['system'])
    await handler({ agent, rawInput: '重构登录模块' })
    expect(agent.session.append).not.toHaveBeenCalledWith(
      'user/message',
      expect.anything(),
      expect.anything(),
    )
    expect(agent.steer).toHaveBeenCalledTimes(2)
  })

  it('命令声明 input.attachments: true；带附件启动 → 锚定消息附件块在前 + 落盘 taskImages', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = fakeCtx()
    apply(ctx as never, { onStepFailure: 'pause', maxAutoRecoveries: 2, planDir: '.pae' })
    const definition = ctx.registered.commands[0]!
    expect(definition.input).toEqual({ hint: '<任务描述>', attachments: true })
    const handler = definition.handler as (invocation: Record<string, unknown>) => Promise<unknown>
    const agent = fakeAgent('none')
    const img = fakeImageBlock('att-entry')
    const result = await handler({ agent, rawInput: '重构登录模块', attachments: [img] })
    expect(result).toMatchObject({ kind: 'success' })
    // 首条注入 = 任务图文（图块在前、文字收尾），其后 = kickoff 指令
    const first = agent.steer.mock.calls[0]?.[0] as
      { content: Array<{ type: string; text?: string }> } | undefined
    expect(first?.content[0]).toMatchObject({ type: 'image' })
    expect(first?.content[1]).toMatchObject({ type: 'text', text: '重构登录模块' })
    // 编排状态落盘 taskImages（真实 fileStorage，读 orchestrator.json）
    const state = JSON.parse(
      await readFile(join(cwd, '.pae', 'sess-1', 'orchestrator.json'), 'utf8'),
    ) as { taskImages?: unknown }
    expect(state.taskImages).toEqual([img])
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
    const config = channelConfig()
    apply(ctx as never, config)
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
    // 通道喂入映射（客户端写 volatile 字段 → 宿主派发到编排器）
    feedStepModels(ctx, config, 'sess-1', { 1: { provider: 'p1', model: 'm1' } })
    await vi.waitFor(async () => {
      const raw = await readFile(join(cwd, '.pae', 'sess-1', 'orchestrator.json'), 'utf8')
      expect(JSON.parse(raw).stepModels).toEqual({ 1: { provider: 'p1', model: 'm1' } })
    })
    await expect(
      requestHandler!({}, async () => ({ provider: 's', model: 'm', maxTokens: 100 })),
    ).resolves.toEqual({ provider: 'p1', model: 'm1', maxTokens: 100 })
  })

  it('当前步无映射 → 原样透传', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = fakeCtx()
    const config = channelConfig()
    apply(ctx as never, config)
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
    feedStepModels(ctx, config, 'sess-1', { 2: { provider: 'p2', model: 'm2' } })
    await vi.waitFor(async () => {
      const raw = await readFile(join(cwd, '.pae', 'sess-1', 'orchestrator.json'), 'utf8')
      expect(JSON.parse(raw).stepModels).toEqual({ 2: { provider: 'p2', model: 'm2' } })
    })
    await expect(
      requestHandler!({}, async () => ({ provider: 's', model: 'm', maxTokens: 100 })),
    ).resolves.toEqual({ provider: 's', model: 'm', maxTokens: 100 })
  })

  it('映射无 effort → 剥离 seed 继承的 reasoningEffort（对齐宿主 installModelSelection）', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = fakeCtx()
    const config = channelConfig()
    apply(ctx as never, config)
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
    // 通道喂入映射（客户端写 volatile 字段 → 宿主派发到编排器）
    feedStepModels(ctx, config, 'sess-1', { 1: { provider: 'p1', model: 'm1' } })
    await vi.waitFor(async () => {
      const raw = await readFile(join(cwd, '.pae', 'sess-1', 'orchestrator.json'), 'utf8')
      expect(JSON.parse(raw).stepModels).toEqual({ 1: { provider: 'p1', model: 'm1' } })
    })
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
    const config = channelConfig()
    apply(ctx as never, config)
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
    feedStepModels(ctx, config, 'sess-1', { 2: { provider: 'p2', model: 'm2' } })
    await vi.waitFor(async () => {
      const raw = await readFile(join(cwd, '.pae', 'sess-1', 'orchestrator.json'), 'utf8')
      expect(JSON.parse(raw).stepModels).toEqual({ 2: { provider: 'p2', model: 'm2' } })
    })
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

describe('volatile 通道派发（客户端静默写 → 编排器）', () => {
  it('通道值变更 → 解析校验后 applyStepModels（按 sessionId 定位编排器）', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = fakeCtx()
    const config = channelConfig()
    apply(ctx as never, config)
    await seedState('planning', {
      plan: { planDir: join(cwd, '.pae', 'sess-1'), steps: [{ file: 'a.md', title: 'A' }] },
    })
    const agent = fakeAgent('planning')
    await fireCreated(ctx, agent)
    expect(volatileListenerOf(ctx)).toBeDefined()
    feedStepModels(ctx, config, 'sess-1', { 1: { provider: 'a', model: 'm' } })
    await vi.waitFor(async () => {
      expect(ctx.llm.resolveCallConfig).toHaveBeenCalledWith({ provider: 'a', model: 'm' })
      const raw = await readFile(join(cwd, '.pae', 'sess-1', 'orchestrator.json'), 'utf8')
      expect(JSON.parse(raw).stepModels).toEqual({ 1: { provider: 'a', model: 'm' } })
    })
  })

  it('通道值未变化 → 不重复应用（同值去重，不白写盘）', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = fakeCtx()
    const config = channelConfig()
    apply(ctx as never, config)
    await seedState('planning', {
      plan: { planDir: join(cwd, '.pae', 'sess-1'), steps: [{ file: 'a.md', title: 'A' }] },
    })
    const agent = fakeAgent('planning')
    await fireCreated(ctx, agent)
    config.paeStepModels.set({ 'sess-1': { 1: { provider: 'a', model: 'm' } } })
    volatileListenerOf(ctx)!()
    await vi.waitFor(() => {
      expect(ctx.llm.resolveCallConfig).toHaveBeenCalledWith({ provider: 'a', model: 'm' })
    })
    ctx.llm.resolveCallConfig.mockClear()
    // 再次通知但值未变 → 不重新应用
    volatileListenerOf(ctx)!()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(ctx.llm.resolveCallConfig).not.toHaveBeenCalled()
  })

  it('非法条目丢弃、合法条目生效（混合载荷不抛）', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = fakeCtx()
    const config = channelConfig()
    apply(ctx as never, config)
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
    expect(volatileListenerOf(ctx)).toBeDefined()
    config.paeStepModels.set({
      'sess-1': { 1: { provider: 42 }, 2: { provider: 'b', model: 'm2' } },
    } as unknown as StepModelsValue)
    volatileListenerOf(ctx)!()
    await vi.waitFor(async () => {
      expect(ctx.llm.resolveCallConfig).toHaveBeenCalledWith({ provider: 'b', model: 'm2' })
      const raw = await readFile(join(cwd, '.pae', 'sess-1', 'orchestrator.json'), 'utf8')
      expect(JSON.parse(raw).stepModels).toEqual({ 2: { provider: 'b', model: 'm2' } })
    })
  })

  it('applyStepModels 抛错（目录只读落盘失败）→ 记 warn，不抛出（无 unhandled rejection）', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = fakeCtx()
    const config = channelConfig()
    apply(ctx as never, config)
    await seedState('planning', {
      plan: { planDir: join(cwd, '.pae', 'sess-1'), steps: [{ file: 'a.md', title: 'A' }] },
    })
    const agent = fakeAgent('planning')
    await fireCreated(ctx, agent)
    // 目录只读 → save 的 writeFile 抛 EACCES → applyStepModels 抛出 → 内部接住记 warn
    await chmod(join(cwd, '.pae', 'sess-1'), 0o500)
    try {
      expect(() => {
        feedStepModels(ctx, config, 'sess-1', { 1: { provider: 'a', model: 'm' } })
      }).not.toThrow()
      await vi.waitFor(() => {
        expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('应用步骤模型失败'))
      })
    } finally {
      await chmod(join(cwd, '.pae', 'sess-1'), 0o700)
    }
  })

  it('解析出步骤但 resolveCallConfig 全失败 → 跳过本次应用（既有选择保留，不清空）', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = fakeCtx()
    const config = channelConfig()
    apply(ctx as never, config)
    await seedState('planning', {
      plan: { planDir: join(cwd, '.pae', 'sess-1'), steps: [{ file: 'a.md', title: 'A' }] },
      stepModels: { 1: { provider: 'p1', model: 'm1' } },
    })
    const agent = fakeAgent('planning')
    await fireCreated(ctx, agent)
    expect(volatileListenerOf(ctx)).toBeDefined()
    ctx.llm.resolveCallConfig.mockRejectedValue(new Error('unknown model'))
    feedStepModels(ctx, config, 'sess-1', { 1: { provider: 'a', model: 'm' } })
    await vi.waitFor(() => {
      expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('全部步骤模型不可用'))
    })
    const raw = await readFile(join(cwd, '.pae', 'sess-1', 'orchestrator.json'), 'utf8')
    expect(JSON.parse(raw).stepModels).toEqual({ 1: { provider: 'p1', model: 'm1' } })
  })

  it('无编排器的会话键 / 未装配通道 → 静默跳过不抛', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = fakeCtx()
    const config = channelConfig()
    apply(ctx as never, config)
    expect(() => {
      feedStepModels(ctx, config, 'ghost-sess', { 1: { provider: 'a', model: 'm' } })
    }).not.toThrow()
    // 程序化装配省略通道（可选字段）时也照常加载
    const bare = fakeCtx()
    expect(() =>
      apply(bare as never, { onStepFailure: 'pause', maxAutoRecoveries: 2, planDir: '.pae' }),
    ).not.toThrow()
    expect(() => volatileListenerOf(bare)!()).not.toThrow()
  })
})

describe('会话查看脉冲通道（paeSessionPings）', () => {
  it('启动快照：装配时已有的脉冲视为已处理（不重放历史查看信号）', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = fakeCtx()
    const config = channelConfig()
    // 装配前已有脉冲（上一次进程写入的持久值）
    config.paeSessionPings.set({ 'sess-1': { t: Date.now() - 1000 } })
    const userQuestions = {
      ask: vi.fn(async (): Promise<AskUserQuestionAnswer> => ({
        answers: [{ id: 'pae-approve', selected: ['批准'], custom: '' }],
      })),
    }
    const defaultGet = ctx.get.getMockImplementation()!
    ctx.get.mockImplementation((key: string) =>
      key === 'userQuestions' ? userQuestions : defaultGet(key),
    )
    apply(ctx as never, config)
    await seedState('scheduled', {
      scheduledAt: Date.now() + 60_000,
      plan: { planDir: join(cwd, '.pae', 'sess-1'), steps: [{ file: 'a.md', title: 'A' }] },
    })
    await writeFile(join(cwd, '.pae', 'sess-1', 'a.md'), '# A\n内容', 'utf8')
    const agent = fakeAgent('none')
    await fireCreated(ctx, agent)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(userQuestions.ask).toHaveBeenCalledTimes(1) // revive 的回显卡
    // 一次无关的 volatile 通知也不得把历史脉冲当成本次信号重弹
    volatileListenerOf(ctx)!()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(userQuestions.ask).toHaveBeenCalledTimes(1)
  })

  it('scheduled 等待期弹卡被 dismiss → 脉冲重弹回显卡（dismiss 后脉冲重弹链路）', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = fakeCtx()
    const config = channelConfig()
    // 可记录式 userQuestions 假服务：ask#1（revive 弹卡）以拒绝模拟用户关闭/丢卡 →
    // 编排器折叠为 dismissed（保持排期等待）；之后的 ask（脉冲重弹）即刻批准（无载荷 = 保持）
    const userQuestions = {
      ask: vi.fn(
        async (_options: {
          questions: unknown[]
          agent: unknown
          signal?: AbortSignal
        }): Promise<AskUserQuestionAnswer> => ({
          answers: [{ id: 'pae-approve', selected: ['批准'], custom: '' }],
        }),
      ),
    }
    userQuestions.ask.mockRejectedValueOnce(new Error('card dismissed'))
    // 叠加式覆盖：保留 fakeCtx 默认服务（llm 等——整体替换会令相关降级路径失效）
    const defaultGet = ctx.get.getMockImplementation()!
    ctx.get.mockImplementation((key: string) =>
      key === 'userQuestions' ? userQuestions : defaultGet(key),
    )
    apply(ctx as never, config)
    await seedState('scheduled', {
      scheduledAt: Date.now() + 60_000,
      plan: { planDir: join(cwd, '.pae', 'sess-1'), steps: [{ file: 'a.md', title: 'A' }] },
    })
    await writeFile(join(cwd, '.pae', 'sess-1', 'a.md'), '# A\n内容', 'utf8')
    const agent = fakeAgent('none')
    await fireCreated(ctx, agent) // revive → 回显卡 ask#1（dismiss → 保持排期等待、不再弹卡）
    await vi.waitFor(() => expect(userQuestions.ask).toHaveBeenCalledTimes(1))
    // 无卡悬空时脉冲才重弹：dismiss 后走 reviewScheduledAgain → 经 userQuestions 弹 ask#2
    feedPing(ctx, config, 'sess-1', Date.now())
    await vi.waitFor(() => expect(userQuestions.ask).toHaveBeenCalledTimes(2))
    const second = userQuestions.ask.mock.calls[1]![0]!
    expect(second.questions[0]).toMatchObject({ intent: { kind: 'plan-review', approve: '批准' } })
    expect((second.questions[0] as { detail?: string }).detail).toContain('执行排期：')
  })

  it('无对应编排器（sessionId 未注册）/ 非法脉冲值 → 静默跳过不抛', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = fakeCtx()
    const config = channelConfig()
    apply(ctx as never, config)
    // 从未 fireCreated：bySessionId 无该 session → 循环内 continue
    expect(() => feedPing(ctx, config, 'ghost-sess', Date.now())).not.toThrow()
    // 非法脉冲（t 非有限数）→ parsePaePing 拒绝
    config.paeSessionPings.set({ 'sess-1': { t: Number.NaN } })
    expect(() => volatileListenerOf(ctx)!()).not.toThrow()
  })
})

describe('定时排期接线', () => {
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

  it('seam：scheduled 回显卡的撤销 signal 穿过 askFor 到达 userQuestions 服务（未 abort）', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = fakeCtx()
    // 可记录式 userQuestions 假服务：覆盖默认 get 分发（askFor 每次经 get('userQuestions') 取服务）
    const userQuestions = {
      ask: vi.fn(
        async (_options: {
          questions: unknown[]
          agent: unknown
          signal?: AbortSignal
        }): Promise<AskUserQuestionAnswer> => ({
          answers: [{ id: 'pae-approve', selected: ['批准'], custom: '' }],
        }),
      ),
    }
    // 叠加式覆盖：保留 fakeCtx 默认服务（llm 等——整体替换会令降级路径失效）
    const defaultGet = ctx.get.getMockImplementation()!
    ctx.get.mockImplementation((key: string) =>
      key === 'userQuestions' ? userQuestions : defaultGet(key),
    )
    apply(ctx as never, { onStepFailure: 'pause', maxAutoRecoveries: 2, planDir: '.pae' })
    await seedState('scheduled', {
      scheduledAt: Date.now() + 60_000,
      plan: { planDir: join(cwd, '.pae', 'sess-1'), steps: [{ file: 'a.md', title: 'A' }] },
    })
    await writeFile(join(cwd, '.pae', 'sess-1', 'a.md'), '# A\n内容', 'utf8')
    const agent = fakeAgent('none')
    await fireCreated(ctx, agent)
    // 回显卡的 ask 经 askFor → service.ask：请求必须携带编排器的撤销 signal（宿主 ASK_ABORTED 语义的接线证据）
    await vi.waitFor(() => expect(userQuestions.ask).toHaveBeenCalledTimes(1))
    const request = userQuestions.ask.mock.calls[0]![0]!
    expect(request.signal).toBeDefined()
    expect(request.signal?.aborted).toBe(false)
    // 答案消费后不二次弹卡（等待窗口内无多余 ask）
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(userQuestions.ask).toHaveBeenCalledTimes(1)
  })
})

describe('归档守卫接线（workspaceRegistry/sessionPersistence 可选注入）', () => {
  it('默认 fake ctx（两服务属性 undefined）→ 注入闭包降级 undefined，装配照常、命令启动不炸', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = fakeCtx()
    expect(() =>
      apply(ctx as never, { onStepFailure: 'pause', maxAutoRecoveries: 2, planDir: '.pae' }),
    ).not.toThrow()
    // apply 以可选注入挂载两个守卫服务（服务缺失不回调 → 闭包保持 undefined → 判定放行降级）
    expect(ctx.injectCalls).toContainEqual(['workspaceRegistry'])
    expect(ctx.injectCalls).toContainEqual(['sessionPersistence'])
    const handler = ctx.registered.commands[0]!.handler as (
      invocation: Record<string, unknown>,
    ) => Promise<unknown>
    await expect(handler({ agent: fakeAgent('none'), rawInput: '做点事' })).resolves.toMatchObject({
      kind: 'success',
    })
    expect(ctx.logger.warn).not.toHaveBeenCalled()
  })

  it('提供 workspaceRegistry/sessionPersistence 假服务 → 注入闭包读取生效、装配不抛，scheduled revive 路径照旧', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = fakeCtx()
    // 注入回调收到的 ctx 带两服务属性（归档判定/冷落盘读取面；到点 fire 不可达，
    // 决策与作废行为由 archive-guard.spec + orchestrator.spec 覆盖，此处仅验接线不炸）
    ctx.workspaceRegistry = { archivedSessionIds: ['sess-1'] }
    ctx.sessionPersistence = {
      list: vi.fn(async () => [{ id: 'sess-1', cwd }]),
    }
    expect(() =>
      apply(ctx as never, { onStepFailure: 'pause', maxAutoRecoveries: 2, planDir: '.pae' }),
    ).not.toThrow()
    await seedState('scheduled', {
      scheduledAt: Date.now() + 60_000,
      plan: { planDir: join(cwd, '.pae', 'sess-1'), steps: [{ file: 'a.md', title: 'A' }] },
    })
    await writeFile(join(cwd, '.pae', 'sess-1', 'a.md'), '# A\n内容', 'utf8')
    const agent = fakeAgent('none')
    await fireCreated(ctx, agent)
    // revive 的 scheduled 分支照旧复弹 plan-review ask（必经 userQuestions 服务）
    expect(ctx.get).toHaveBeenCalledWith('userQuestions')
    expect(ctx.logger.warn).not.toHaveBeenCalled()
  })
})
