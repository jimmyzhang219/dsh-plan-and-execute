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
