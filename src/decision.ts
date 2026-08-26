/**
 * 步骤结局分类与失败策略决策。纯函数。
 * @module plan-and-execute/decision
 */
import type { PaePausedReason, PaeStepReportPayload } from './state.ts'

export type StepOutcome = 'done' | 'blocked' | 'failed' | 'aborted' | 'missing-report'

/**
 * 分类本步结局。turn/end 原因自会话日志（标准事件），report 自编排内存态
 * （pae/step-report 不写日志，freshReport 由编排器按注入水位线判定）。
 * 优先级：turn 结束原因 > 本步 report > 缺报。
 */
export function classifyOutcome(
  turnEndKind: string | undefined,
  freshReport: PaeStepReportPayload | undefined,
): StepOutcome {
  if (turnEndKind === 'aborted') return 'aborted'
  if (turnEndKind === 'error' || turnEndKind === 'max-tokens' || turnEndKind === 'interrupted') {
    return 'failed'
  }
  if (freshReport !== undefined) return freshReport.outcome === 'done' ? 'done' : 'blocked'
  return 'missing-report'
}

export type StepAction =
  | { kind: 'advance' }
  | { kind: 'nudge' }
  | { kind: 'recover' }
  | { kind: 'pause'; reason: Extract<PaePausedReason, 'failure' | 'cancelled'> }

export interface FailurePolicy {
  readonly onStepFailure: 'pause' | 'auto-recover'
  readonly maxAutoRecoveries: number
}

export function decideAction(
  outcome: StepOutcome,
  context: {
    nudged: boolean
    recoveries: number
    policy: FailurePolicy
  },
): StepAction {
  switch (outcome) {
    case 'done':
      return { kind: 'advance' }
    case 'aborted':
      return { kind: 'pause', reason: 'cancelled' }
    case 'missing-report':
      return context.nudged ? failureAction(context) : { kind: 'nudge' }
    case 'blocked':
    case 'failed':
      return failureAction(context)
  }
}

function failureAction(context: { recoveries: number; policy: FailurePolicy }): StepAction {
  const { onStepFailure, maxAutoRecoveries } = context.policy
  if (onStepFailure === 'auto-recover' && context.recoveries < maxAutoRecoveries) {
    return { kind: 'recover' }
  }
  return { kind: 'pause', reason: 'failure' }
}
