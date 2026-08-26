/**
 * plan-and-execute 的编排状态词汇与工具函数。
 *
 * 注意：dsh 的会话事件白名单（KNOWN_SESSION_EVENT_TYPES）不接受外部插件的
 * 自定义事件类型，因此编排控制流状态不写入会话日志，而是持久化在
 * planDir/orchestrator.json（见 persist.ts）；会话日志只记录标准事件
 * （todo/write、turn/* 等）。
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

export interface PaeStepReportPayload {
  readonly stepIndex: number
  readonly outcome: 'done' | 'blocked'
  readonly summary: string
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
