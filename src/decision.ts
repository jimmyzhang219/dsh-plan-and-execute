/**
 * 步骤结局分类与失败策略决策。纯函数。
 * @module plan-and-execute/decision
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { PaePausedReason, PaeStepReportPayload } from './state.ts'

export type StepOutcome = 'done' | 'blocked' | 'failed' | 'aborted' | 'missing-report'

/**
 * 对"自注入步骤指令后新追加的事件"分类本步结局。优先级：turn 结束原因 >
 * 本步 report（error/aborted 后到达的 report 不翻案）> 缺报。
 */
export function classifyStepOutcome(
  recent: readonly SessionEvent[],
  stepIndex: number,
): StepOutcome {
  let report: PaeStepReportPayload | undefined
  let turnEnd: { reason: { kind: string } } | undefined
  for (const event of recent) {
    if (event.type === 'pae/step-report' && event.data.stepIndex === stepIndex) report = event.data
    if (event.type === 'turn/end') turnEnd = event.data as { reason: { kind: string } }
  }
  const kind = turnEnd?.reason.kind
  if (kind === 'aborted') return 'aborted'
  if (kind === 'error' || kind === 'max-tokens' || kind === 'interrupted') return 'failed'
  if (report !== undefined) return report.outcome === 'done' ? 'done' : 'blocked'
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
