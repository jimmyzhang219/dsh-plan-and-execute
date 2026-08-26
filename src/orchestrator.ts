/**
 * plan-and-execute 编排器：状态机 + 步进驱动循环。
 * 只依赖窄结构接口（DriveAgent/DriveSession/AskFn），全部可离线单测；
 * 真实 Agent → DriveAgent 的适配在 src/index.ts。
 * @module plan-and-execute/orchestrator
 */
import type { SessionEvent, TodoItem, UserMessage } from '@deepseek-ai/dsh-session'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import {
  classifyStepOutcome,
  decideAction,
  type FailurePolicy,
  type StepOutcome,
} from './decision.ts'
import { validateManifest } from './manifest.ts'
import {
  completionDetail,
  kickoffInstruction,
  nudgeInstruction,
  planReviewDetail,
  recoverInstruction,
  replanInstruction,
  stepInstruction,
} from './prompts.ts'
import {
  buildTodoPayload,
  foldPae,
  foldStepReports,
  type PaePausedReason,
  type PaePlanPayload,
  type PlanStep,
} from './state.ts'

export type PaeEventType = 'pae/state' | 'pae/plan' | 'pae/step-report' | 'todo/write'

export interface DriveSession {
  readonly events: readonly SessionEvent[]
  append(eventType: PaeEventType, data: object): void
}

export interface DriveAgent {
  readonly session: DriveSession
  steer(message: UserMessage): void
  whenIdle(): Promise<void>
}

export type AskFn = (questions: AskUserQuestionItem[]) => Promise<AskUserQuestionAnswer>

export interface ResolvedConfig extends FailurePolicy {
  /** 相对会话 cwd 的计划根目录（配置值）。 */
  readonly planRoot: string
}

export const APPROVE_LABEL = '批准'
export const KEEP_LABEL = '继续修改'
export const PAUSE_RETRY = '重试该步'
export const PAUSE_SKIP = '跳过该步'
export const PAUSE_NEXT = '继续下一步'
export const PAUSE_REPLAN = '回到计划阶段'
export const PAUSE_TERMINATE = '终止'
export const CONFIRM_CONTINUE = '继续'
export const DONE_ACK = '知道了'

type PauseChoice = 'retry' | 'skip' | 'next' | 'replan' | 'terminate' | 'dismissed'

export class Orchestrator {
  private disposed = false
  private approval: PromiseWithResolvers<PaePlanPayload> | undefined
  private statuses = new Map<number, TodoItem['status']>()
  private skipped = new Set<number>()
  private lastFeedback = ''

  constructor(
    private readonly deps: {
      agent: DriveAgent
      ask: AskFn
      config: ResolvedConfig
      planDir: string
    },
  ) {}

  private get session(): DriveSession {
    return this.deps.agent.session
  }

  private append(eventType: PaeEventType, data: object): void {
    this.session.append(eventType, data)
  }

  private folded() {
    return foldPae(this.session.events)
  }

  /** 命令入口：进入规划阶段并注入 kickoff。 */
  begin(task: string): void {
    this.append('pae/state', { phase: 'planning', task, planDir: this.deps.planDir })
    this.deps.agent.steer(kickoffInstruction(task, this.deps.planDir))
    this.armApproval()
  }

  private armApproval(): void {
    this.approval = Promise.withResolvers<PaePlanPayload>()
    void this.afterApproval()
  }

  private async afterApproval(): Promise<void> {
    const gate = this.approval
    if (gate === undefined) return
    try {
      const plan = await gate.promise
      if (!this.disposed) await this.run(plan, 1)
    } catch (error) {
      if (!this.disposed) {
        this.append('pae/state', {
          phase: 'aborted',
          task: this.folded().task,
          planDir: this.deps.planDir,
        })
      }
      void error
    }
  }

  /** submit_plan 工具入口：校验 + 审批。批准即启动执行循环。 */
  async submitPlan(
    steps: readonly PlanStep[],
    summary?: string,
  ): Promise<{ approved: true } | { approved: false; error: string }> {
    if (this.folded().phase !== 'planning') {
      return {
        approved: false,
        error: 'submit_plan 仅在规划阶段可用（当前不在 plan-and-execute 规划中）',
      }
    }
    const check = await validateManifest(this.deps.planDir, steps)
    if (!check.ok) {
      const lines = check.issues.map(issue =>
        `- ${issue.file === '' ? '(整体)' : issue.file}: ${issue.problem}`)
      return { approved: false, error: `计划文件校验失败，请修复后重新提交：\n${lines.join('\n')}` }
    }
    const answer = await this.askOrDismiss([{
      id: 'pae-approve',
      header: 'Plan review',
      question: `批准此计划（共 ${steps.length} 步）并开始执行？`,
      detail: planReviewDetail(steps, this.deps.planDir),
      options: [
        { label: APPROVE_LABEL, description: '离开规划阶段，开始逐步执行' },
        { label: KEEP_LABEL, description: '留在规划阶段；你的反馈将回给模型修改后重新提交' },
      ],
      intent: { kind: 'plan-review', approve: APPROVE_LABEL },
    }])
    if (answer === 'dismissed') {
      return { approved: false, error: '用户暂时搁置了审批。留在规划阶段，等待用户下一条消息。' }
    }
    const item = answer.answers.find(entry => entry.id === 'pae-approve')
    if (item?.selected[0] !== APPROVE_LABEL) {
      const feedback = item?.custom?.trim()
      return {
        approved: false,
        error: feedback && feedback !== ''
          ? `用户要求继续修改计划，反馈：${feedback}`
          : '用户要求继续修改计划；请调整后重新提交。',
      }
    }
    const plan: PaePlanPayload = {
      planDir: this.deps.planDir,
      steps,
      ...(summary === undefined ? {} : { summary }),
    }
    this.statuses.clear()
    this.skipped.clear()
    this.append('pae/plan', plan)
    this.append('pae/state', {
      phase: 'executing',
      stepIndex: 0,
      planDir: plan.planDir,
      task: this.folded().task,
    })
    this.append('todo/write', buildTodoPayload(plan.steps, this.statuses))
    this.approval?.resolve(plan)
    return { approved: true }
  }

  /** report_step 工具入口（按显式步号；步号由编排器判定，防伪造）。 */
  reportStep(stepIndex: number, outcome: 'done' | 'blocked', summary: string): void {
    const folded = this.folded()
    if (folded.phase !== 'executing' || folded.stepIndex !== stepIndex) {
      throw new Error(
        `report_step 与当前执行步骤不符（当前：第 ${folded.stepIndex ?? '?'} 步，收到：第 ${stepIndex} 步）`,
      )
    }
    this.append('pae/step-report', { stepIndex, outcome, summary })
  }

  /** report_step 工具入口：步号取折叠状态中的当前步。 */
  reportStepForCurrent(outcome: 'done' | 'blocked', summary: string): void {
    const folded = this.folded()
    if (folded.phase !== 'executing' || folded.stepIndex === undefined || folded.stepIndex === 0) {
      throw new Error('report_step 仅在执行阶段的当前步骤内可用')
    }
    this.reportStep(folded.stepIndex, outcome, summary)
  }

  /** 注入指令后等待本步结局。 */
  private async settle(mark: number, stepIndex: number): Promise<StepOutcome> {
    await this.deps.agent.whenIdle()
    if (this.disposed) return 'aborted'
    return classifyStepOutcome(this.session.events.slice(mark), stepIndex)
  }

  private mark(stepIndex: number, status: TodoItem['status'], plan: PaePlanPayload): void {
    this.statuses.set(stepIndex, status)
    this.append('todo/write', buildTodoPayload(plan.steps, this.statuses))
  }

  /** 执行主循环：from 为 1-based 起始步。 */
  private async run(plan: PaePlanPayload, from: number): Promise<void> {
    const total = plan.steps.length
    let i = from
    let nudged = false
    let recoveries = 0
    while (i <= total) {
      if (this.disposed) return
      const step = plan.steps[i - 1]!
      // 结构性问题（文件悬空）不自动处理：直接暂停
      const check = await validateManifest(plan.planDir, [step])
      if (!check.ok) {
        const choice = await this.pause(
          'failure',
          i,
          plan,
          `步骤文件校验失败：${check.issues[0]?.problem ?? '文件不可用'}`,
        )
        if (choice === 'terminate') return this.finish('aborted', plan)
        if (choice === 'replan') return this.enterReplan(plan, choice)
        if (choice === 'skip' || choice === 'next') {
          if (choice === 'skip') this.skipped.add(i)
          i += 1
          nudged = false
          recoveries = 0
          continue
        }
        return // retry / dismissed 都不合适结构性问题：保持 paused
      }
      this.append('pae/state', {
        phase: 'executing',
        stepIndex: i,
        planDir: plan.planDir,
        task: this.folded().task,
      })
      this.mark(i, 'in_progress', plan)
      this.deps.agent.steer(stepInstruction(i, total, step, plan.planDir))
      let outcome = await this.settle(this.session.events.length, i)
      let action = decideAction(outcome, { nudged, recoveries, policy: this.deps.config })
      while (action.kind !== 'advance') {
        if (this.disposed) return
        if (action.kind === 'nudge') {
          nudged = true
          this.deps.agent.steer(nudgeInstruction())
        } else if (action.kind === 'recover') {
          recoveries += 1
          this.deps.agent.steer(recoverInstruction(outcome))
        } else {
          const choice = await this.pause(
            action.reason,
            i,
            plan,
            `第 ${i}/${total} 步（${step.title}）未完成（${outcome}）`,
          )
          if (choice === 'terminate') return this.finish('aborted', plan)
          if (choice === 'replan') return this.enterReplan(plan, choice)
          if (choice === 'skip') {
            this.skipped.add(i)
            break
          }
          if (choice === 'next') {
            this.mark(i, 'completed', plan)
            break
          }
          if (choice === 'dismissed') return // 保持 paused：用户搁置弹窗，等命令重入或 revive
          // retry：重新注入本步指令再等待
          this.deps.agent.steer(stepInstruction(i, total, step, plan.planDir))
          outcome = await this.settle(this.session.events.length, i)
          action = decideAction(outcome, { nudged, recoveries, policy: this.deps.config })
          continue
        }
        outcome = await this.settle(this.session.events.length, i)
        action = decideAction(outcome, { nudged, recoveries, policy: this.deps.config })
      }
      i += 1
      nudged = false
      recoveries = 0
    }
    this.finish('completed', plan)
  }

  /** 暂停交互（五选项）。弹窗被关视为保持暂停、等待用户消息。 */
  private async pause(
    reason: PaePausedReason,
    stepIndex: number,
    plan: PaePlanPayload,
    diagnostic: string,
  ): Promise<PauseChoice> {
    this.append('pae/state', {
      phase: 'paused',
      pausedReason: reason,
      stepIndex,
      planDir: plan.planDir,
      task: this.folded().task,
    })
    const answer = await this.askOrDismiss([{
      id: 'pae-pause',
      header: 'Plan-and-Execute 已暂停',
      question: `第 ${stepIndex}/${plan.steps.length} 步暂停（${reason}）：${diagnostic}`,
      options: [
        { label: PAUSE_RETRY, description: '重新注入本步指令再执行一次' },
        { label: PAUSE_SKIP, description: '跳过本步（todo 保持 pending，终局标注 skipped）' },
        { label: PAUSE_NEXT, description: '接受现状，继续下一步' },
        { label: PAUSE_REPLAN, description: '回到规划阶段修改计划（可在弹窗输入反馈）' },
        { label: PAUSE_TERMINATE, description: '终止整个编排' },
      ],
    }])
    if (answer === 'dismissed') return 'dismissed'
    const item = answer.answers.find(entry => entry.id === 'pae-pause')
    const label = item?.selected[0]
    this.lastFeedback = item?.custom?.trim() ?? ''
    if (label === PAUSE_RETRY) return 'retry'
    if (label === PAUSE_SKIP) return 'skip'
    if (label === PAUSE_NEXT) return 'next'
    if (label === PAUSE_REPLAN) return 'replan'
    if (label === PAUSE_TERMINATE) return 'terminate'
    return 'dismissed'
  }

  private async enterReplan(plan: PaePlanPayload, _feedback: string): Promise<void> {
    const task = this.folded().task
    this.append('pae/state', { phase: 'planning', task, planDir: plan.planDir })
    this.deps.agent.steer(replanInstruction(this.lastFeedback, plan.steps.length))
    this.armApproval()
  }

  private finish(phase: 'completed' | 'aborted', plan: PaePlanPayload): void {
    const task = this.folded().task
    this.append('pae/state', { phase, task, planDir: plan.planDir })
    if (phase === 'completed') {
      // 非跳过步一律 completed（含仍 in_progress 的最终步）；跳过步保持 pending
      for (let k = 1; k <= plan.steps.length; k++) {
        if (!this.skipped.has(k)) this.statuses.set(k, 'completed')
      }
      this.append('todo/write', buildTodoPayload(plan.steps, this.statuses))
      void this.askOrDismiss([{
        id: 'pae-done',
        header: 'Plan-and-Execute 完成',
        question: '计划已全部执行完成。',
        detail: completionDetail(plan.steps, foldStepReports(this.session.events), this.skipped),
        options: [{ label: DONE_ACK, description: '关闭通知' }],
      }])
    }
  }

  /** ask 包装：任何抛错（含 ASK_CANCELLED）折叠为 'dismissed'。 */
  private async askOrDismiss(
    questions: AskUserQuestionItem[],
  ): Promise<AskUserQuestionAnswer | 'dismissed'> {
    try {
      return await this.deps.ask(questions)
    } catch {
      return 'dismissed'
    }
  }

  dispose(): void {
    this.disposed = true
  }
}
