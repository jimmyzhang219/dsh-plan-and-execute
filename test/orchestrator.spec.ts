import { mkdtempSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type { DriveAgent, DriveSession, PaeEventType } from '../src/orchestrator.ts'

/** 假 Session：内存事件数组。 */
export class FakeSession implements DriveSession {
  readonly events: SessionEvent[] = []
  private seq = 0
  append(eventType: PaeEventType | 'turn/start' | 'turn/end', data: object): void {
    this.seq += 1
    this.events.push({ seq: this.seq, type: eventType, data } as SessionEvent)
  }
}

/**
 * 假 Agent：whenIdle 在队列有脚本时执行一个回合，无脚本时挂起等待
 * scriptTurn 投递——与真实 whenIdle 的"等待 agent 完成"语义对齐，避免
 * 测试里 run 循环在脚本投递前空转。
 */
export class FakeAgent implements DriveAgent {
  readonly session = new FakeSession()
  steered: UserMessage[] = []
  private queue: Array<() => void> = []
  private waiter: (() => void) | undefined

  steer(message: UserMessage): void {
    this.steered.push(message)
  }

  whenIdle(): Promise<void> {
    const next = this.queue.shift()
    if (next !== undefined) {
      next()
      return Promise.resolve()
    }
    return new Promise(resolve => {
      this.waiter = resolve
    })
  }

  /** 预置：下一次 whenIdle 完成一个 turn，可带 report。 */
  scriptTurn(
    reason: string,
    report?: { outcome: 'done' | 'blocked'; summary: string },
    stepIndex = 1,
  ): void {
    this.queue.push(() => {
      const s = this.session as FakeSession
      s.append('turn/start', { turn: 1 })
      if (report) s.append('pae/step-report', { stepIndex, outcome: report.outcome, summary: report.summary })
      s.append('turn/end', { turn: 1, reason: { kind: reason } })
    })
    this.waiter?.()
    this.waiter = undefined
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

export const answer = (
  id: string,
  selected: string,
  custom?: string,
): AskUserQuestionAnswer => ({ answers: [{ id, selected: [selected], custom }] })

const planDir = '/tmp/pae-test-plan'

const tempDirs: string[] = []
afterAll(async () => {
  await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })))
})

/** 通用构造器：真实临时 planDir（写入步骤文件）；全部 ask 回答由调用方脚本化。 */
export async function makeOrchestrator(
  steps: Array<{ file: string; title: string; requiresConfirmation?: boolean }>,
  askScript: Array<AskUserQuestionAnswer | Error>,
  overrides: { onStepFailure?: 'pause' | 'auto-recover'; maxAutoRecoveries?: number } = {},
) {
  const planDir = await mkdtemp(join(tmpdir(), 'pae-orch-'))
  tempDirs.push(planDir)
  for (const step of steps) {
    await writeFile(join(planDir, step.file), `# ${step.title}\n内容`, 'utf8')
  }
  const { Orchestrator } = await import('../src/orchestrator.ts')
  const agent = new FakeAgent()
  const { ask, received } = fakeAsk(...askScript)
  const orchestrator = new Orchestrator({
    agent,
    ask,
    config: {
      onStepFailure: overrides.onStepFailure ?? 'pause',
      maxAutoRecoveries: overrides.maxAutoRecoveries ?? 2,
      planRoot: '.pae',
    },
    planDir,
  })
  orchestrator.begin('示例任务')
  const verdict = await orchestrator.submitPlan(steps, '测试计划')
  return { orchestrator, agent, ask, received, verdict, steps, planDir }
}

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
    const state = agent.session.events.find(e => e.type === 'pae/state')
    expect(state?.data).toMatchObject({ phase: 'planning', task: '做某事', planDir })
  })

  it('submitPlan 批准：落 pae/plan + executing + todo 全 pending，逐步执行到完成', async () => {
    const steps = [
      { file: 'a.md', title: 'A' },
      { file: 'b.md', title: 'B' },
    ]
    const { agent, verdict } = await makeOrchestrator(steps, [answer('pae-approve', '批准')])
    expect(verdict).toEqual({ approved: true })
    agent.scriptTurn('completed', { outcome: 'done', summary: '完成 A' }, 1)
    agent.scriptTurn('completed', { outcome: 'done', summary: '完成 B' }, 2)
    await vi.waitFor(() => {
      const last = [...agent.session.events].reverse().find(e => e.type === 'pae/state')
      expect(last?.data).toMatchObject({ phase: 'completed' })
    })
    const todos = [...agent.session.events].reverse().find(e => e.type === 'todo/write')
    expect(todos?.data).toMatchObject({
      todos: [
        { content: '1. A', status: 'completed' },
        { content: '2. B', status: 'completed' },
      ],
    })
    // kickoff + 两条步骤指令
    expect(agent.steered.filter(m => m.source.kind === 'plugin')).toHaveLength(3)
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
      const last = [...agent.session.events].reverse().find(e => e.type === 'pae/state')
      expect(last?.data).toMatchObject({ phase: 'completed' })
    })
    const texts = agent.steered.map(m => (m.content[0] as { text: string }).text)
    expect(texts.some(t => t.includes('report_step'))).toBe(true)
  })
})

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

  it('追问后仍不汇报 → 按失败暂停；选终止 → aborted', async () => {
    const { agent } = await makeOrchestrator(
      [{ file: 'a.md', title: 'A' }],
      [answer('pae-approve', '批准'), answer('pae-pause', '终止')],
    )
    agent.scriptTurn('completed', undefined)
    agent.scriptTurn('completed', undefined) // 追问后仍无 report
    await vi.waitFor(() => {
      const state = [...agent.session.events].reverse().find(e => e.type === 'pae/state')
      expect(state?.data).toMatchObject({ phase: 'aborted' })
    })
    // 事件序列中曾出现 paused(failure)（ask 脚本化无延迟，随即被 aborted 覆盖）
    const paused = agent.session.events.find(
      e => e.type === 'pae/state' && e.data.phase === 'paused',
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
      const state = [...agent.session.events].reverse().find(e => e.type === 'pae/state')
      expect(state?.data).toMatchObject({ phase: 'aborted' })
    })
    const paused = agent.session.events.find(
      e => e.type === 'pae/state' && e.data.phase === 'paused',
    )
    expect(paused?.data).toMatchObject({ pausedReason: 'failure' })
    const texts = agent.steered.map(m => (m.content[0] as { text: string }).text)
    expect(texts.filter(t => t.includes('自行调整')).length).toBe(1) // 恰好一次自愈指令
  })

  it('跳过 → todo 保持 pending，终局标注 skipped', async () => {
    const { agent, received } = await makeOrchestrator(
      [{ file: 'a.md', title: 'A' }, { file: 'b.md', title: 'B' }],
      [answer('pae-approve', '批准'), answer('pae-pause', '跳过该步')],
    )
    agent.scriptTurn('completed', { outcome: 'blocked', summary: '卡住' }, 1)
    agent.scriptTurn('completed', { outcome: 'done', summary: 'B 完成' }, 2)
    await vi.waitFor(() => {
      const state = [...agent.session.events].reverse().find(e => e.type === 'pae/state')
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
      const state = [...agent.session.events].reverse().find(e => e.type === 'pae/state')
      expect(state?.data).toMatchObject({ phase: 'completed' })
    })
    expect(received[1]?.[0]?.id).toBe('pae-confirm')
    const pausedEvent = agent.session.events.find(
      e => e.type === 'pae/state'
        && (e.data as { pausedReason?: string }).pausedReason === 'confirm-point',
    )
    expect(pausedEvent).toBeDefined()
  })

  it('确认点选跳过 → 该步不执行、终局 skipped', async () => {
    const { agent, received } = await makeOrchestrator(
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
      const state = [...agent.session.events].reverse().find(e => e.type === 'pae/state')
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
    const state = [...revived.agent.session.events].reverse().find(e => e.type === 'pae/state')
    expect(state?.data).toMatchObject({ phase: 'completed' })
  })
})

/** 带"重启后"历史事件（plan + executing）的可控假件：ask 由测试手动 resolve。 */
class FakeRevivedSession {
  readonly agent = new FakeAgent()
  readonly planDir: string
  receivedQuestions: AskUserQuestionItem[][] = []
  private resolver: ((value: AskUserQuestionAnswer) => void) | undefined

  constructor() {
    this.planDir = mkdtempSync(join(tmpdir(), 'pae-revive-'))
    tempDirs.push(this.planDir)
    for (const file of ['a.md', 'b.md']) writeFileSync(join(this.planDir, file), '# step\n内容', 'utf8')
    const s = this.agent.session as FakeSession
    s.append('pae/plan', {
      planDir: this.planDir,
      steps: [{ file: 'a.md', title: 'A' }, { file: 'b.md', title: 'B' }],
    })
    s.append('pae/state', { phase: 'executing', stepIndex: 1, planDir: this.planDir, task: 'T' })
  }

  readonly ask = async (questions: AskUserQuestionItem[]): Promise<AskUserQuestionAnswer> => {
    this.receivedQuestions.push(questions)
    return new Promise(resolve => {
      this.resolver = resolve
    })
  }

  resolveResume(value: AskUserQuestionAnswer): void {
    this.resolver?.(value)
  }
}
