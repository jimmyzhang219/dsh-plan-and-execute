import { mkdtempSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type { DriveAgent, DriveSession, Orchestrator } from '../src/orchestrator.ts'
import type { PersistedOrchestratorState, PersistedStorage } from '../src/persist.ts'

export const tempDirs: string[] = []

export async function cleanupTempDirs(): Promise<void> {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
}

/** 假 Session：标准事件日志（turn/*）+ todo/write 收集；pae/* 事件不再写入。 */
export class FakeSession implements DriveSession {
  readonly events: SessionEvent[] = []
  todosWrites: TodoItem[][] = []
  private seq = 0

  append(eventType: 'turn/start' | 'turn/end', data: object): void {
    this.seq += 1
    this.events.push({ seq: this.seq, type: eventType, data } as SessionEvent)
  }

  writeTodos(todos: readonly TodoItem[]): void {
    this.todosWrites.push([...todos])
  }
}

/**
 * 假 Agent：whenIdle 挂起等待 scriptTurn，scriptTurn 排队；无论先到哪个，
 * 事件都先落地再唤醒挂起的 whenIdle——等价于"turn 完成 → agent idle"，
 * 且 settle 的日志切片总能看到完整 turn 事件。
 */
export class FakeAgent implements DriveAgent {
  readonly session = new FakeSession()
  steered: UserMessage[] = []
  private waiter: (() => void) | undefined
  private pendingTurns: string[] = []

  steer(message: UserMessage): void {
    this.steered.push(message)
  }

  whenIdle(): Promise<void> {
    return new Promise((resolve) => {
      this.waiter = resolve
      this.drain()
    })
  }

  /** 完成一个 turn（可先于 whenIdle 调用，排空语义保证事件落地与唤醒有序）。 */
  scriptTurn(reason: string): void {
    this.pendingTurns.push(reason)
    this.drain()
  }

  private drain(): void {
    if (this.waiter === undefined || this.pendingTurns.length === 0) return
    const reason = this.pendingTurns.shift()!
    const s = this.session as FakeSession
    s.append('turn/start', { turn: 1 })
    s.append('turn/end', { turn: 1, reason: { kind: reason } })
    const resolve = this.waiter
    this.waiter = undefined
    resolve()
  }
}

/** 假持久化：内存快照（真实实现为 planDir/orchestrator.json）。 */
export class FakeStorage implements PersistedStorage {
  state: PersistedOrchestratorState | undefined
  async load(): Promise<PersistedOrchestratorState | undefined> {
    return this.state
  }
  async save(state: PersistedOrchestratorState): Promise<void> {
    this.state = state
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
  storage = new FakeStorage(),
) {
  const planDir = await mkdtemp(join(tmpdir(), 'pae-orch-'))
  tempDirs.push(planDir)
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
    storage,
    ...(hooks === undefined ? {} : { hooks }),
  })
  await orchestrator.begin('示例任务') // begin 清空目录（真实语义），之后模型写步骤文件
  for (const step of steps) {
    await writeFile(join(planDir, step.file), `# ${step.title}\n内容`, 'utf8')
  }
  const verdict = await orchestrator.submitPlan(planDir, steps, '测试计划')
  return { orchestrator, agent, ask, received, verdict, steps, planDir, storage }
}

/** 带"重启后"持久化状态（executing + plan）的可控假件：ask 由测试手动 resolve。 */
export class FakeRevivedSession {
  readonly agent = new FakeAgent()
  readonly planDir: string
  readonly storage = new FakeStorage()
  receivedQuestions: AskUserQuestionItem[][] = []
  private resolver: ((value: AskUserQuestionAnswer) => void) | undefined

  constructor() {
    this.planDir = mkdtempSync(join(tmpdir(), 'pae-revive-'))
    tempDirs.push(this.planDir)
    for (const file of ['a.md', 'b.md']) {
      writeFileSync(join(this.planDir, file), '# step\n内容', 'utf8')
    }
    this.storage.state = {
      phase: 'executing',
      stepIndex: 1,
      task: 'T',
      planDir: this.planDir,
      plan: {
        planDir: this.planDir,
        steps: [
          { file: 'a.md', title: 'A' },
          { file: 'b.md', title: 'B' },
        ],
      },
      stepReports: [],
      statuses: {},
      skipped: [],
    }
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
