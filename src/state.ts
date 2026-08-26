/**
 * plan-and-execute 的持久化事件词汇与折叠函数。纯函数，无运行时依赖。
 * @module plan-and-execute/state
 */
import type { SessionEvent, TodoItem } from '@deepseek-ai/dsh-session'

export const PAE_PLUGIN = 'plan-and-execute'

export type PaePhase = 'planning' | 'executing' | 'paused' | 'completed' | 'aborted'
export type PaePausedReason = 'confirm-point' | 'failure' | 'cancelled'

/** manifest 的单步描述（控制流；内容在步骤 md 文件里）。 */
export interface PlanStep {
  readonly file: string
  readonly title: string
  readonly requiresConfirmation?: boolean
}

export interface PaePlanPayload {
  readonly planDir: string
  readonly summary?: string
  readonly steps: readonly PlanStep[]
}

export interface PaeStatePayload {
  readonly phase: PaePhase
  readonly task?: string
  readonly planDir?: string
  /** 1-based，当前正在执行/暂停的步骤；批准后未开始时为 0。 */
  readonly stepIndex?: number
  readonly pausedReason?: PaePausedReason
}

export interface PaeStepReportPayload {
  readonly stepIndex: number
  readonly outcome: 'done' | 'blocked'
  readonly summary: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** 整值替换，last-wins；见规格 §7.1。 */
    'pae/state': PaeStatePayload
    /** 每次审批通过追加一条；折叠取最后。 */
    'pae/plan': PaePlanPayload
    'pae/step-report': PaeStepReportPayload
  }
}

export interface PaeFoldedState {
  readonly phase: PaePhase | 'none'
  readonly task?: string
  readonly planDir?: string
  readonly stepIndex?: number
  readonly pausedReason?: PaePausedReason
}

export function foldPae(events: readonly SessionEvent[], end = events.length): PaeFoldedState {
  let state: PaeFoldedState = { phase: 'none' }
  let index = 0
  for (const event of events) {
    if (index >= end) break
    index++
    if (event.type === 'pae/state') state = event.data
  }
  return state
}

export function foldPaePlan(events: readonly SessionEvent[]): PaePlanPayload | undefined {
  let plan: PaePlanPayload | undefined
  for (const event of events) {
    if (event.type === 'pae/plan') plan = event.data
  }
  return plan
}

export function foldStepReports(events: readonly SessionEvent[]): Map<number, PaeStepReportPayload> {
  const reports = new Map<number, PaeStepReportPayload>()
  for (const event of events) {
    if (event.type === 'pae/step-report') reports.set(event.data.stepIndex, event.data)
  }
  return reports
}

/** 构造 `todo/write` 整表快照；statuses 缺省为 pending（1-based）。 */
export function buildTodoPayload(
  steps: readonly PlanStep[],
  statuses: ReadonlyMap<number, TodoItem['status']>,
): { todos: TodoItem[] } {
  return {
    todos: steps.map((step, index) => ({
      content: `${index + 1}. ${step.title}`,
      status: statuses.get(index + 1) ?? 'pending',
    })),
  }
}

/**
 * 宿主 plan-mode 是否激活。不依赖 dsh-plan-mode 包类型：事件类型不在本工程
 * 编译单元的 SessionEventMap 联合里，读 data 需要一次断言（唯一一处）。
 */
export function isPlanModeActive(events: readonly SessionEvent[]): boolean {
  let active = false
  for (const event of events) {
    if ((event.type as string) === 'plan/mode') {
      active = (event.data as unknown as { active: boolean }).active
    }
  }
  return active
}
