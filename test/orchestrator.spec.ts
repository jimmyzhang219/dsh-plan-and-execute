import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  answer,
  cleanupTempDirs,
  FakeAgent,
  fakeAsk,
  FakeRevivedSession,
  makeOrchestrator,
  type StepSeed,
} from './helpers.ts'

afterAll(async () => {
  await cleanupTempDirs()
})

const planDir = '/tmp/pae-test-plan'

describe('主执行路径', () => {
  it('begin → planning 状态 + kickoff 注入', async () => {
    const { Orchestrator } = await import('../src/orchestrator.ts')
    const agent = new FakeAgent()
    const { ask } = fakeAsk()
    const orchestrator = new Orchestrator({
      agent,
      ask,
      config: { onStepFailure: 'pause', maxAutoRecoveries: 2, planRoot: '.pae' },
      planDir,
    })
    orchestrator.begin('做某事')
    expect(agent.steered).toHaveLength(1)
    const state = agent.session.events.find((e) => e.type === 'pae/state')
    expect(state?.data).toMatchObject({ phase: 'planning', task: '做某事', planDir })
  })

  it('begin 触发 onActivate，finish(completed) 触发 onRestore', async () => {
    const activated: number[] = []
    const restored: number[] = []
    const { agent } = await makeOrchestrator(
      [{ file: 'a.md', title: 'A' }],
      [answer('pae-approve', '批准')],
      {},
      {
        onActivate: () => activated.push(activated.length + 1),
        onRestore: () => restored.push(restored.length + 1),
      },
    )
    expect(activated).toEqual([1])
    expect(restored).toEqual([])
    agent.scriptTurn('completed', { outcome: 'done', summary: '完成' }, 1)
    await vi.waitFor(() => {
      const state = [...agent.session.events].reverse().find((e) => e.type === 'pae/state')
      expect(state?.data).toMatchObject({ phase: 'completed' })
    })
    expect(restored).toEqual([1])
  })

  it('revive 触发 onActivate（幂等重复激活由装配层负责）', async () => {
    const revived = new FakeRevivedSession()
    const { Orchestrator } = await import('../src/orchestrator.ts')
    const activated: number[] = []
    const orchestrator = new Orchestrator({
      agent: revived.agent,
      ask: revived.ask,
      config: { onStepFailure: 'pause', maxAutoRecoveries: 2, planRoot: '.pae' },
      planDir: revived.planDir,
      hooks: { onActivate: () => activated.push(1) },
    })
    const revivePromise = orchestrator.revive()
    await vi.waitFor(() => revived.receivedQuestions.length > 0)
    expect(activated).toEqual([1])
    revived.resolveResume(answer('pae-resume', '终止'))
    await revivePromise
  })

  it('submitPlan 批准：落 pae/plan + executing + todo 全 pending，逐步执行到完成', async () => {
    const steps: StepSeed[] = [
      { file: 'a.md', title: 'A' },
      { file: 'b.md', title: 'B' },
    ]
    const { agent, verdict } = await makeOrchestrator(steps, [answer('pae-approve', '批准')])
    expect(verdict).toEqual({ approved: true })
    agent.scriptTurn('completed', { outcome: 'done', summary: '完成 A' }, 1)
    agent.scriptTurn('completed', { outcome: 'done', summary: '完成 B' }, 2)
    await vi.waitFor(() => {
      const last = [...agent.session.events].reverse().find((e) => e.type === 'pae/state')
      expect(last?.data).toMatchObject({ phase: 'completed' })
    })
    const todos = [...agent.session.events].reverse().find((e) => e.type === 'todo/write')
    expect(todos?.data).toMatchObject({
      todos: [
        { content: '1. A', status: 'completed' },
        { content: '2. B', status: 'completed' },
      ],
    })
    // kickoff + 两条步骤指令
    expect(agent.steered.filter((m) => m.source.kind === 'plugin')).toHaveLength(3)
  })

  it('submitPlan 驳回：反馈文本返回给工具层抛错', async () => {
    const { verdict } = await makeOrchestrator(
      [{ file: 'a.md', title: 'A' }],
      [answer('pae-approve', '继续修改', '粒度太粗')],
    )
    expect(verdict.approved).toBe(false)
    if (!verdict.approved) expect(verdict.error).toContain('粒度太粗')
  })
})

describe('异常路径', () => {
  it('completed 但未汇报 → 追问一次；补报 done 后继续', async () => {
    const { agent } = await makeOrchestrator(
      [{ file: 'a.md', title: 'A' }],
      [answer('pae-approve', '批准')],
    )
    agent.scriptTurn('completed', undefined) // 第一次：无 report
    agent.scriptTurn('completed', { outcome: 'done', summary: '补报' }, 1) // 追问后：补报
    await vi.waitFor(() => {
      const last = [...agent.session.events].reverse().find((e) => e.type === 'pae/state')
      expect(last?.data).toMatchObject({ phase: 'completed' })
    })
    const texts = agent.steered.map((m) => (m.content[0] as { text: string }).text)
    expect(texts.some((t) => t.includes('report_step'))).toBe(true)
  })
})

describe('暂停与恢复决策', () => {
  it('blocked → 五选项；重试 → 同一步重新注入指令', async () => {
    const { agent } = await makeOrchestrator(
      [
        { file: 'a.md', title: 'A' },
        { file: 'b.md', title: 'B' },
      ],
      [answer('pae-approve', '批准'), answer('pae-pause', '重试该步')],
    )
    agent.scriptTurn('completed', { outcome: 'blocked', summary: '卡住' }, 1)
    agent.scriptTurn('completed', { outcome: 'done', summary: '重试成功' }, 1)
    await vi.waitFor(() => {
      const state = [...agent.session.events].reverse().find((e) => e.type === 'pae/state')
      expect(state?.data).toMatchObject({ phase: 'executing', stepIndex: 2 })
    })
    const texts = agent.steered.map((m) => (m.content[0] as { text: string }).text)
    expect(texts.filter((t) => t.includes('执行计划第 1/2 步')).length).toBe(2) // 同一步注入两次
  })

  it('turn aborted（用户取消）→ paused(cancelled)，弹窗被关 → dismissed 保持暂停', async () => {
    const { agent } = await makeOrchestrator(
      [{ file: 'a.md', title: 'A' }],
      [answer('pae-approve', '批准'), new Error('dismissed')],
    )
    agent.scriptTurn('aborted')
    await vi.waitFor(() => {
      const state = [...agent.session.events].reverse().find((e) => e.type === 'pae/state')
      expect(state?.data).toMatchObject({ phase: 'paused', pausedReason: 'cancelled' })
    })
  })

  it('追问后仍不汇报 → 按失败暂停；选终止 → aborted', async () => {
    const { agent } = await makeOrchestrator(
      [{ file: 'a.md', title: 'A' }],
      [answer('pae-approve', '批准'), answer('pae-pause', '终止')],
    )
    agent.scriptTurn('completed', undefined)
    agent.scriptTurn('completed', undefined) // 追问后仍无 report
    await vi.waitFor(() => {
      const state = [...agent.session.events].reverse().find((e) => e.type === 'pae/state')
      expect(state?.data).toMatchObject({ phase: 'aborted' })
    })
    // 事件序列中曾出现 paused(failure)（ask 脚本化无延迟，随即被 aborted 覆盖）
    const paused = agent.session.events.find(
      (e) => e.type === 'pae/state' && e.data.phase === 'paused',
    )
    expect(paused?.data).toMatchObject({ pausedReason: 'failure' })
  })

  it('auto-recover：限额内自愈，超限升级暂停', async () => {
    const { agent } = await makeOrchestrator(
      [{ file: 'a.md', title: 'A' }],
      [answer('pae-approve', '批准'), answer('pae-pause', '终止')],
      { onStepFailure: 'auto-recover', maxAutoRecoveries: 1 },
    )
    agent.scriptTurn('completed', { outcome: 'blocked', summary: '第一次' }, 1)
    agent.scriptTurn('completed', { outcome: 'blocked', summary: '第二次' }, 1) // 自愈 1 次后仍 blocked → 超限
    await vi.waitFor(() => {
      const state = [...agent.session.events].reverse().find((e) => e.type === 'pae/state')
      expect(state?.data).toMatchObject({ phase: 'aborted' })
    })
    const paused = agent.session.events.find(
      (e) => e.type === 'pae/state' && e.data.phase === 'paused',
    )
    expect(paused?.data).toMatchObject({ pausedReason: 'failure' })
    const texts = agent.steered.map((m) => (m.content[0] as { text: string }).text)
    expect(texts.filter((t) => t.includes('自行调整')).length).toBe(1) // 恰好一次自愈指令
  })

  it('跳过 → todo 保持 pending，终局标注 skipped', async () => {
    const { agent, received } = await makeOrchestrator(
      [
        { file: 'a.md', title: 'A' },
        { file: 'b.md', title: 'B' },
      ],
      [answer('pae-approve', '批准'), answer('pae-pause', '跳过该步')],
    )
    agent.scriptTurn('completed', { outcome: 'blocked', summary: '卡住' }, 1)
    agent.scriptTurn('completed', { outcome: 'done', summary: 'B 完成' }, 2)
    await vi.waitFor(() => {
      const state = [...agent.session.events].reverse().find((e) => e.type === 'pae/state')
      expect(state?.data).toMatchObject({ phase: 'completed' })
    })
    // 终局弹窗 detail 含 skipped
    const doneAsk = received.at(-1)?.[0]
    expect(doneAsk?.id).toBe('pae-done')
    expect(doneAsk?.detail).toContain('skipped')
  })
})

describe('确认点 / replan / revive', () => {
  it('requiresConfirmation 步前弹四选项确认点，选继续后执行', async () => {
    const { agent, received } = await makeOrchestrator(
      [{ file: 'a.md', title: 'A', requiresConfirmation: true }],
      [answer('pae-approve', '批准'), answer('pae-confirm', '继续')],
    )
    agent.scriptTurn('completed', { outcome: 'done', summary: 'A 完成' }, 1)
    await vi.waitFor(() => {
      const state = [...agent.session.events].reverse().find((e) => e.type === 'pae/state')
      expect(state?.data).toMatchObject({ phase: 'completed' })
    })
    expect(received[1]?.[0]?.id).toBe('pae-confirm')
    const pausedEvent = agent.session.events.find(
      (e) =>
        e.type === 'pae/state' &&
        (e.data as { pausedReason?: string }).pausedReason === 'confirm-point',
    )
    expect(pausedEvent).toBeDefined()
  })

  it('确认点选跳过 → 该步不执行、终局 skipped', async () => {
    const { agent, received } = await makeOrchestrator(
      [{ file: 'a.md', title: 'A', requiresConfirmation: true }],
      [answer('pae-approve', '批准'), answer('pae-confirm', '跳过该步')],
    )
    await vi.waitFor(() => {
      const state = [...agent.session.events].reverse().find((e) => e.type === 'pae/state')
      expect(state?.data).toMatchObject({ phase: 'completed' })
    })
    // 没有任何步骤指令被注入（A 被跳过）
    const texts = agent.steered.map((m) => (m.content[0] as { text: string }).text)
    expect(texts.some((t) => t.includes('执行计划第 1/1 步'))).toBe(false)
    const doneAsk = received.at(-1)?.[0]
    expect(doneAsk?.id).toBe('pae-done')
    expect(doneAsk?.detail).toContain('skipped')
  })

  it('暂停选回到计划阶段 → planning 状态 + replan 指令（含反馈）', async () => {
    const { agent } = await makeOrchestrator(
      [{ file: 'a.md', title: 'A' }],
      [answer('pae-approve', '批准'), answer('pae-pause', '回到计划阶段', '加一步测试')],
    )
    agent.scriptTurn('completed', { outcome: 'blocked', summary: '卡住' }, 1)
    await vi.waitFor(() => {
      const state = [...agent.session.events].reverse().find((e) => e.type === 'pae/state')
      expect(state?.data).toMatchObject({ phase: 'planning' })
    })
    const last = agent.steered.at(-1)
    expect((last?.content[0] as { text: string }).text).toContain('加一步测试')
  })

  it('revive：executing 中断 → 断点续跑弹窗，从当前步重注入', async () => {
    const revived = new FakeRevivedSession()
    const { Orchestrator } = await import('../src/orchestrator.ts')
    const orchestrator = new Orchestrator({
      agent: revived.agent,
      ask: revived.ask,
      config: { onStepFailure: 'pause', maxAutoRecoveries: 2, planRoot: '.pae' },
      planDir: revived.planDir,
    })
    const revivePromise = orchestrator.revive()
    await vi.waitFor(() => revived.receivedQuestions.length > 0)
    expect(revived.receivedQuestions[0]?.[0]?.id).toBe('pae-resume')
    revived.resolveResume(answer('pae-resume', '从断点继续'))
    revived.agent.scriptTurn('completed', { outcome: 'done', summary: '续跑' }, 1)
    revived.agent.scriptTurn('completed', { outcome: 'done', summary: '完成' }, 2)
    await revivePromise
    const state = [...revived.agent.session.events].reverse().find((e) => e.type === 'pae/state')
    expect(state?.data).toMatchObject({ phase: 'completed' })
  })
})
