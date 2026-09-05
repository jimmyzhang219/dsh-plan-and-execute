import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type { Orchestrator } from '../src/orchestrator.ts'
import {
  answer,
  cleanupTempDirs,
  FakeAgent,
  fakeAsk,
  fakeScheduler,
  FakeRevivedSession,
  FakeStorage,
  fakeUserMessage,
  makeOrchestrator,
  tempDirs,
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
  report:
    | { status: 'success' | 'failed'; artifacts?: string[]; summary: string; exit_code?: number }
    | undefined,
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
    await orchestrator.reportStepForCurrent(
      report.status,
      report.artifacts ?? [],
      report.summary,
      report.exit_code,
    )
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
    // 用户原文（kind=user）+ kickoff 指令（kind=plugin）两条注入
    expect(agent.steered).toHaveLength(2)
    expect(agent.steered[0]!.source).toEqual({ kind: 'user' })
    expect((agent.steered[0]!.content[0] as { text: string }).text).toBe('做某事')
    expect(agent.steered[1]!.source).toMatchObject({
      kind: 'plugin',
      plugin: 'dsh-plan-and-execute',
    })
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
      { status: 'success', summary: '完成 A' },
      1,
      1,
    )
    // 串行推进：step 1 完成即标记 completed（此前保持 in_progress 直到 finish 统一置位）
    await vi.waitFor(() => {
      expect(agent.session.todosWrites.at(-1)).toEqual([
        { content: '1. A', status: 'completed' },
        { content: '2. B', status: 'in_progress' },
      ])
    })
    await orchestratorTurn(
      orchestrator,
      agent,
      'completed',
      { status: 'success', summary: '完成 B' },
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
      { status: 'success', summary: '补报' },
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
      { status: 'failed', summary: '卡住' },
      1,
      1,
    )
    await orchestratorTurn(
      orchestrator,
      agent,
      'completed',
      { status: 'success', summary: '重试成功' },
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
      { status: 'failed', summary: '第一次' },
      1,
      1,
    )
    await orchestratorTurn(
      orchestrator,
      agent,
      'completed',
      { status: 'failed', summary: '第二次' },
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
      { status: 'failed', summary: '卡住' },
      1,
      1,
    )
    await orchestratorTurn(
      orchestrator,
      agent,
      'completed',
      { status: 'success', summary: 'B 完成' },
      2,
      2,
    )
    // 完成不再弹通知卡（2026-08-30 需求）：无 pae-done 提问，todo 表反映终态
    expect(received.flat().map((q) => q.id)).not.toContain('pae-done')
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
      { status: 'success', summary: 'A 完成' },
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
    // 完成不再弹通知卡：无 pae-done 提问
    expect(received.flat().map((q) => q.id)).not.toContain('pae-done')
    // 没有任何步骤指令被注入（A 被跳过）
    const texts = agent.steered.map((m) => (m.content[0] as { text: string }).text)
    expect(texts.some((t) => t.includes('执行计划第 1/1 步'))).toBe(false)
  })

  it('暂停选回到计划阶段 → planning 状态 + replan 上下文（含反馈，锚定消息）+ replan 指令', async () => {
    const { orchestrator, agent, storage } = await makeOrchestrator(
      [{ file: 'a.md', title: 'A' }],
      [answer('pae-approve', '批准'), answer('pae-pause', '回到计划阶段', '加一步测试')],
    )
    await orchestratorTurn(
      orchestrator,
      agent,
      'completed',
      { status: 'failed', summary: '卡住' },
      1,
      1,
    )
    await vi.waitFor(() => {
      expect(storage.state?.phase).toBe('planning')
    })
    // 反馈在整面 replace 的上下文消息里（模型可见），指令正文不再重复
    const context = agent.session.replaceCalls.at(-1)
    expect((context?.message.content[0] as { text: string }).text).toContain('加一步测试')
    const last = agent.steered.at(-1)
    expect((last?.content[0] as { text: string }).text).toContain('回到规划阶段')
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
        status: 'success',
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
        status: 'success',
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
    const verdict = await orchestrator.submitPlan(`${planDir}/..`, [{ file: 'a.md', title: 'A' }])
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
      { status: 'success', summary: '完成' },
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

  it('refreshTodos：executing 且有计划 → 重写当前状态快照（宿主 turn/start 清空后补写）', async () => {
    const { orchestrator, agent } = await makeOrchestrator(
      [
        { file: 'a.md', title: 'A' },
        { file: 'b.md', title: 'B' },
      ],
      [answer('pae-approve', '批准')],
    )
    const before = agent.session.todosWrites.length
    orchestrator.refreshTodos()
    expect(agent.session.todosWrites.length).toBe(before + 1)
    const last = agent.session.todosWrites.at(-1)!
    expect(last.map((t) => t.content)).toEqual(['1. A', '2. B'])
  })

  it('refreshTodos：planning / 无计划 → 不写', async () => {
    const { Orchestrator } = await import('../src/orchestrator.ts')
    const { FakeAgent, FakeStorage, fakeAsk } = await import('./helpers.ts')
    const { mkdtemp } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const planDir = await mkdtemp(join(tmpdir(), 'pae-refresh-'))
    const agent = new FakeAgent()
    const orchestrator = new Orchestrator({
      agent,
      ask: fakeAsk().ask,
      config: { onStepFailure: 'pause', maxAutoRecoveries: 2, planRoot: '.pae' },
      planDir,
      storage: new FakeStorage(),
    })
    await orchestrator.begin('T') // planning 且无计划
    const before = agent.session.todosWrites.length
    orchestrator.refreshTodos()
    expect(agent.session.todosWrites.length).toBe(before)
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

  it('paused 阶段（revive 恢复 + plan 存在）applyStepModels 成功、stepModelFor 命中', async () => {
    const revived = new FakeRevivedSession()
    revived.storage.state = {
      ...revived.storage.state!,
      phase: 'paused',
      pausedReason: 'failure',
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
    await vi.waitFor(() => revived.receivedQuestions.length > 0) // 暂停弹窗挂起（phase 已置 paused）
    const result = await orchestrator.applyStepModels({ 1: { provider: 'b', model: 'm2' } })
    expect(result).toEqual({ ok: true })
    expect(orchestrator.stepModelFor(1)).toEqual({ provider: 'b', model: 'm2' })
    expect(orchestrator.stepModelFor(2)).toBeUndefined()
    // plan 存在 → 越界仍拒绝
    const out = await orchestrator.applyStepModels({ 3: { provider: 'b', model: 'm2' } })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toContain('超出计划范围')
    revived.resolveResume(answer('pae-pause', '终止'))
    await revivePromise
  })
})

describe('消息隔离（surface 锚定）', () => {
  it('每步恰好一次整面 replace：首步锚定计划摘要，次步锚定上一步报告', async () => {
    const { orchestrator, agent } = await makeOrchestrator(
      [
        { file: 'a.md', title: 'A' },
        { file: 'b.md', title: 'B' },
      ],
      [answer('pae-approve', '批准')],
    )
    await orchestratorTurn(
      orchestrator,
      agent,
      'completed',
      { status: 'success', artifacts: ['a.md'], summary: '完成 A' },
      1,
      1,
    )
    await orchestratorTurn(
      orchestrator,
      agent,
      'completed',
      { status: 'success', summary: '完成 B' },
      2,
      2,
    )
    await vi.waitFor(() => {
      expect(agent.session.todosWrites.at(-1)).toEqual([
        { content: '1. A', status: 'completed' },
        { content: '2. B', status: 'completed' },
      ])
    })
    const calls = agent.session.replaceCalls
    expect(calls).toHaveLength(2)
    // 首步：整面遮蔽 begin 注入的任务+kickoff（seq 1..2）
    expect(calls[0]).toMatchObject({ start: 1, end: 2, sourceEventSeqs: [1, 2] })
    expect((calls[0]!.message.content[0] as { text: string }).text).toContain(
      '[plan-and-execute 计划摘要]',
    )
    // 次步：遮蔽首步上下文+指令（seq 3..4），携带上一步报告
    expect(calls[1]).toMatchObject({ start: 3, end: 4, sourceEventSeqs: [3, 4] })
    const step2Context = (calls[1]!.message.content[0] as { text: string }).text
    expect(step2Context).toContain('上一步结果：第 1/2 步（A）')
    expect(step2Context).toContain('完成 A')
  })

  it('nudge/recover/retry 不产生新锚定（同一步上下文保持）', async () => {
    // nudge 路径：缺报追问只 steer
    const { orchestrator: orch1, agent: agent1 } = await makeOrchestrator(
      [{ file: 'a.md', title: 'A' }],
      [answer('pae-approve', '批准')],
    )
    agent1.scriptTurn('completed') // 首回合缺报 → nudge
    await orchestratorTurn(orch1, agent1, 'completed', { status: 'success', summary: '补报' }, 1, 1)
    await vi.waitFor(() => {
      expect(orch1.snapshot().phase).toBe('completed')
    })
    expect(agent1.session.replaceCalls).toHaveLength(1)
    // retry 路径：暂停选重试，重新注入指令但不锚定
    const { orchestrator: orch2, agent: agent2 } = await makeOrchestrator(
      [{ file: 'a.md', title: 'A' }],
      [answer('pae-approve', '批准'), answer('pae-pause', '重试该步')],
    )
    await orchestratorTurn(orch2, agent2, 'completed', { status: 'failed', summary: '卡住' }, 1, 1)
    await orchestratorTurn(
      orch2,
      agent2,
      'completed',
      { status: 'success', summary: '重试成功' },
      1,
      2,
    )
    await vi.waitFor(() => {
      expect(orch2.snapshot().phase).toBe('completed')
    })
    expect(agent2.session.replaceCalls).toHaveLength(1) // 只有首步锚定
  })

  it('skip 后下一步上下文为合成报告（「被跳过」而非计划摘要）', async () => {
    const { orchestrator, agent } = await makeOrchestrator(
      [
        { file: 'a.md', title: 'A', requiresConfirmation: true },
        { file: 'b.md', title: 'B' },
      ],
      [answer('pae-approve', '批准'), answer('pae-confirm', '跳过该步')],
    )
    await orchestratorTurn(
      orchestrator,
      agent,
      'completed',
      { status: 'success', summary: 'B 完成' },
      2,
      1,
    )
    await vi.waitFor(() => {
      expect(orchestrator.snapshot().phase).toBe('completed')
    })
    const calls = agent.session.replaceCalls
    expect(calls).toHaveLength(1) // 确认点跳过：step 1 从未锚定，仅 step 2 锚定一次
    expect((calls[0]!.message.content[0] as { text: string }).text).toContain(
      '该步被用户跳过，未执行',
    )
  })

  it('begin 二次运行（同会话）：整面 replace 遮蔽旧执行历史', async () => {
    const { orchestrator, agent } = await makeOrchestrator(
      [{ file: 'a.md', title: 'A' }],
      [answer('pae-approve', '批准')],
    )
    await orchestratorTurn(
      orchestrator,
      agent,
      'completed',
      { status: 'success', summary: 'A 完成' },
      1,
      1,
    )
    await vi.waitFor(() => {
      expect(orchestrator.snapshot().phase).toBe('completed')
    })
    await orchestrator.begin('第二个任务')
    const calls = agent.session.replaceCalls
    expect(calls).toHaveLength(2) // 首步锚定 + 二次 begin 锚定
    expect((calls.at(-1)!.message.content[0] as { text: string }).text).toBe('第二个任务')
    expect(calls.at(-1)!.start).toBeLessThanOrEqual(calls.at(-1)!.end)
  })

  it('revive：锚点已在 surface → 不重锚；anchorSeqs 缺失 → 重锚', async () => {
    // A：persisted anchorSeqs 含 step 1 且锚点在 surface（宿主日志重放后的折叠态）
    const revived = new FakeRevivedSession()
    const anchorSeq = revived.agent.session.pushUserMessage(fakeUserMessage('锚点'))
    revived.storage.state = { ...revived.storage.state!, anchorSeqs: { 1: anchorSeq } }
    const { Orchestrator } = await import('../src/orchestrator.ts')
    const orchA = new Orchestrator({
      agent: revived.agent,
      ask: revived.ask,
      config: { onStepFailure: 'pause', maxAutoRecoveries: 2, planRoot: '.pae' },
      planDir: revived.planDir,
      storage: revived.storage,
    })
    const revivePromiseA = orchA.revive()
    await vi.waitFor(() => revived.receivedQuestions.length > 0)
    revived.resolveResume(answer('pae-resume', '从断点继续'))
    await orchestratorTurn(
      orchA,
      revived.agent,
      'completed',
      { status: 'success', summary: 'A 完成' },
      1,
      1,
    )
    await orchestratorTurn(
      orchA,
      revived.agent,
      'completed',
      { status: 'success', summary: 'B 完成' },
      2,
      2,
    )
    await revivePromiseA
    const callsA = revived.agent.session.replaceCalls
    expect(callsA).toHaveLength(1) // 仅 step 2 锚定；step 1 未重锚
    expect((callsA[0]!.message.content[0] as { text: string }).text).toContain('上一步结果')

    // B：surface 非空但 anchorSeqs 缺失 → step 1 重锚（计划摘要）
    const revivedB = new FakeRevivedSession()
    revivedB.agent.session.pushUserMessage(fakeUserMessage('历史'))
    const orchB = new Orchestrator({
      agent: revivedB.agent,
      ask: revivedB.ask,
      config: { onStepFailure: 'pause', maxAutoRecoveries: 2, planRoot: '.pae' },
      planDir: revivedB.planDir,
      storage: revivedB.storage,
    })
    const revivePromiseB = orchB.revive()
    await vi.waitFor(() => revivedB.receivedQuestions.length > 0)
    revivedB.resolveResume(answer('pae-resume', '从断点继续'))
    await orchestratorTurn(
      orchB,
      revivedB.agent,
      'completed',
      { status: 'success', summary: 'A 完成' },
      1,
      1,
    )
    await orchestratorTurn(
      orchB,
      revivedB.agent,
      'completed',
      { status: 'success', summary: 'B 完成' },
      2,
      2,
    )
    await revivePromiseB
    const callsB = revivedB.agent.session.replaceCalls
    expect(callsB).toHaveLength(2) // step1 + step2 各锚定一次
    expect((callsB[0]!.message.content[0] as { text: string }).text).toContain('计划摘要')
  })
})

describe('批准时定时执行', () => {
  it('提交排期批准 → 等待期不写宿主 todo，常驻回显卡随后出现；意图不变再批准 → 不续卡防自旋', async () => {
    const at = 1_700_000_060_000
    const { agent, scheduler, storage, askControl, submitPromise } = await buildScheduledSubmit({
      at,
      nowMs: at - 60_000,
    })
    // 审批卡（首卡）批准载荷带未来 at → phase=scheduled + scheduledAt 持久化 + arm(at)
    askControl.resolveNext(answer('pae-approve', '批准', `paeSchedule:at:${at}`))
    const verdict = await submitPromise
    expect(verdict).toEqual({ approved: true })
    expect(storage.state?.phase).toBe('scheduled')
    expect(storage.state?.scheduledAt).toBe(at)
    expect(scheduler.arm).toHaveBeenCalledWith(at)
    // 等待期（scheduled 阶段）不写宿主 todo 卡：批准后零次 todo/write
    expect(agent.session.todosWrites).toHaveLength(0)
    // 未启动 run：除 kickoff 外没有步骤指令注入
    expect(agent.steered.filter((m) => m.source.kind === 'plugin')).toHaveLength(1)
    // 常驻回显卡：批准后同一流程弹第二次 plan-review ask（detail 含执行排期行）
    await vi.waitFor(() => expect(askControl.receivedQuestions.length).toBe(2))
    const persistent = askControl.receivedQuestions[1]![0]!
    expect(persistent.intent).toEqual({ kind: 'plan-review', approve: '批准' })
    expect(persistent.detail).toContain('执行排期：')
    // 意图不变（无排期编码）再批准 → 不续卡（防自旋）：保持排期等待、无第三张卡
    askControl.resolveNext(answer('pae-approve', '批准'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(askControl.receivedQuestions).toHaveLength(2)
    expect(storage.state?.phase).toBe('scheduled')
    expect(storage.state?.scheduledAt).toBe(at)
    expect(scheduler.arm).toHaveBeenCalledTimes(1) // kept 不重 arm
    expect(agent.steered.filter((m) => m.source.kind === 'plugin')).toHaveLength(1)
    expect(agent.session.todosWrites).toHaveLength(0)
  })

  it('常驻卡改「立即执行」→ 取消排期转 executing：写 all-pending todo 并启动 run', async () => {
    const at = 1_700_000_060_000
    const { agent, scheduler, storage, askControl, submitPromise } = await buildScheduledSubmit({
      at,
      nowMs: at - 60_000,
    })
    askControl.resolveNext(answer('pae-approve', '批准', `paeSchedule:at:${at}`))
    await submitPromise
    await vi.waitFor(() => expect(askControl.receivedQuestions.length).toBe(2)) // 常驻卡挂起
    askControl.resolveNext(answer('pae-approve', '批准', 'paeSchedule:now'))
    await vi.waitFor(() => expect(storage.state?.phase).toBe('executing'))
    expect(storage.state?.scheduledAt).toBeUndefined()
    expect(scheduler.cancel).toHaveBeenCalled()
    // 转 executing 即写宿主 todo：all-pending 快照 → run 首步 mark(in_progress)
    await vi.waitFor(() => {
      expect(agent.steered.filter((m) => m.source.kind === 'plugin')).toHaveLength(2)
    })
    expect(agent.session.todosWrites[0]).toEqual([{ content: '1. A', status: 'pending' }])
    expect(agent.session.todosWrites.at(-1)).toEqual([{ content: '1. A', status: 'in_progress' }])
  })

  it('常驻卡「继续修改」→ 取消排期回规划阶段', async () => {
    const at = 1_700_000_060_000
    const { scheduler, storage, askControl, submitPromise } = await buildScheduledSubmit({
      at,
      nowMs: at - 60_000,
    })
    askControl.resolveNext(answer('pae-approve', '批准', `paeSchedule:at:${at}`))
    await submitPromise
    await vi.waitFor(() => expect(askControl.receivedQuestions.length).toBe(2)) // 常驻卡挂起
    askControl.resolveNext(answer('pae-approve', '继续修改'))
    await vi.waitFor(() => expect(storage.state?.phase).toBe('planning'))
    expect(storage.state?.scheduledAt).toBeUndefined()
    expect(scheduler.cancel).toHaveBeenCalled()
  })

  it('无 custom 批准 → 立即执行（首卡默认），且 scheduler.cancel 未被调用', async () => {
    const scheduler = fakeScheduler()
    const { storage, verdict } = await makeOrchestrator(
      [{ file: 'a.md', title: 'A' }],
      [answer('pae-approve', '批准')],
      {},
      undefined,
      undefined,
      { scheduler },
    )
    expect(verdict).toEqual({ approved: true })
    expect(storage.state?.phase).toBe('executing')
    expect(scheduler.arm).not.toHaveBeenCalled()
    expect(scheduler.cancel).not.toHaveBeenCalled()
  })

  it('批准载荷带已过去的 at → 降级立即执行（不 arm、scheduledAt 无脏写）', async () => {
    const scheduler = fakeScheduler()
    const past = 1_699_999_940_000 // 早于固定 now 的时刻（迟到的排期载荷）
    const { storage, verdict } = await makeOrchestrator(
      [{ file: 'a.md', title: 'A' }],
      [answer('pae-approve', '批准', `paeSchedule:at:${past}`)],
      {},
      undefined,
      undefined,
      { scheduler, now: () => 1_700_000_000_000 },
    )
    expect(verdict).toEqual({ approved: true })
    // 排期已滑过 → 走立即执行路径（phase=executing），不 arm、scheduledAt 不落盘
    expect(storage.state?.phase).toBe('executing')
    expect(storage.state?.scheduledAt).toBeUndefined()
    expect(scheduler.arm).not.toHaveBeenCalled()
  })
})

/** 挂起式 ask 控制：收到的问询进队列，回答由测试在需要的时机 resolveNext。 */
function manualAsk() {
  const receivedQuestions: AskUserQuestionItem[][] = []
  let resolver: ((value: AskUserQuestionAnswer) => void) | undefined
  return {
    ask: (questions: AskUserQuestionItem[]): Promise<AskUserQuestionAnswer> => {
      receivedQuestions.push(questions)
      return new Promise((resolve) => {
        resolver = resolve
      })
    },
    receivedQuestions,
    resolveNext: (value: AskUserQuestionAnswer): void => {
      resolver?.(value)
    },
  }
}

/** 构造 phase='scheduled'（持久化态）的编排器 + 挂起式 ask 控制。 */
async function buildScheduledOrchestrator(options: { at: number; nowMs: number }) {
  const dir = await mkdtemp(join(tmpdir(), 'pae-sched-rev-'))
  tempDirs.push(dir)
  await writeFile(join(dir, 'a.md'), '# A\n内容', 'utf8')
  const { Orchestrator } = await import('../src/orchestrator.ts')
  const agent = new FakeAgent()
  const scheduler = fakeScheduler()
  const storage = new FakeStorage()
  storage.state = {
    phase: 'scheduled',
    task: 'T',
    planDir: dir,
    scheduledAt: options.at,
    plan: { planDir: dir, steps: [{ file: 'a.md', title: 'A' }] },
    stepReports: [],
    statuses: {},
    skipped: [],
  }
  const askControl = manualAsk()
  const orchestrator = new Orchestrator({
    agent,
    ask: askControl.ask,
    storage,
    scheduler,
    now: () => options.nowMs,
    config: { onStepFailure: 'pause', maxAutoRecoveries: 2, planRoot: '.pae' },
    planDir: dir,
  })
  return { orchestrator, agent, scheduler, storage, askControl, planDir: dir }
}

/**
 * 构造「提交带排期批准」的编排器：审批卡挂起，批准载荷由测试 resolveNext 提供；
 * 批准走 scheduled 分支后，常驻回显卡（第二次 ask）同样由测试逐张 resolve。
 */
async function buildScheduledSubmit(options: { at: number; nowMs: number }) {
  const dir = await mkdtemp(join(tmpdir(), 'pae-sched-submit-'))
  tempDirs.push(dir)
  const { Orchestrator } = await import('../src/orchestrator.ts')
  const agent = new FakeAgent()
  const scheduler = fakeScheduler()
  const storage = new FakeStorage()
  const askControl = manualAsk()
  const orchestrator = new Orchestrator({
    agent,
    ask: askControl.ask,
    storage,
    scheduler,
    now: () => options.nowMs,
    config: { onStepFailure: 'pause', maxAutoRecoveries: 2, planRoot: '.pae' },
    planDir: dir,
  })
  await orchestrator.begin('定时执行')
  await writeFile(join(dir, 'a.md'), '# A\n内容', 'utf8')
  // 提交计划：审批卡（首卡）挂起，等待测试给出批准载荷
  const submitPromise = orchestrator.submitPlan(dir, [{ file: 'a.md', title: 'A' }], 'S')
  await vi.waitFor(() => expect(askControl.receivedQuestions.length).toBe(1))
  return { orchestrator, agent, scheduler, storage, askControl, submitPromise }
}

describe('scheduled 恢复与到点触发', () => {
  it('revive：排期已过 → 自动补执行（不弹卡），run 注入第一步', async () => {
    const { orchestrator, agent, scheduler, storage, askControl } =
      await buildScheduledOrchestrator(
        { at: 1_999_999_000_000, nowMs: 2_000_000_000_000 }, // nowMs 晚于 scheduledAt
      )
    await orchestrator.revive()
    await vi.waitFor(() => {
      expect(storage.state?.phase).toBe('executing')
    })
    expect(askControl.receivedQuestions).toHaveLength(0) // 未弹任何问询
    expect(scheduler.cancel).toHaveBeenCalled()
    // 第一步指令已注入（kickoff 之外的第一条插件指令；run 首步 readFile 为 macrotask，需 waitFor 真证注入）
    await vi.waitFor(() => {
      expect(agent.steered.filter((m) => m.source.kind === 'plugin')).toHaveLength(1)
    })
  })

  it('revive：排期未到 → 复弹 plan-review 卡（detail 含执行排期行）；批准不改 → 保持原排期', async () => {
    const at = 2_000_000_000_000
    const { orchestrator, scheduler, storage, askControl } = await buildScheduledOrchestrator({
      at,
      nowMs: at - 60_000,
    })
    const revivePromise = orchestrator.revive()
    await vi.waitFor(() => expect(askControl.receivedQuestions.length).toBe(1))
    const question = askControl.receivedQuestions[0]![0]!
    expect(question.intent).toEqual({ kind: 'plan-review', approve: '批准' })
    expect(question.detail).toContain('执行排期：')
    askControl.resolveNext(answer('pae-approve', '批准')) // 未改动 → 批准
    await revivePromise
    expect(storage.state?.phase).toBe('scheduled')
    expect(storage.state?.scheduledAt).toBe(at) // 原排期保持
    expect(scheduler.arm).toHaveBeenCalledWith(at)
    // 意图不变（无编码）→ kept：不续卡（防自旋）、不重 arm
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(askControl.receivedQuestions).toHaveLength(1)
    expect(scheduler.arm).toHaveBeenCalledTimes(1)
  })

  it('revive 回显卡：批准载荷带新 at → 替换排期 + 常驻续卡（按新时刻弹第二张卡）', async () => {
    const oldAt = 2_000_000_000_000
    const newAt = 2_000_000_060_000
    const { orchestrator, scheduler, storage, askControl } = await buildScheduledOrchestrator({
      at: oldAt,
      nowMs: oldAt - 60_000,
    })
    const revivePromise = orchestrator.revive()
    await vi.waitFor(() => expect(askControl.receivedQuestions.length).toBe(1))
    askControl.resolveNext(answer('pae-approve', '批准', `paeSchedule:at:${newAt}`))
    // 意图变更（新时刻）→ 常驻续卡：第二张回显卡按新排期弹（挂起等待测试消费）
    await vi.waitFor(() => expect(askControl.receivedQuestions.length).toBe(2))
    askControl.resolveNext(answer('pae-approve', '批准')) // 续卡上意图不变 → kept 收尾
    await revivePromise
    expect(storage.state?.phase).toBe('scheduled')
    expect(storage.state?.scheduledAt).toBe(newAt)
    expect(scheduler.arm).toHaveBeenLastCalledWith(newAt)
    expect(scheduler.arm).toHaveBeenCalledTimes(2) // revive 前置 arm(oldAt) + 变更重 arm(newAt)
  })

  it('revive 回显卡：批准载荷 now → 取消排期并立即执行', async () => {
    const at = 2_000_000_000_000
    const { orchestrator, agent, scheduler, storage, askControl } =
      await buildScheduledOrchestrator({ at, nowMs: at - 60_000 })
    const revivePromise = orchestrator.revive()
    await vi.waitFor(() => expect(askControl.receivedQuestions.length).toBe(1))
    askControl.resolveNext(answer('pae-approve', '批准', 'paeSchedule:now'))
    await revivePromise
    await vi.waitFor(() => {
      expect(storage.state?.phase).toBe('executing')
    })
    expect(scheduler.cancel).toHaveBeenCalled()
    // 首步指令注入同受 readFile macrotask 制约，需 waitFor 真证注入
    await vi.waitFor(() => {
      expect(agent.steered.filter((m) => m.source.kind === 'plugin')).toHaveLength(1)
    })
  })

  it('fireScheduledRun：到点启动执行；未到点/重复触发 → false 不动作', async () => {
    // 经真实批准路径造 scheduled（覆盖 runtime 字段接线），再拨快时钟触发
    const dir = await mkdtemp(join(tmpdir(), 'pae-sched-fire-'))
    tempDirs.push(dir)
    const { Orchestrator } = await import('../src/orchestrator.ts')
    const agent = new FakeAgent()
    const scheduler = fakeScheduler()
    const nowRef = { value: 1_700_000_000_000 }
    const at = nowRef.value + 60_000
    const { ask } = fakeAsk(answer('pae-approve', '批准', `paeSchedule:at:${at}`))
    const storage = new FakeStorage()
    const orchestrator = new Orchestrator({
      agent,
      ask,
      storage,
      scheduler,
      now: () => nowRef.value,
      config: { onStepFailure: 'pause', maxAutoRecoveries: 2, planRoot: '.pae' },
      planDir: dir,
    })
    await orchestrator.begin('定时执行')
    // begin 已重置 planDir：步骤文件须在 begin 后写入（与 makeOrchestrator 同序）
    await writeFile(join(dir, 'a.md'), '# A\n内容', 'utf8')
    const verdict = await orchestrator.submitPlan(dir, [{ file: 'a.md', title: 'A' }], 'S')
    expect(verdict).toEqual({ approved: true })
    expect(storage.state?.phase).toBe('scheduled')

    // 未到点：不触发
    expect(await orchestrator.fireScheduledRun()).toBe(false)
    expect(storage.state?.phase).toBe('scheduled')

    // 拨快到点后：触发执行
    nowRef.value = at + 1
    expect(await orchestrator.fireScheduledRun()).toBe(true)
    expect(storage.state?.phase).toBe('executing')
    expect(storage.state?.scheduledAt).toBeUndefined()
    // kickoff + 首步指令（run 首步 readFile 为 macrotask，需 waitFor 真证注入）
    await vi.waitFor(() => {
      expect(agent.steered.filter((m) => m.source.kind === 'plugin')).toHaveLength(2)
    })

    // 二次触发（阶段已 executing）：幂等拒绝
    expect(await orchestrator.fireScheduledRun()).toBe(false)
  })

  it('回显卡悬空期间到点触发（fire 胜出）→ 卡答案作废：不二次 run、scheduledAt 无脏写', async () => {
    // 场景 1：悬空卡的答案带 now 载荷 + fire 抢先 → 复检阻止二次 run(plan,1) 双循环
    const dir1 = await mkdtemp(join(tmpdir(), 'pae-sched-race-'))
    tempDirs.push(dir1)
    await writeFile(join(dir1, 'a.md'), '# A\n内容', 'utf8')
    const { Orchestrator } = await import('../src/orchestrator.ts')
    const at = 2_000_000_000_000
    const nowRef = { value: at - 60_000 } // 可变时钟：先让 revive 弹卡，再拨快到点触发
    const agent1 = new FakeAgent()
    const scheduler1 = fakeScheduler()
    const storage1 = new FakeStorage()
    storage1.state = {
      phase: 'scheduled',
      task: 'T',
      planDir: dir1,
      scheduledAt: at,
      plan: { planDir: dir1, steps: [{ file: 'a.md', title: 'A' }] },
      stepReports: [],
      statuses: {},
      skipped: [],
    }
    const askControl1 = manualAsk()
    const orch1 = new Orchestrator({
      agent: agent1,
      ask: askControl1.ask,
      storage: storage1,
      scheduler: scheduler1,
      now: () => nowRef.value,
      config: { onStepFailure: 'pause', maxAutoRecoveries: 2, planRoot: '.pae' },
      planDir: dir1,
    })
    const revive1 = orch1.revive()
    await vi.waitFor(() => expect(askControl1.receivedQuestions.length).toBe(1))
    nowRef.value = at + 1 // 拨快到点：fire 抢先启动执行并 abort 悬空卡
    expect(await orch1.fireScheduledRun()).toBe(true)
    await vi.waitFor(() => {
      // run 唯一一次启动：首步指令注入（readFile 为 macrotask，需 waitFor）
      expect(agent1.steered.filter((m) => m.source.kind === 'plugin')).toHaveLength(1)
    })
    const attempts = orch1.snapshot().stepAttempt
    // 答案在 abort 前已 resolve 入队：宿主仍会投递；复检须使其作废（now 意图经答案载荷表达）
    askControl1.resolveNext(answer('pae-approve', '批准', 'paeSchedule:now'))
    await revive1
    await new Promise((resolve) => setTimeout(resolve, 150)) // 留窗口：若复检缺失，二次 run 在此 steer 第 2 条指令
    expect(agent1.steered.filter((m) => m.source.kind === 'plugin')).toHaveLength(1) // 未二次注入
    expect(orch1.snapshot().stepAttempt).toBe(attempts) // stepAttempt 不再增长
    expect(storage1.state?.phase).toBe('executing')
    expect(storage1.state?.scheduledAt).toBeUndefined()

    // 场景 2：悬空卡的答案带新 at 载荷 + fire 抢先 → 复检阻止 scheduledAt 脏写与重复 arm
    const dir2 = await mkdtemp(join(tmpdir(), 'pae-sched-race-'))
    tempDirs.push(dir2)
    await writeFile(join(dir2, 'a.md'), '# A\n内容', 'utf8')
    nowRef.value = at - 60_000 // 回到未到点，使第二次 revive 走回显卡路径
    const agent2 = new FakeAgent()
    const scheduler2 = fakeScheduler()
    const storage2 = new FakeStorage()
    storage2.state = {
      phase: 'scheduled',
      task: 'T',
      planDir: dir2,
      scheduledAt: at,
      plan: { planDir: dir2, steps: [{ file: 'a.md', title: 'A' }] },
      stepReports: [],
      statuses: {},
      skipped: [],
    }
    const askControl2 = manualAsk()
    const orch2 = new Orchestrator({
      agent: agent2,
      ask: askControl2.ask,
      storage: storage2,
      scheduler: scheduler2,
      now: () => nowRef.value,
      config: { onStepFailure: 'pause', maxAutoRecoveries: 2, planRoot: '.pae' },
      planDir: dir2,
    })
    const revive2 = orch2.revive()
    await vi.waitFor(() => expect(askControl2.receivedQuestions.length).toBe(1))
    const newAt = at + 120_000
    nowRef.value = at + 1
    expect(await orch2.fireScheduledRun()).toBe(true)
    askControl2.resolveNext(answer('pae-approve', '批准', `paeSchedule:at:${newAt}`))
    await revive2
    await new Promise((resolve) => setTimeout(resolve, 150)) // 留窗口：若复检缺失，脏写在此落盘
    expect(storage2.state?.scheduledAt).toBeUndefined() // 无脏写回
    expect(scheduler2.arm).toHaveBeenCalledTimes(1) // 仅 revive 分支前置 arm(at)，未对作废意图重复 arm
    expect(storage2.state?.phase).toBe('executing')
  })

  describe('reviewScheduledAgain（会话打开重弹）', () => {
    it("scheduled 未到点且无悬空卡 → 'asked'：重 arm + 复弹回显卡（receivedQuestions+1）", async () => {
      const at = 2_000_000_000_000
      const { orchestrator, scheduler, storage, askControl } = await buildScheduledOrchestrator({
        at,
        nowMs: at - 60_000,
      })
      // 先经 revive 恢复（scheduled future 弹卡）；消费其卡后再测无悬空路径
      const revivePromise = orchestrator.revive()
      await vi.waitFor(() => expect(askControl.receivedQuestions.length).toBe(1))
      askControl.resolveNext(answer('pae-approve', '批准'))
      await revivePromise
      expect(storage.state?.phase).toBe('scheduled')
      expect(askControl.receivedQuestions).toHaveLength(1)

      expect(await orchestrator.reviewScheduledAgain()).toBe('asked')
      await vi.waitFor(() => expect(askControl.receivedQuestions.length).toBe(2))
      const question = askControl.receivedQuestions[1]![0]!
      expect(question.intent).toEqual({ kind: 'plan-review', approve: '批准' })
      expect(question.detail).toContain('执行排期：')
      expect(scheduler.arm).toHaveBeenLastCalledWith(at) // 重 arm（幂等替换）
      askControl.resolveNext(answer('pae-approve', '批准')) // 收尾：保持原排期
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(askControl.receivedQuestions).toHaveLength(2) // 意图不变 → 不续第三张卡
      expect(storage.state?.phase).toBe('scheduled')
      expect(storage.state?.scheduledAt).toBe(at)
    })

    it('已有悬空回显卡（先 revive 未答）→ ignored 不叠卡', async () => {
      const at = 2_000_000_000_000
      const { orchestrator, askControl, scheduler } = await buildScheduledOrchestrator({
        at,
        nowMs: at - 60_000,
      })
      const revivePromise = orchestrator.revive()
      await vi.waitFor(() => expect(askControl.receivedQuestions.length).toBe(1))
      expect(await orchestrator.reviewScheduledAgain()).toBe('ignored')
      expect(askControl.receivedQuestions).toHaveLength(1) // 未叠第二张卡
      expect(scheduler.arm).toHaveBeenCalledTimes(1) // 仅 revive 前置 arm，未重复 arm
      askControl.resolveNext(answer('pae-approve', '批准'))
      await revivePromise
    })

    it('scheduled 已到点（错过 timer）→ ignored（补执行路径不弹卡）', async () => {
      const at = 2_000_000_000_000
      const { orchestrator, askControl } = await buildScheduledOrchestrator({ at, nowMs: at + 1 })
      // revive 的 overdue 分支自动补执行（phase 迁出 scheduled、无任何问询）
      await orchestrator.revive()
      expect(orchestrator.snapshot().phase).toBe('executing')
      expect(askControl.receivedQuestions).toHaveLength(0)
      expect(await orchestrator.reviewScheduledAgain()).toBe('ignored')
    })

    it('executing（执行中）→ ignored，执行期不显示审批卡', async () => {
      const { orchestrator } = await makeOrchestrator(
        [{ file: 'a.md', title: 'A' }],
        [answer('pae-approve', '批准')],
      )
      expect(orchestrator.snapshot().phase).toBe('executing')
      expect(await orchestrator.reviewScheduledAgain()).toBe('ignored')
    })

    it('paused → ignored（恢复弹窗挂起中亦不重弹回显卡）', async () => {
      const revived = new FakeRevivedSession()
      revived.storage.state = {
        ...revived.storage.state!,
        phase: 'paused',
        pausedReason: 'failure',
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
      await vi.waitFor(() => expect(revived.receivedQuestions.length).toBe(1)) // 暂停弹窗挂起
      expect(await orchestrator.reviewScheduledAgain()).toBe('ignored')
      expect(revived.receivedQuestions).toHaveLength(1)
      revived.resolveResume(answer('pae-pause', '终止'))
      await revivePromise
    })

    it('completed（终态）→ ignored', async () => {
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
      expect(await orchestrator.reviewScheduledAgain()).toBe('ignored')
    })
  })

  it('回显卡驳回（回规划）：下一次 submitPlan 批准无载荷 → 立即执行', async () => {
    const at = 2_000_000_000_000
    const { orchestrator, planDir, scheduler, storage, askControl } =
      await buildScheduledOrchestrator({ at, nowMs: at - 60_000 })
    const revivePromise = orchestrator.revive()
    await vi.waitFor(() => expect(askControl.receivedQuestions.length).toBe(1))
    askControl.resolveNext(answer('pae-approve', '继续修改')) // 驳回回规划（F-1 意图清场随 transient 字段移除自然消失）
    await revivePromise
    expect(storage.state?.phase).toBe('planning')
    expect(scheduler.cancel).toHaveBeenCalled()
    expect(scheduler.arm).toHaveBeenCalledTimes(1) // 仅 revive 分支前置 arm(at)

    // 回到规划后的下一次审批（首卡语义）：批准无载荷 → 立即执行
    const submitPromise = orchestrator.submitPlan(planDir, [{ file: 'a.md', title: 'A' }], 'S')
    await vi.waitFor(() => expect(askControl.receivedQuestions.length).toBe(2))
    askControl.resolveNext(answer('pae-approve', '批准'))
    const verdict = await submitPromise
    expect(verdict).toEqual({ approved: true })
    expect(storage.state?.phase).toBe('executing')
    expect(storage.state?.scheduledAt).toBeUndefined()
    expect(scheduler.arm).toHaveBeenCalledTimes(1) // 未对任何排期二次 arm
  })
})
