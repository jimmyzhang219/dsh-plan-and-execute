import { afterAll, describe, expect, it, vi } from 'vitest'
import type { Orchestrator } from '../src/orchestrator.ts'
import {
  answer,
  cleanupTempDirs,
  FakeAgent,
  fakeAsk,
  FakeRevivedSession,
  FakeStorage,
  makeOrchestrator,
  type StepSeed,
} from './helpers.ts'

afterAll(async () => {
  await cleanupTempDirs()
})

/**
 * 模拟模型一回合：先等 run 推进到第 stepIndex 步的第 stepAttempt 次尝试
 * （stepAttempt 区分同一步的 retry 重注入），调 report_step（进内存态），
 * 再以 reason 结束 turn。
 */
async function orchestratorTurn(
  orchestrator: Orchestrator,
  agent: FakeAgent,
  reason: string,
  report: { outcome: 'done' | 'blocked'; summary: string } | undefined,
  stepIndex: number,
  stepAttempt: number,
): Promise<void> {
  if (report !== undefined) {
    await vi.waitFor(() => {
      const snap = orchestrator.snapshot()
      if (
        snap.phase !== 'executing' ||
        snap.stepIndex !== stepIndex ||
        snap.stepAttempt !== stepAttempt
      ) {
        throw new Error(`step ${stepIndex} attempt ${stepAttempt} not started`)
      }
    })
    await orchestrator.reportStepForCurrent(report.outcome, report.summary)
  }
  agent.scriptTurn(reason)
}

describe('主执行路径', () => {
  it('begin → planning 状态持久化 + kickoff 注入', async () => {
    const { Orchestrator } = await import('../src/orchestrator.ts')
    const agent = new FakeAgent()
    const { ask } = fakeAsk()
    const storage = new FakeStorage()
    const orchestrator = new Orchestrator({
      agent,
      ask,
      config: { onStepFailure: 'pause', maxAutoRecoveries: 2, planRoot: '.pae' },
      planDir: '/tmp/pae-test-plan',
      storage,
    })
    await orchestrator.begin('做某事')
    expect(agent.steered).toHaveLength(1)
    expect(storage.state?.phase).toBe('planning')
    expect(storage.state?.task).toBe('做某事')
    expect(storage.state?.planDir).toBe('/tmp/pae-test-plan')
  })

  it('submitPlan 批准：持久化 executing + todo 全 pending，逐步执行到完成', async () => {
    const steps: StepSeed[] = [
      { file: 'a.md', title: 'A' },
      { file: 'b.md', title: 'B' },
    ]
    const { orchestrator, agent, verdict, storage } = await makeOrchestrator(steps, [
      answer('pae-approve', '批准'),
    ])
    expect(verdict).toEqual({ approved: true })
    expect(storage.state?.phase).toBe('executing')
    expect(storage.state?.stepIndex).toBe(0)
    expect(agent.session.todosWrites.at(-1)).toEqual([
      { content: '1. A', status: 'pending' },
      { content: '2. B', status: 'pending' },
    ])
    await orchestratorTurn(
      orchestrator,
      agent,
      'completed',
      { outcome: 'done', summary: '完成 A' },
      1,
      1,
    )
    await orchestratorTurn(
      orchestrator,
      agent,
      'completed',
      { outcome: 'done', summary: '完成 B' },
      2,
      2,
    )
    await vi.waitFor(() => {
      expect(storage.state?.phase).toBe('completed')
    })
    expect(agent.session.todosWrites.at(-1)).toEqual([
      { content: '1. A', status: 'completed' },
      { content: '2. B', status: 'completed' },
    ])
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
    const { orchestrator, agent, storage } = await makeOrchestrator(
      [{ file: 'a.md', title: 'A' }],
      [answer('pae-approve', '批准')],
    )
    agent.scriptTurn('completed') // 第一次：无 report
    await orchestratorTurn(
      orchestrator,
      agent,
      'completed',
      { outcome: 'done', summary: '补报' },
      1,
      1,
    ) // 追问后：补报
    await vi.waitFor(() => {
      expect(storage.state?.phase).toBe('completed')
    })
    const texts = agent.steered.map((m) => (m.content[0] as { text: string }).text)
    expect(texts.some((t) => t.includes('report_step'))).toBe(true)
  })
})

describe('暂停与恢复决策', () => {
  it('blocked → 五选项；重试 → 同一步重新注入指令', async () => {
    const { orchestrator, agent, storage } = await makeOrchestrator(
      [
        { file: 'a.md', title: 'A' },
        { file: 'b.md', title: 'B' },
      ],
      [answer('pae-approve', '批准'), answer('pae-pause', '重试该步')],
    )
    await orchestratorTurn(
      orchestrator,
      agent,
      'completed',
      { outcome: 'blocked', summary: '卡住' },
      1,
      1,
    )
    await orchestratorTurn(
      orchestrator,
      agent,
      'completed',
      { outcome: 'done', summary: '重试成功' },
      1,
      2,
    )
    await vi.waitFor(() => {
      expect(storage.state?.phase).toBe('executing')
      expect(storage.state?.stepIndex).toBe(2)
    })
    const texts = agent.steered.map((m) => (m.content[0] as { text: string }).text)
    expect(texts.filter((t) => t.includes('执行计划第 1/2 步')).length).toBe(2) // 同一步注入两次
  })

  it('turn aborted（用户取消）→ paused(cancelled)，弹窗被关 → dismissed 保持暂停', async () => {
    const { agent, storage } = await makeOrchestrator(
      [{ file: 'a.md', title: 'A' }],
      [answer('pae-approve', '批准'), new Error('dismissed')],
    )
    agent.scriptTurn('aborted')
    await vi.waitFor(() => {
      expect(storage.state).toMatchObject({ phase: 'paused', pausedReason: 'cancelled' })
    })
  })

  it('追问后仍不汇报 → 按失败暂停；选终止 → aborted', async () => {
    const { agent, storage } = await makeOrchestrator(
      [{ file: 'a.md', title: 'A' }],
      [answer('pae-approve', '批准'), answer('pae-pause', '终止')],
    )
    agent.scriptTurn('completed')
    agent.scriptTurn('completed') // 追问后仍无 report
    await vi.waitFor(() => {
      expect(storage.state?.phase).toBe('aborted')
    })
    // ask 脚本化无延迟：paused(failure) 已被 aborted 覆盖；中间态由终态证明暂停路径走过
    expect(storage.state?.phase).toBe('aborted')
  })

  it('auto-recover：限额内自愈，超限升级暂停', async () => {
    const { orchestrator, agent, storage } = await makeOrchestrator(
      [{ file: 'a.md', title: 'A' }],
      [answer('pae-approve', '批准'), answer('pae-pause', '终止')],
      { onStepFailure: 'auto-recover', maxAutoRecoveries: 1 },
    )
    await orchestratorTurn(
      orchestrator,
      agent,
      'completed',
      { outcome: 'blocked', summary: '第一次' },
      1,
      1,
    )
    await orchestratorTurn(
      orchestrator,
      agent,
      'completed',
      { outcome: 'blocked', summary: '第二次' },
      1,
      1,
    ) // 超限（recover 不重注入步骤指令，attempt 不变）
    await vi.waitFor(() => {
      expect(storage.state?.phase).toBe('aborted')
    })
    const texts = agent.steered.map((m) => (m.content[0] as { text: string }).text)
    expect(texts.filter((t) => t.includes('自行调整')).length).toBe(1) // 恰好一次自愈指令
  })

  it('跳过 → todo 保持 pending，终局标注 skipped', async () => {
    const { orchestrator, agent, received } = await makeOrchestrator(
      [
        { file: 'a.md', title: 'A' },
        { file: 'b.md', title: 'B' },
      ],
      [answer('pae-approve', '批准'), answer('pae-pause', '跳过该步')],
    )
    await orchestratorTurn(
      orchestrator,
      agent,
      'completed',
      { outcome: 'blocked', summary: '卡住' },
      1,
      1,
    )
    await orchestratorTurn(
      orchestrator,
      agent,
      'completed',
      { outcome: 'done', summary: 'B 完成' },
      2,
      2,
    )
    await vi.waitFor(() => {
      const doneAsk = received.at(-1)?.[0]
      expect(doneAsk?.id).toBe('pae-done')
      expect(doneAsk?.detail).toContain('skipped')
    })
  })
})

describe('确认点 / replan / revive', () => {
  it('requiresConfirmation 步前弹四选项确认点，选继续后执行', async () => {
    const { orchestrator, agent, received, storage } = await makeOrchestrator(
      [{ file: 'a.md', title: 'A', requiresConfirmation: true }],
      [answer('pae-approve', '批准'), answer('pae-confirm', '继续')],
    )
    await orchestratorTurn(
      orchestrator,
      agent,
      'completed',
      { outcome: 'done', summary: 'A 完成' },
      1,
      1,
    )
    await vi.waitFor(() => {
      expect(storage.state?.phase).toBe('completed')
    })
    expect(received[1]?.[0]?.id).toBe('pae-confirm')
  })

  it('确认点选跳过 → 该步不执行、终局 skipped', async () => {
    const { agent, received } = await makeOrchestrator(
      [{ file: 'a.md', title: 'A', requiresConfirmation: true }],
      [answer('pae-approve', '批准'), answer('pae-confirm', '跳过该步')],
    )
    await vi.waitFor(() => {
      const doneAsk = received.at(-1)?.[0]
      expect(doneAsk?.id).toBe('pae-done')
      expect(doneAsk?.detail).toContain('skipped')
    })
    // 没有任何步骤指令被注入（A 被跳过）
    const texts = agent.steered.map((m) => (m.content[0] as { text: string }).text)
    expect(texts.some((t) => t.includes('执行计划第 1/1 步'))).toBe(false)
  })

  it('暂停选回到计划阶段 → planning 状态 + replan 指令（含反馈）', async () => {
    const { orchestrator, agent, storage } = await makeOrchestrator(
      [{ file: 'a.md', title: 'A' }],
      [answer('pae-approve', '批准'), answer('pae-pause', '回到计划阶段', '加一步测试')],
    )
    await orchestratorTurn(
      orchestrator,
      agent,
      'completed',
      { outcome: 'blocked', summary: '卡住' },
      1,
      1,
    )
    await vi.waitFor(() => {
      expect(storage.state?.phase).toBe('planning')
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
      storage: revived.storage,
    })
    const revivePromise = orchestrator.revive()
    await vi.waitFor(() => revived.receivedQuestions.length > 0)
    expect(revived.receivedQuestions[0]?.[0]?.id).toBe('pae-resume')
    revived.resolveResume(answer('pae-resume', '从断点继续'))
    await orchestratorTurn(
      orchestrator,
      revived.agent,
      'completed',
      {
        outcome: 'done',
        summary: '续跑',
      },
      1,
      1,
    )
    await orchestratorTurn(
      orchestrator,
      revived.agent,
      'completed',
      {
        outcome: 'done',
        summary: '完成',
      },
      2,
      2,
    )
    await revivePromise
    expect(revived.storage.state?.phase).toBe('completed')
  })
})

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
    const { Orchestrator } = await import('../src/orchestrator.ts')
    const { FakeAgent, FakeStorage, fakeAsk, answer } = await import('./helpers.ts')
    const { mkdtemp, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const planDir = await mkdtemp(join(tmpdir(), 'pae-dir-'))
    const orchestrator = new Orchestrator({
      agent: new FakeAgent(),
      ask: fakeAsk(answer('pae-approve', '批准')).ask,
      config: { onStepFailure: 'pause', maxAutoRecoveries: 2, planRoot: '.pae' },
      planDir,
      storage: new FakeStorage(),
    })
    await orchestrator.begin('T')
    await writeFile(join(planDir, 'a.md'), '# A\n内容', 'utf8')
    const verdict = await orchestrator.submitPlan(`${planDir}/`, [{ file: 'a.md', title: 'A' }])
    expect(verdict.approved).toBe(true)
  })
})

describe('生命周期钩子', () => {
  it('begin 触发 onActivate，finish(completed) 触发 onRestore', async () => {
    const activated: number[] = []
    const restored: number[] = []
    const { orchestrator, agent } = await makeOrchestrator(
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
    await orchestratorTurn(
      orchestrator,
      agent,
      'completed',
      { outcome: 'done', summary: '完成' },
      1,
      1,
    )
    await vi.waitFor(() => {
      expect(restored).toEqual([1])
    })
  })

  it('revive 触发 onActivate', async () => {
    const revived = new FakeRevivedSession()
    const { Orchestrator } = await import('../src/orchestrator.ts')
    const activated: number[] = []
    const orchestrator = new Orchestrator({
      agent: revived.agent,
      ask: revived.ask,
      config: { onStepFailure: 'pause', maxAutoRecoveries: 2, planRoot: '.pae' },
      planDir: revived.planDir,
      storage: revived.storage,
      hooks: { onActivate: () => activated.push(1) },
    })
    const revivePromise = orchestrator.revive()
    await vi.waitFor(() => revived.receivedQuestions.length > 0)
    expect(activated).toEqual([1])
    revived.resolveResume(answer('pae-resume', '终止'))
    await revivePromise
  })
})

describe('applyStepModels / stepModelFor', () => {
  it('planning 阶段 apply 成功并持久化；begin 后 cleared', async () => {
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

  it('未开始阶段 → 拒绝；步骤号非正整数 → 拒绝；越界 → 拒绝', async () => {
    const { Orchestrator } = await import('../src/orchestrator.ts')
    const { FakeAgent, FakeStorage, fakeAsk } = await import('./helpers.ts')
    const { mkdtemp } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const planDir = await mkdtemp(join(tmpdir(), 'pae-models-'))
    const orchestrator = new Orchestrator({
      agent: new FakeAgent(),
      ask: fakeAsk().ask,
      config: { onStepFailure: 'pause', maxAutoRecoveries: 2, planRoot: '.pae' },
      planDir,
      storage: new FakeStorage(),
    })
    // 未 begin（phase none）→ 拒绝；planning 阶段允许预设置（见首个用例）
    const noPlan = await orchestrator.applyStepModels({ 1: { provider: 'a', model: 'm' } })
    expect(noPlan.ok).toBe(false)
    if (!noPlan.ok) expect(noPlan.error).toContain('当前阶段')
    // planning（无 plan）只校验正整数：0/'1.5'/'abc' → 拒绝
    await orchestrator.begin('T')
    for (const key of ['0', '1.5', 'abc']) {
      const bad = await orchestrator.applyStepModels({ [key]: { provider: 'a', model: 'm' } })
      expect(bad.ok).toBe(false)
      if (!bad.ok) expect(bad.error).toContain(`步骤号 ${key} 不是正整数`)
    }
    // 批准后 applyStepModels({3:...}) → 拒绝（1..2 之外）
    const { orchestrator: orch } = await makeOrchestrator(
      [
        { file: 'a.md', title: 'A' },
        { file: 'b.md', title: 'B' },
      ],
      [answer('pae-approve', '批准')],
    )
    const outOfRange = await orch.applyStepModels({ 3: { provider: 'b', model: 'm2' } })
    expect(outOfRange.ok).toBe(false)
    if (!outOfRange.ok) expect(outOfRange.error).toContain('超出计划范围')
    if (!outOfRange.ok) expect(outOfRange.error).toContain('1..2')
  })

  it('completed 阶段（计划仍存在）→ 拒绝，文案不误导为「没有已提交的计划」', async () => {
    const revived = new FakeRevivedSession()
    revived.storage.state = { ...revived.storage.state!, phase: 'completed' }
    const { Orchestrator } = await import('../src/orchestrator.ts')
    const orchestrator = new Orchestrator({
      agent: revived.agent,
      ask: revived.ask,
      config: { onStepFailure: 'pause', maxAutoRecoveries: 2, planRoot: '.pae' },
      planDir: revived.planDir,
      storage: revived.storage,
    })
    await orchestrator.revive()
    const result = await orchestrator.applyStepModels({ 1: { provider: 'a', model: 'm' } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('当前阶段')
  })

  it('planning 预设置模型后 submitPlan 批准 → 映射保留（批准不清空）', async () => {
    const { Orchestrator } = await import('../src/orchestrator.ts')
    const { FakeAgent, FakeStorage, fakeAsk, answer } = await import('./helpers.ts')
    const { mkdtemp, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const planDir = await mkdtemp(join(tmpdir(), 'pae-models-'))
    const storage = new FakeStorage()
    const orchestrator = new Orchestrator({
      agent: new FakeAgent(),
      ask: fakeAsk(answer('pae-approve', '批准')).ask,
      config: { onStepFailure: 'pause', maxAutoRecoveries: 2, planRoot: '.pae' },
      planDir,
      storage,
    })
    await orchestrator.begin('T')
    const result = await orchestrator.applyStepModels({ 1: { provider: 'a', model: 'm' } })
    expect(result).toEqual({ ok: true })
    await writeFile(join(planDir, 'a.md'), '# A\n内容', 'utf8')
    const verdict = await orchestrator.submitPlan(planDir, [{ file: 'a.md', title: 'A' }])
    expect(verdict).toEqual({ approved: true })
    expect(storage.state?.stepModels).toEqual({ 1: { provider: 'a', model: 'm' } })
    expect(orchestrator.stepModelFor(1)).toEqual({ provider: 'a', model: 'm' })
  })

  it('executing 阶段 stepModelFor 命中映射；无映射透传 undefined', async () => {
    const { orchestrator } = await makeOrchestrator(
      [
        { file: 'a.md', title: 'A' },
        { file: 'b.md', title: 'B' },
      ],
      [answer('pae-approve', '批准')],
    )
    const result = await orchestrator.applyStepModels({ 2: { provider: 'b', model: 'm2' } })
    expect(result).toEqual({ ok: true })
    expect(orchestrator.stepModelFor(2)).toEqual({ provider: 'b', model: 'm2' })
    expect(orchestrator.stepModelFor(1)).toBeUndefined()
  })

  it('revive 从持久化恢复 stepModels', async () => {
    const revived = new FakeRevivedSession()
    revived.storage.state = {
      ...revived.storage.state!,
      stepModels: { 1: { provider: 'a', model: 'm' } },
    }
    const { Orchestrator } = await import('../src/orchestrator.ts')
    const orchestrator = new Orchestrator({
      agent: revived.agent,
      ask: revived.ask,
      config: { onStepFailure: 'pause', maxAutoRecoveries: 2, planRoot: '.pae' },
      planDir: revived.planDir,
      storage: revived.storage,
    })
    const revivePromise = orchestrator.revive()
    await vi.waitFor(() => revived.receivedQuestions.length > 0) // 恢复询问挂起即可，不必走完
    expect(orchestrator.stepModelFor(1)).toEqual({ provider: 'a', model: 'm' })
    revived.resolveResume(answer('pae-resume', '终止'))
    await revivePromise
  })
})
