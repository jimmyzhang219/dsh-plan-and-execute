/**
 * 步骤结局分类与失败策略决策。纯函数。
 * @module plan-and-execute/decision
 */
import type { PaePausedReason, PaeStepReportPayload } from './state.ts'

/** 单步结局分类：模型自报（done/blocked）、turn 终止（failed/aborted）、本回合缺报（missing-report）。 */
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

/** 决策输出动作：advance=推进下一步；nudge=提示补报；recover=自愈重试；pause=暂停（附原因）。 */
export type StepAction =
  | { kind: 'advance' }
  | { kind: 'nudge' }
  | { kind: 'recover' }
  | { kind: 'pause'; reason: Extract<PaePausedReason, 'failure' | 'cancelled'> }

/** 步骤失败策略（来自插件配置）。 */
export interface FailurePolicy {
  /** 失败处置：'pause'=暂停问人；'auto-recover'=自动重试。 */
  readonly onStepFailure: 'pause' | 'auto-recover'
  /** auto-recover 模式下单步自愈次数上限。 */
  readonly maxAutoRecoveries: number
}

/**
 * 由本步结局与重试上下文决策下一步动作。
 * @param outcome - 本步结局分类（classifyOutcome 的输出）。
 * @param context - nudged：本步是否已提示过补报；recoveries：本步已自愈次数；policy：失败策略。
 * @returns 决策动作（advance/nudge/recover/pause）。
 */
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

/** 失败（blocked/failed）或已提示仍缺报的统一处置：未达自愈上限则 recover，否则 pause。 */
function failureAction(context: { recoveries: number; policy: FailurePolicy }): StepAction {
  const { onStepFailure, maxAutoRecoveries } = context.policy
  if (onStepFailure === 'auto-recover' && context.recoveries < maxAutoRecoveries) {
    return { kind: 'recover' }
  }
  return { kind: 'pause', reason: 'failure' }
}
