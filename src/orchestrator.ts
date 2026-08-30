/**
 * plan-and-execute 编排器：状态机 + 步进驱动循环。
 * 只依赖窄结构接口（DriveAgent/DriveSession/AskFn/PersistedStorage），
 * 全部可离线单测；真实 Agent 的适配在 src/index.ts。
 *
 * 控制流状态不写会话日志（dsh 白名单拒绝外部事件类型），改由
 * PersistedStorage 存 planDir/orchestrator.json；会话日志只记录标准事件
 * （turn/*、todo/write）。
 * @module plan-and-execute/orchestrator
 */
import type { SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { classifyOutcome, decideAction, type FailurePolicy, type StepOutcome } from './decision.ts'
import { validateManifest } from './manifest.ts'
import {
  resetPlanDir,
  restoreState,
  snapshotState,
  type PersistedOrchestratorState,
  type PersistedStorage,
} from './persist.ts'
import {
  kickoffInstruction,
  nudgeInstruction,
  planReviewDetail,
  recoverInstruction,
  replanInstruction,
  resumePlanningInstruction,
  stepInstruction,
} from './prompts.ts'
import {
  buildTodoPayload,
  normalizeDir,
  type PaePausedReason,
  type PaePhase,
  type PaePlanPayload,
  type PaeStepModel,
  type PaeStepReportPayload,
  type PlanStep,
} from './state.ts'

/** 窄化后的会话面：事件日志 + todo 整表写入（真实 Session 的适配在 src/index.ts）。 */
export interface DriveSession {
  /** 标准事件日志（仅宿主白名单事件；pae/* 不在此）。 */
  readonly events: readonly SessionEvent[]
  /** 写 `todo/write` 整表快照（宿主内置事件）。 */
  writeTodos(todos: readonly TodoItem[]): void
}

/** 窄化后的 Agent 驱动面：注入消息 + 等待回合空闲（settle 依赖）。 */
export interface DriveAgent {
  /** 会话面（事件日志 + todo 写入）。 */
  readonly session: DriveSession
  /** 注入一条消息（user role；插件编排指令）。 */
  steer(message: UserMessage): void
  /** 等待当前回合结束（超时/中断由宿主侧决定）。 */
  whenIdle(): Promise<void>
}

/** 用户交互通道：弹窗询问并返回答案（实现见 index.ts 的 askFor）。 */
export type AskFn = (questions: AskUserQuestionItem[]) => Promise<AskUserQuestionAnswer>

/** 解析后的编排配置：失败策略 + 计划根目录。 */
export interface ResolvedConfig extends FailurePolicy {
  /** 相对会话 cwd 的计划根目录（配置值）。 */
  readonly planRoot: string
}

/** 编排激活/结束钩子：装配层借此挂接工具可见性控制（如 deny exit_plan_mode）。 */
export interface OrchestratorHooks {
  /** 编排激活（begin 或 revive）时调用；可重复调用（幂等）。 */
  onActivate?(): void
  /** 编排结束（completed/aborted）时调用。 */
  onRestore?(): void
}

/** 审批弹窗「批准」选项标签。 */
export const APPROVE_LABEL = '批准'
/** 审批弹窗「继续修改」选项标签。 */
export const KEEP_LABEL = '继续修改'
/** 暂停弹窗「重试该步」选项标签。 */
export const PAUSE_RETRY = '重试该步'
/** 暂停弹窗「跳过该步」选项标签。 */
export const PAUSE_SKIP = '跳过该步'
/** 暂停弹窗「继续下一步」选项标签。 */
export const PAUSE_NEXT = '继续下一步'
/** 暂停弹窗「回到计划阶段」选项标签。 */
export const PAUSE_REPLAN = '回到计划阶段'
/** 暂停/确认点弹窗「终止」选项标签。 */
export const PAUSE_TERMINATE = '终止'
/** 确认点弹窗「继续」选项标签。 */
export const CONFIRM_CONTINUE = '继续'

/** 暂停弹窗的选项选择结果（'dismissed'=弹窗被关闭，保持暂停态）。 */
type PauseChoice = 'retry' | 'skip' | 'next' | 'replan' | 'terminate' | 'dismissed'

/** 编排器运行时内存态（与持久化快照的差异：Map/Set 集合、'none' 未开始初态）。 */
interface RuntimeState {
  /** 当前阶段；'none' 表示尚未开始。 */
  phase: PaePhase | 'none'
  /** 任务文本（用户输入）。 */
  task?: string
  /** 计划目录。 */
  planDir?: string
  /** 当前步骤号（1-based）。 */
  stepIndex?: number
  /** 暂停原因。 */
  pausedReason?: PaePausedReason
  /** 已批准的计划。 */
  plan?: PaePlanPayload
  /** 各步汇报（键为 1-based 步号）。 */
  stepReports: Map<number, PaeStepReportPayload>
  /** 各步 todo 状态（键为 1-based 步号）。 */
  statuses: Map<number, TodoItem['status']>
  /** 各步模型选择（键为 1-based 步号；缺省 = 用会话当前模型）。 */
  stepModels: Map<number, PaeStepModel>
  /** 被跳过（skip）的步骤号集合。 */
  skipped: Set<number>
}

/**
 * plan-and-execute 编排器：状态机 + 步进驱动循环。
 * 只依赖窄结构依赖（DriveAgent/DriveSession/AskFn/PersistedStorage），
 * 全部可离线单测；真实 Agent 的适配在 src/index.ts 的 toDriveAgent。
 */
export class Orchestrator {
  /** 已释放标记：置位后所有循环/恢复路径立即退出。 */
  private disposed = false
  /** 当前审批门闩（afterApproval 挂起，等待计划批准后启动执行循环）。 */
  private approval: PromiseWithResolvers<PaePlanPayload> | undefined
  /** 最近一次暂停/驳回的反馈 free-text（进入 replan 时回给模型）。 */
  private lastFeedback = ''
  /** report 注入水位线：注入指令时记下，settle 时据此判定"本回合新增的 report"。 */
  private reportSeq = 0
  /** 最近一次指令注入时的 reportSeq 快照（settle 判定新汇报的基线）。 */
  private reportWatermark = 0
  /** 步骤指令注入次数（含 retry 重注入）：单调递增，测试/审计用于区分同一步的多次尝试。 */
  private stepAttempt = 0
  /** 编排运行时状态（唯一事实源；save 时按 snapshotState 持久化）。 */
  private readonly state: RuntimeState = {
    phase: 'none',
    stepReports: new Map(),
    statuses: new Map(),
    stepModels: new Map(),
    skipped: new Set(),
  }

  /**
   * @param deps.agent - 窄化后的 Agent 驱动面（steer/whenIdle/会话事件日志）。
   * @param deps.ask - 用户交互通道（审批/暂停弹窗询问）。
   * @param deps.config - 解析后的失败策略配置。
   * @param deps.planDir - 本会话计划目录（已含 sessionId 后缀）。
   * @param deps.storage - 编排状态持久化（planDir/orchestrator.json）。
   * @param deps.hooks - 激活/结束钩子（工具可见性控制）。
   */
  constructor(
    private readonly deps: {
      agent: DriveAgent
      ask: AskFn
      config: ResolvedConfig
      planDir: string
      storage: PersistedStorage
      hooks?: OrchestratorHooks
    },
  ) {}

  /** 窄化会话面（事件日志 + todo 整表写入）。 */
  private get session(): DriveSession {
    return this.deps.agent.session
  }

  /** 折叠当前内存态为只读快照（同步读用）。 */
  private folded(): {
    phase: PaePhase | 'none'
    task?: string
    planDir?: string
    stepIndex?: number
    pausedReason?: PaePausedReason
  } {
    const { phase, task, planDir, stepIndex, pausedReason } = this.state
    return { phase, task, planDir, stepIndex, pausedReason }
  }

  /** 状态快照持久化（所有状态变更后调用；fail-loud：写盘失败向上抛）。 */
  private async save(): Promise<void> {
    await this.deps.storage.save(snapshotState(this.state))
  }

  /** 当前内存态快照（只读；prompt section 等同步读取用）。 */
  snapshot(): {
    phase: PaePhase | 'none'
    planDir?: string
    stepIndex?: number
    stepAttempt: number
  } {
    return {
      phase: this.state.phase,
      planDir: this.state.planDir,
      stepIndex: this.state.stepIndex,
      stepAttempt: this.stepAttempt,
    }
  }

  /** 命令入口：清空旧编排目录、进入规划阶段并注入 kickoff。 */
  async begin(task: string): Promise<void> {
    await resetPlanDir(this.deps.planDir)
    this.deps.hooks?.onActivate?.()
    this.state.phase = 'planning'
    this.state.task = task
    this.state.planDir = this.deps.planDir
    this.state.stepIndex = undefined
    this.state.pausedReason = undefined
    this.state.plan = undefined
    this.state.stepReports.clear()
    this.state.statuses.clear()
    this.state.stepModels.clear()
    this.state.skipped.clear()
    this.reportSeq = 0
    this.reportWatermark = 0
    this.stepAttempt = 0
    await this.save()
    this.deps.agent.steer(kickoffInstruction(task, this.deps.planDir))
    this.armApproval()
  }

  /** 建立审批门闩并挂起 afterApproval（计划批准后自动进入执行循环）。 */
  private armApproval(): void {
    this.approval = Promise.withResolvers<PaePlanPayload>()
    void this.afterApproval()
  }

  /** 审批等待协程：计划批准 → run(plan, 1)；异常或释放 → 置终止态。 */
  private async afterApproval(): Promise<void> {
    const gate = this.approval
    if (gate === undefined) return
    try {
      const plan = await gate.promise
      if (!this.disposed) await this.run(plan, 1)
    } catch (error) {
      if (!this.disposed) {
        this.state.phase = 'aborted'
        await this.save().catch(() => {})
      }
      void error
    }
  }

  /** submit_plan 工具入口：校验 + 审批。批准即启动执行循环。 */
  async submitPlan(
    planDir: string,
    steps: readonly PlanStep[],
    summary?: string,
  ): Promise<{ approved: true } | { approved: false; error: string }> {
    if (this.state.phase !== 'planning') {
      return {
        approved: false,
        error: 'submit_plan 仅在规划阶段可用（当前不在 plan-and-execute 规划中）',
      }
    }
    if (normalizeDir(planDir) !== normalizeDir(this.deps.planDir)) {
      return {
        approved: false,
        error: 'planDir 与编排计划目录不一致，请原样传回指令中给出的目录',
      }
    }
    const check = await validateManifest(this.deps.planDir, steps)
    if (!check.ok) {
      const lines = check.issues.map(
        (issue) => `- ${issue.file === '' ? '(整体)' : issue.file}: ${issue.problem}`,
      )
      return { approved: false, error: `计划文件校验失败，请修复后重新提交：\n${lines.join('\n')}` }
    }
    const answer = await this.askOrDismiss([
      {
        id: 'pae-approve',
        header: 'Plan review',
        question: `批准此计划（共 ${steps.length} 步）并开始执行？`,
        detail: planReviewDetail(steps, this.deps.planDir),
        options: [
          { label: APPROVE_LABEL, description: '离开规划阶段，开始逐步执行' },
          { label: KEEP_LABEL, description: '留在规划阶段；你的反馈将回给模型修改后重新提交' },
        ],
        intent: { kind: 'plan-review', approve: APPROVE_LABEL },
      },
    ])
    if (answer === 'dismissed') {
      return { approved: false, error: '用户暂时搁置了审批。留在规划阶段，等待用户下一条消息。' }
    }
    const item = answer.answers.find((entry) => entry.id === 'pae-approve')
    if (item?.selected[0] !== APPROVE_LABEL) {
      const feedback = item?.custom?.trim()
      return {
        approved: false,
        error:
          feedback && feedback !== ''
            ? `用户要求继续修改计划，反馈：${feedback}`
            : '用户要求继续修改计划；请调整后重新提交。',
      }
    }
    const plan: PaePlanPayload = {
      planDir: this.deps.planDir,
      steps,
      ...(summary === undefined ? {} : { summary }),
    }
    this.state.plan = plan
    this.state.phase = 'executing'
    this.state.stepIndex = 0
    this.state.stepReports.clear()
    this.state.statuses.clear()
    // 不清空 stepModels：批准非新计划（begin/enterReplan 已覆盖），审批前设置须存活到执行期
    this.state.skipped.clear()
    await this.save()
    this.session.writeTodos(buildTodoPayload(plan.steps, this.state.statuses).todos)
    this.approval?.resolve(plan)
    return { approved: true }
  }

  /**
   * 设置各步执行模型（Web UI 卡片经命令调用）。允许 planning/paused/executing
   * 阶段：paused/executing 下对当前步即时生效（waterfall 逐请求读取）。
   * planning 无已提交计划时仅校验步骤号为正整数（越界条目执行期惰性无害）；
   * 计划存在时校验 1..步数 边界。
   * @returns 失败原因或成功。
   */
  async applyStepModels(
    models: Readonly<Record<number, PaeStepModel>>,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (
      this.state.phase === 'none' ||
      this.state.phase === 'completed' ||
      this.state.phase === 'aborted'
    ) {
      return { ok: false, error: '当前阶段不可设置步骤模型' }
    }
    const plan = this.state.plan
    for (const key of Object.keys(models)) {
      const index = Number(key)
      if (!Number.isInteger(index) || index < 1) {
        return { ok: false, error: `步骤号 ${key} 不是正整数` }
      }
      if (plan !== undefined && index > plan.steps.length) {
        return { ok: false, error: `步骤号 ${key} 超出计划范围（1..${plan.steps.length}）` }
      }
    }
    this.state.stepModels = new Map(Object.entries(models).map(([k, v]) => [Number(k), v]))
    await this.save()
    return { ok: true }
  }

  /** 当前执行步的模型选择（仅 executing/paused 阶段透出；无映射返回 undefined）。 */
  stepModelFor(stepIndex: number): PaeStepModel | undefined {
    if (this.state.phase !== 'executing' && this.state.phase !== 'paused') return undefined
    return this.state.stepModels.get(stepIndex)
  }

  /**
   * 重新写入当前 todo 快照（供宿主 turn/start 后补写）。
   * 宿主 `todos` 投影语义：每个 turn/start 清空为 null（假定模型每回合重写清单），
   * 我们由插件驱动 todo 且写入发生在 steer 之前 → 面板在回合内消失。
   * 在 turn/start 之后补发一次 todo/write 可让面板在整个执行期持续可见。
   */
  refreshTodos(): void {
    const plan = this.state.plan
    if (plan === undefined) return
    if (this.state.phase !== 'executing' && this.state.phase !== 'paused') return
    this.session.writeTodos(buildTodoPayload(plan.steps, this.state.statuses).todos)
  }

  /** report_step 工具入口（按显式步号；步号由编排器判定，防伪造）。 */
  async reportStep(stepIndex: number, outcome: 'done' | 'blocked', summary: string): Promise<void> {
    const folded = this.folded()
    if (folded.phase !== 'executing' || folded.stepIndex !== stepIndex) {
      throw new Error(
        `report_step 与当前执行步骤不符（当前：第 ${folded.stepIndex ?? '?'} 步，收到：第 ${stepIndex} 步）`,
      )
    }
    this.state.stepReports.set(stepIndex, { stepIndex, outcome, summary })
    this.reportSeq += 1
    await this.save()
  }

  /** report_step 工具入口：步号取折叠状态中的当前步。 */
  async reportStepForCurrent(outcome: 'done' | 'blocked', summary: string): Promise<void> {
    const folded = this.folded()
    if (folded.phase !== 'executing' || folded.stepIndex === undefined || folded.stepIndex === 0) {
      throw new Error('report_step 仅在执行阶段的当前步骤内可用')
    }
    await this.reportStep(folded.stepIndex, outcome, summary)
  }

  /** 注入指令后等待本步结局。 */
  private async settle(stepIndex: number): Promise<StepOutcome> {
    const eventMark = this.session.events.length
    const reportWatermark = this.reportWatermark
    await this.deps.agent.whenIdle()
    if (this.disposed) return 'aborted'
    let turnEndKind: string | undefined
    for (const event of this.session.events.slice(eventMark)) {
      if (event.type === 'turn/end')
        turnEndKind = (event.data as { reason: { kind: string } }).reason.kind
    }
    const freshReport =
      this.reportSeq > reportWatermark ? this.state.stepReports.get(stepIndex) : undefined
    return classifyOutcome(turnEndKind, freshReport)
  }

  /** 更新某步 todo 状态并整表重写（statuses 单点修改入口）。 */
  private mark(stepIndex: number, status: TodoItem['status'], plan: PaePlanPayload): void {
    this.state.statuses.set(stepIndex, status)
    this.session.writeTodos(buildTodoPayload(plan.steps, this.state.statuses).todos)
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
        if (choice === 'replan') return this.enterReplan(plan)
        if (choice === 'skip' || choice === 'next') {
          if (choice === 'skip') this.state.skipped.add(i)
          i += 1
          nudged = false
          recoveries = 0
          continue
        }
        return // retry / dismissed 都不合适结构性问题：保持 paused
      }
      // 确认点：风险步骤执行前弹四选项
      if (step.requiresConfirmation === true) {
        const choice = await this.confirmChoice(i, plan)
        if (choice === 'dismissed') return // 保持 paused(confirm-point)，等 revive/命令重入
        if (choice === 'skip') {
          this.state.skipped.add(i)
          i += 1
          nudged = false
          recoveries = 0
          continue
        }
        if (choice === 'replan') return this.enterReplan(plan)
        if (choice === 'terminate') return this.finish('aborted', plan)
        // continue → 落到下方 executing
      }
      this.state.phase = 'executing'
      this.state.stepIndex = i
      this.stepAttempt += 1
      await this.save()
      this.mark(i, 'in_progress', plan)
      this.deps.agent.steer(stepInstruction(i, total, step, plan.planDir))
      this.reportWatermark = this.reportSeq
      let outcome = await this.settle(i)
      let action = decideAction(outcome, { nudged, recoveries, policy: this.deps.config })
      while (action.kind !== 'advance') {
        if (this.disposed) return
        if (action.kind === 'nudge') {
          nudged = true
          this.deps.agent.steer(nudgeInstruction())
          this.reportWatermark = this.reportSeq
        } else if (action.kind === 'recover') {
          recoveries += 1
          this.deps.agent.steer(recoverInstruction(outcome))
          this.reportWatermark = this.reportSeq
        } else {
          const choice = await this.pause(
            action.reason,
            i,
            plan,
            `第 ${i}/${total} 步（${step.title}）未完成（${outcome}）`,
          )
          if (choice === 'terminate') return this.finish('aborted', plan)
          if (choice === 'replan') return this.enterReplan(plan)
          if (choice === 'skip') {
            this.state.skipped.add(i)
            break
          }
          if (choice === 'next') {
            this.mark(i, 'completed', plan)
            break
          }
          if (choice === 'dismissed') return // 保持 paused：用户搁置弹窗，等命令重入或 revive
          // retry：恢复 executing（pause 已把状态置为 paused）并重新注入本步指令
          this.state.phase = 'executing'
          this.stepAttempt += 1
          await this.save()
          this.deps.agent.steer(stepInstruction(i, total, step, plan.planDir))
          this.reportWatermark = this.reportSeq
          outcome = await this.settle(i)
          action = decideAction(outcome, { nudged, recoveries, policy: this.deps.config })
          continue
        }
        outcome = await this.settle(i)
        action = decideAction(outcome, { nudged, recoveries, policy: this.deps.config })
      }
      // 正常推进（advance：模型自报 done）即标记本步完成——此前只有暂停弹窗的
      // "继续下一步"分支标记，导致串行执行时已完成步保持 in_progress 直到 finish()。
      // skip 路径已 break 跳出且 action 非 advance，保持 pending 不被误标。
      if (action.kind === 'advance') this.mark(i, 'completed', plan)
      i += 1
      nudged = false
      recoveries = 0
    }
    await this.finish('completed', plan)
  }

  /** 暂停交互（五选项）。弹窗被关视为保持暂停、等待用户消息。 */
  private async pause(
    reason: PaePausedReason,
    stepIndex: number,
    plan: PaePlanPayload,
    diagnostic: string,
  ): Promise<PauseChoice> {
    this.state.phase = 'paused'
    this.state.pausedReason = reason
    this.state.stepIndex = stepIndex
    await this.save()
    const answer = await this.askOrDismiss([
      {
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
      },
    ])
    if (answer === 'dismissed') return 'dismissed'
    const item = answer.answers.find((entry) => entry.id === 'pae-pause')
    const label = item?.selected[0]
    this.lastFeedback = item?.custom?.trim() ?? ''
    if (label === PAUSE_RETRY) return 'retry'
    if (label === PAUSE_SKIP) return 'skip'
    if (label === PAUSE_NEXT) return 'next'
    if (label === PAUSE_REPLAN) return 'replan'
    if (label === PAUSE_TERMINATE) return 'terminate'
    return 'dismissed'
  }

  /** 回到规划阶段：清计划、注入 replan 指令（携带最近反馈）、重新挂起审批。 */
  private async enterReplan(plan: PaePlanPayload): Promise<void> {
    this.state.phase = 'planning'
    this.state.plan = undefined
    this.state.stepModels.clear()
    await this.save()
    this.deps.agent.steer(replanInstruction(this.lastFeedback, plan.steps.length))
    this.armApproval()
  }

  /** 确认点弹窗（四选项），run() 与 revive 复用。 */
  private async confirmChoice(
    i: number,
    plan: PaePlanPayload,
  ): Promise<'continue' | 'skip' | 'replan' | 'terminate' | 'dismissed'> {
    const step = plan.steps[i - 1]
    this.state.phase = 'paused'
    this.state.pausedReason = 'confirm-point'
    this.state.stepIndex = i
    await this.save()
    const answer = await this.askOrDismiss([
      {
        id: 'pae-confirm',
        header: 'Plan-and-Execute 确认点',
        question: `即将执行第 ${i}/${plan.steps.length} 步：${step?.title ?? ''}`,
        detail: `步骤文件：${plan.planDir}/${step?.file ?? ''}`,
        options: [
          { label: CONFIRM_CONTINUE, description: '执行本步' },
          { label: PAUSE_SKIP, description: '跳过本步（终局标注 skipped）' },
          { label: PAUSE_REPLAN, description: '回到规划阶段修改计划' },
          { label: PAUSE_TERMINATE, description: '终止整个编排' },
        ],
      },
    ])
    if (answer === 'dismissed') return 'dismissed'
    const label = answer.answers.find((entry) => entry.id === 'pae-confirm')?.selected[0]
    if (label === PAUSE_SKIP) return 'skip'
    if (label === PAUSE_REPLAN) return 'replan'
    if (label === PAUSE_TERMINATE) return 'terminate'
    return 'continue'
  }

  /**
   * 恢复入口（agent/created 重建、或 paused 态命令重入）。先加载持久化
   * 状态，再按折叠状态弹对应交互并续跑；driver 由本方法自身充当。
   */
  async revive(): Promise<void> {
    if (this.disposed) return
    const persisted = await this.deps.storage.load()
    if (persisted === undefined) return
    this.applyPersisted(persisted)
    this.deps.hooks?.onActivate?.()
    const folded = this.folded()
    if (folded.phase === 'paused') {
      const reason = folded.pausedReason ?? 'failure'
      const plan = this.state.plan
      const i = folded.stepIndex ?? 1
      if (plan === undefined) return
      if (reason === 'confirm-point') {
        const choice = await this.confirmChoice(i, plan)
        if (choice === 'dismissed') return
        if (choice === 'skip') {
          this.state.skipped.add(i)
          return this.run(plan, i + 1)
        }
        if (choice === 'replan') return this.enterReplan(plan)
        if (choice === 'terminate') return this.finish('aborted', plan)
        return this.run(plan, i)
      }
      const choice = await this.pause(reason, i, plan, '编排恢复：请决定如何继续')
      if (choice === 'terminate') return this.finish('aborted', plan)
      if (choice === 'replan') return this.enterReplan(plan)
      if (choice === 'skip') {
        this.state.skipped.add(i)
        return this.run(plan, i + 1)
      }
      if (choice === 'next') {
        this.mark(i, 'completed', plan)
        return this.run(plan, i + 1)
      }
      if (choice === 'retry') return this.run(plan, i)
      return // dismissed：保持暂停
    }
    if (folded.phase === 'executing') {
      const plan = this.state.plan
      if (plan === undefined) return
      const i = Math.max(1, folded.stepIndex ?? 1)
      const answer = await this.askOrDismiss([
        {
          id: 'pae-resume',
          header: 'Plan-and-Execute 恢复',
          question: `编排在上次执行到第 ${i}/${plan.steps.length} 步时中断。从断点继续？`,
          options: [
            { label: '从断点继续', description: '重新注入当前步骤指令（以步为原子单位续跑）' },
            { label: PAUSE_REPLAN, description: '回到规划阶段修改计划' },
            { label: PAUSE_TERMINATE, description: '终止编排' },
          ],
        },
      ])
      if (answer === 'dismissed') return
      const label = answer.answers.find((entry) => entry.id === 'pae-resume')?.selected[0]
      if (label === '从断点继续') return this.run(plan, i)
      if (label === PAUSE_REPLAN) return this.enterReplan(plan)
      if (label === PAUSE_TERMINATE) return this.finish('aborted', plan)
      return
    }
    if (folded.phase === 'planning') {
      const answer = await this.askOrDismiss([
        {
          id: 'pae-resume',
          header: 'Plan-and-Execute 恢复',
          question: '编排在规划阶段中断，继续规划？',
          options: [
            { label: '继续规划', description: '提示模型继续完成步骤文件并提交审批' },
            { label: PAUSE_TERMINATE, description: '终止编排' },
          ],
        },
      ])
      if (answer === 'dismissed') return
      const label = answer.answers.find((entry) => entry.id === 'pae-resume')?.selected[0]
      if (label === '继续规划') {
        this.deps.agent.steer(resumePlanningInstruction())
        this.armApproval()
      } else if (label === PAUSE_TERMINATE) {
        this.state.phase = 'aborted'
        await this.save().catch(() => {})
      }
    }
  }

  /** 加载持久化快照到内存（resume 路径）。 */
  private applyPersisted(persisted: PersistedOrchestratorState): void {
    this.state.phase = persisted.phase
    this.state.task = persisted.task
    this.state.planDir = persisted.planDir
    this.state.stepIndex = persisted.stepIndex
    this.state.pausedReason = persisted.pausedReason
    this.state.plan = persisted.plan
    const restored = restoreState(persisted)
    this.state.stepReports = restored.stepReports
    this.state.statuses = restored.statuses
    this.state.stepModels = restored.stepModels
    this.state.skipped = restored.skipped
    this.reportSeq = restored.stepReports.size
    this.reportWatermark = this.reportSeq
  }

  /** 收尾：恢复工具可见性、置终态、写 todo（completed 时弹完成通知）。 */
  private async finish(phase: 'completed' | 'aborted', plan: PaePlanPayload): Promise<void> {
    this.deps.hooks?.onRestore?.()
    this.state.phase = phase
    if (phase === 'completed') {
      // 非跳过步一律 completed（含仍 in_progress 的最终步）；跳过步保持 pending
      for (let k = 1; k <= plan.steps.length; k++) {
        if (!this.state.skipped.has(k)) this.state.statuses.set(k, 'completed')
      }
    }
    await this.save()
    if (phase === 'completed') {
      // 完成不再弹通知卡（2026-08-30 需求：去掉最后的审批卡提醒）；todo 表已反映终态
      this.session.writeTodos(buildTodoPayload(plan.steps, this.state.statuses).todos)
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

  /** 释放编排器（停止一切循环与恢复；幂等）。 */
  dispose(): void {
    this.disposed = true
  }
}
