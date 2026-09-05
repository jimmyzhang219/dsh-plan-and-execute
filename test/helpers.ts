import { mkdtempSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserMessage, type ImageBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { vi } from 'vitest'
import type { DriveAgent, DriveSession, DriveSurface, Orchestrator } from '../src/orchestrator.ts'
import type { PersistedOrchestratorState, PersistedStorage } from '../src/persist.ts'

export const tempDirs: string[] = []

/** 构造最小插件消息（surface 锚定/注入测试用）。 */
export function fakeUserMessage(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin: 'dsh-plan-and-execute',
      form: 'instructions',
      summary: text.slice(0, 40),
    },
  })
}

/** 构造测试用耐久图块（宿主准入后的 ImageBlock 形状；测试内无需真附件，品牌字段双断言放宽）。 */
export function fakeImageBlock(id = 'att-1'): ImageBlock {
  return {
    type: 'image',
    attachment: {
      attachmentId: id,
      mediaType: 'image/png',
      bytes: 1234,
      width: 640,
      height: 480,
    },
  } as unknown as ImageBlock
}

export async function cleanupTempDirs(): Promise<void> {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
}

/** 假 Session：标准事件日志（turn/*）+ todo/write 收集 + 最小 surface 折叠模型。 */
export class FakeSession implements DriveSession {
  readonly events: SessionEvent[] = []
  todosWrites: TodoItem[][] = []
  /** surface 节点（模型可见消息的事件 seq，模拟宿主折叠视图）。 */
  readonly nodes: number[] = []
  /** replace 提交计数（宿主 replaceGeneration 语义）。 */
  replaceGeneration = 0
  /** replaceSurface 调用记录（测试断言锚定次数/内容）。 */
  replaceCalls: Array<{
    message: UserMessage
    start: number
    end: number
    sourceEventSeqs: number[]
  }> = []
  private seq = 0

  append(eventType: 'turn/start' | 'turn/end', data: object): void {
    this.seq += 1
    this.events.push({ seq: this.seq, type: eventType, data } as SessionEvent)
  }

  /** 模拟宿主把一条 user/message append 进会话与 surface（steer 展开的简化）。 */
  pushUserMessage(message: UserMessage): number {
    this.seq += 1
    this.events.push({ seq: this.seq, type: 'user/message', data: message } as SessionEvent)
    this.nodes.push(this.seq)
    return this.seq
  }

  /** 折叠视图（DriveSurface 形状）。 */
  get surface(): DriveSurface {
    return { nodes: this.nodes, replaceGeneration: this.replaceGeneration }
  }

  writeTodos(todos: readonly TodoItem[]): void {
    this.todosWrites.push([...todos])
  }

  /** replace surfaceOp：遮蔽 [start..end] 节点区间并记录调用（start/end 不在 surface 上抛错）。 */
  replaceSurface(
    message: UserMessage,
    start: number,
    end: number,
    sourceEventSeqs: number[],
  ): number {
    this.seq += 1
    this.events.push({ seq: this.seq, type: 'user/message', data: message } as SessionEvent)
    const startIdx = this.nodes.indexOf(start)
    const endIdx = this.nodes.indexOf(end)
    if (startIdx === -1 || endIdx === -1) {
      throw new Error(`fake replaceSurface: 节点 ${start}..${end} 不在 surface 上`)
    }
    this.nodes.splice(startIdx, endIdx - startIdx + 1, this.seq)
    this.replaceGeneration += 1
    this.replaceCalls.push({ message, start, end, sourceEventSeqs })
    return this.seq
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
    this.session.pushUserMessage(message) // 模拟宿主把 steer 消息 append 进 surface
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

/** 假定时执行器（Orchestrator 依赖 RunScheduler 的测试注入件；arm/cancel 调用可断言）。 */
export interface FakeScheduler {
  /** 注册/替换到点执行的 mock。 */
  arm: ReturnType<typeof vi.fn<(at: number) => void>>
  /** 撤销到点执行的 mock。 */
  cancel: ReturnType<typeof vi.fn<() => void>>
}

/** 构造假定时执行器（配合 makeOrchestrator 第 6 参 runtime.scheduler 注入）。 */
export function fakeScheduler(): FakeScheduler {
  return { arm: vi.fn<(at: number) => void>(), cancel: vi.fn<() => void>() }
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
  runtime: { scheduler?: FakeScheduler; now?: () => number } = {},
  images?: readonly ImageBlock[],
) {
  const planDir = await mkdtemp(join(tmpdir(), 'pae-orch-'))
  tempDirs.push(planDir)
  const { Orchestrator } = await import('../src/orchestrator.ts')
  const agent = new FakeAgent()
  const { ask, received } = fakeAsk(...askScript)
  const scheduler = runtime.scheduler ?? fakeScheduler()
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
    ...(runtime.scheduler === undefined ? {} : { scheduler }),
    ...(runtime.now === undefined ? {} : { now: runtime.now }),
  })
  await orchestrator.begin('示例任务', images) // begin 清空目录（真实语义），之后模型写步骤文件
  for (const step of steps) {
    await writeFile(join(planDir, step.file), `# ${step.title}\n内容`, 'utf8')
  }
  const verdict = await orchestrator.submitPlan(planDir, steps, '测试计划')
  return { orchestrator, agent, ask, received, verdict, steps, planDir, storage, scheduler }
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
