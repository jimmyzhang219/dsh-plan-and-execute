import { mkdtempSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type { DriveAgent, DriveSession, Orchestrator, PaeEventType } from '../src/orchestrator.ts'

export const tempDirs: string[] = []

export async function cleanupTempDirs(): Promise<void> {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
}

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
 * scriptTurn 投递——与真实 whenIdle 的"等待 agent 完成"语义对齐。
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
    return new Promise((resolve) => {
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
      if (report) {
        s.append('pae/step-report', { stepIndex, outcome: report.outcome, summary: report.summary })
      }
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

export const answer = (id: string, selected: string, custom?: string): AskUserQuestionAnswer => ({
  answers: [{ id, selected: [selected], custom }],
})

export type StepSeed = { file: string; title: string; requiresConfirmation?: boolean }

/** 通用构造器：真实临时 planDir（写入步骤文件）；全部 ask 回答由调用方脚本化。 */
export async function makeOrchestrator(
  steps: StepSeed[],
  askScript: Array<AskUserQuestionAnswer | Error>,
  overrides: { onStepFailure?: 'pause' | 'auto-recover'; maxAutoRecoveries?: number } = {},
  hooks?: ConstructorParameters<typeof Orchestrator>[0]['hooks'],
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
    ...(hooks === undefined ? {} : { hooks }),
  })
  orchestrator.begin('示例任务')
  const verdict = await orchestrator.submitPlan(steps, '测试计划')
  return { orchestrator, agent, ask, received, verdict, steps, planDir }
}

/** 带"重启后"历史事件（plan + executing）的可控假件：ask 由测试手动 resolve。 */
export class FakeRevivedSession {
  readonly agent = new FakeAgent()
  readonly planDir: string
  receivedQuestions: AskUserQuestionItem[][] = []
  private resolver: ((value: AskUserQuestionAnswer) => void) | undefined

  constructor() {
    this.planDir = mkdtempSync(join(tmpdir(), 'pae-revive-'))
    tempDirs.push(this.planDir)
    for (const file of ['a.md', 'b.md'])
      writeFileSync(join(this.planDir, file), '# step\n内容', 'utf8')
    const s = this.agent.session as FakeSession
    s.append('pae/plan', {
      planDir: this.planDir,
      steps: [
        { file: 'a.md', title: 'A' },
        { file: 'b.md', title: 'B' },
      ],
    })
    s.append('pae/state', { phase: 'executing', stepIndex: 1, planDir: this.planDir, task: 'T' })
  }

  readonly ask = async (questions: AskUserQuestionItem[]): Promise<AskUserQuestionAnswer> => {
    this.receivedQuestions.push(questions)
    return new Promise((resolve) => {
      this.resolver = resolve
    })
  }

  resolveResume(value: AskUserQuestionAnswer): void {
    this.resolver?.(value)
  }
}
