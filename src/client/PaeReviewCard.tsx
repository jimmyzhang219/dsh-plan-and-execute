/**
 * plan-review 审批卡替换：步骤打开文件/目录 + 每步模型下拉（静默写 settings）+ 决策按钮。
 * 注册于 conversation.composer（priority -1），仅接管 plan-review 待审批。
 * 数据获取与异步（modelCatalog/canOpenWorkspacePath）在 PaeReviewCardView 薄包装里完成，
 * PaeReviewCard 只收纯数据 props（便于 jsdom 单测）。
 *
 * 注意（2026-08-30 线上事故）：视图不得使用 useChat/useProjection——composer 座位调用
 * useChat 触发宿主聊天快照构建器脱绑崩溃（this.valuesDirty），审批提问不可见导致宿主
 * askOrDismiss 永久挂起。步骤数据一律来自审批问题 detail（parsePlanDetail，自有格式）。
 * @module dsh-plan-and-execute/client/PaeReviewCard
 */
import { useEffect, useState, type ReactElement } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClientRemote, ModelCatalog } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only：composer 槽位类型合并（本组件不再消费 useChat/useProjection）。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { CardArgs, ModelOption } from './plan-card.ts'
import { flattenCatalog, optionKey } from './plan-card.ts'
import { PAE_MODELS_NS, PAE_SCHEDULE_NS } from '../state.ts'
import {
  buildSchedulePatch,
  buildSettingsPatch,
  isPlanReviewPending,
  parsePlanDetail,
  questionView,
  type PlanReviewPendingLike,
} from './review-card.ts'
import type { NS } from './locale.ts'

/** 决策答案形状（与宿主 AskUserQuestionAnswer 一致的最小面）。 */
interface AnswerLike {
  answers: ReadonlyArray<{
    readonly id: string
    readonly selected: readonly string[]
    readonly custom?: string
  }>
}

/**
 * JSON 值（settings 通道载荷类型）。宿主侧定义于 dsh-util-values，
 * 该包运行时由 dsh 进程提供、不随本插件安装，故在此本地复刻，
 * 语义与宿主一致（见 review-card.ts 的 buildSettingsPatch 载荷）。
 */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** epoch ms → 本地 'YYYY-MM-DD HH:mm'（chip 显示；与服务端 formatScheduleAt 同格式）。 */
function formatLocal(at: number): string {
  const d = new Date(at)
  const pad = (v: number): string => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
/** 'YYYY-MM-DD' + 'HH:mm'（两个原生 input 值）→ epoch ms；缺任一部分返回 undefined。 */
function composeAt(datePart: string, timePart: string): number | undefined {
  if (datePart === '' || timePart === '') return undefined
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(datePart)
  const tm = /^(\d{2}):(\d{2})$/.exec(timePart)
  if (dm === null || tm === null) return undefined
  const d = new Date(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), Number(tm[1]), Number(tm[2]))
  return d.getTime()
}
/** epoch ms → date/time 两个 input 的 value（本地）。 */
function splitLocal(at: number): { datePart: string; timePart: string } {
  const d = new Date(at)
  const pad = (v: number): string => String(v).padStart(2, '0')
  return {
    datePart: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    timePart: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  }
}

export interface PaeReviewCardProps {
  /** 会话标识（与宿主 agent.id 同源；空串时跳过模型选择静默写）。 */
  readonly sessionId: string
  /** 结构判定通过的待审批交互（kind==='plan-review'）。 */
  readonly pending: PlanReviewPendingLike
  /** 解析出的步骤数据（parsePlanDetail 产物；undefined 时仅渲染决策区）。 */
  readonly args: CardArgs | undefined
  /** 回显卡回显排期（epoch ms；detail「执行排期」行解析值，无排期行时缺省=立即执行）。 */
  readonly scheduledAt?: number
  /** 宿主可打开工作区路径（canOpenWorkspacePath；联动步骤标题点击）。 */
  readonly canOpen: boolean
  /** 展平后的模型下拉选项（目录未就绪时为空数组）。 */
  readonly options: readonly ModelOption[]
  /** 当前会话模型（下拉默认值；provider|model 拼接）。 */
  readonly current: { readonly provider: string; readonly model: string }
  /** 打开路径回调（目录/步骤文件，经 session.openWorkspacePath）。 */
  readonly openPath: (path: string) => void
  /** 静默写 settings 通道（模型选择持久化）。 */
  readonly settings: {
    readonly update: (
      ns: string,
      patch: Record<string, JsonValue>,
      rev: number | undefined,
    ) => Promise<unknown>
  }
  /** 文案翻译函数（locale 注入；键见 locale.ts）。 */
  readonly t: (key: string) => string
}

/** 审批卡（受控下拉 + 静默写 + 决策按钮，busy/error settle 同宿主 PlanReviewPanel）。 */
export function PaeReviewCard({
  sessionId,
  pending,
  args,
  scheduledAt,
  canOpen,
  options,
  current,
  openPath,
  settings,
  t,
}: PaeReviewCardProps): ReactElement {
  const review = questionView(pending.questions)
  const defaultValue = optionKey(current)
  const [selection, setSelection] = useState<Record<number, string>>({})
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [when, setWhen] = useState<number | null>(scheduledAt ?? null) // null=立即
  const [pickerOpen, setPickerOpen] = useState(false)
  const [datePart, setDatePart] = useState(() =>
    scheduledAt === undefined ? '' : splitLocal(scheduledAt).datePart,
  )
  const [timePart, setTimePart] = useState(() =>
    scheduledAt === undefined ? '' : splitLocal(scheduledAt).timePart,
  )

  /** 决策提交包装：置 busy、清错误；send 抛错时折叠为卡片内错误文案。 */
  const settle = (send: () => Promise<unknown>): void => {
    setBusy(true)
    setError(null)
    void send().catch((cause: unknown) => {
      setBusy(false)
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }
  /** 决策按钮点击：按所选标签组装 answers 载荷并提交（pending.answer）。 */
  const decide = (label: string, custom?: string): void => {
    if (review === undefined) return
    const answers: AnswerLike['answers'] = [
      {
        id: review.id,
        selected: [label],
        ...(custom === undefined || custom === '' ? {} : { custom }),
      },
    ]
    settle(() => pending.answer({ answers }))
  }
  /**
   * 决策按钮显示本地化；answer 载荷仍发送规范标签（'批准'/'继续修改'，
   * 与宿主编排器 APPROVE_LABEL/KEEP_LABEL 比较键一致——client 不能值导入
   * 宿主 orchestrator.ts，字符串常量在此复制并保持同步）。
   */
  const optionLabel = (label: string): string => {
    if (label === '批准') return t('approve')
    if (label === '继续修改') return t('keep')
    return label
  }
  /** 模型下拉变更：本地 selection 更新 + settings 静默写（无 sessionId 时仅本地生效）。 */
  const onModelChange = (step: number, value: string): void => {
    const next = { ...selection, [step]: value }
    setSelection(next)
    setError(null)
    // 会话标识缺失（极边缘路径）时跳过静默写：决策按钮仍可用，下拉仅本地生效。
    if (sessionId === '') {
      console.warn('[dsh-plan-and-execute] 审批卡缺少 sessionId，跳过模型选择保存')
      return
    }
    void settings
      .update(PAE_MODELS_NS, buildSettingsPatch(sessionId, next), undefined)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
  }
  /** 静默写 settings（无 sessionId 时跳过——同模型下拉的容错）。 */
  const pushSchedule = (at: number | null): void => {
    if (sessionId === '') {
      console.warn('[dsh-plan-and-execute] 审批卡缺少 sessionId，跳过排期保存')
      return
    }
    void settings
      .update(PAE_SCHEDULE_NS, buildSchedulePatch(sessionId, at), undefined)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
  }
  /** 组合日期时间并校验；合法则静默写排期并更新 chip。 */
  const commitSchedule = (datePart: string, timePart: string): void => {
    const at = composeAt(datePart, timePart)
    if (at === undefined) {
      setError(t('scheduleHint'))
      return
    }
    if (at <= Date.now()) {
      setError(t('schedulePast'))
      return
    }
    setError(null)
    setWhen(at)
    setPickerOpen(false)
    pushSchedule(at)
  }
  /** 清除排期（立即执行）：浮层按钮与 chip 的 × 共用。 */
  const clearSchedule = (): void => {
    setWhen(null)
    setDatePart('')
    setTimePart('')
    setPickerOpen(false)
    setError(null)
    pushSchedule(null)
  }

  return (
    <div className="pae-frame">
      <section
        className="pae-card"
        data-testid="pae-review-card"
        aria-label={review?.question ?? 'plan review'}
      >
        <header className="pae-strip">
          <span className="pae-dot" />
          <strong>{t('planReview')}</strong>
          <span className="pae-header-actions">
            <span className="pae-schedule">
              {/* 宿主 ButtonVariant 无 'default'（primary/ghost/outline/toolbar）：
                  排期态用 toolbar（中性填充 chip），立即态用 outline（简报语义对照） */}
              <Button
                size="sm"
                variant={when === null ? 'outline' : 'toolbar'}
                onClick={() => setPickerOpen((open) => !open)}
              >
                {when === null
                  ? t('scheduleNow')
                  : t('scheduleAtHint').replace('%s', formatLocal(when))}
              </Button>
              {when !== null ? (
                <button
                  type="button"
                  className="pae-schedule-clear"
                  aria-label={t('scheduleClear')}
                  onClick={clearSchedule}
                >
                  ×
                </button>
              ) : null}
              {pickerOpen ? (
                <div className="pae-schedule-picker" data-testid="schedule-picker">
                  <label>
                    {t('scheduleDate')}
                    <input
                      type="date"
                      aria-label={t('scheduleDate')}
                      value={datePart}
                      onChange={(e) => {
                        setDatePart(e.target.value)
                        commitSchedule(e.target.value, timePart)
                      }}
                    />
                  </label>
                  <label>
                    {t('scheduleTime')}
                    <input
                      type="time"
                      aria-label={t('scheduleTime')}
                      value={timePart}
                      onChange={(e) => {
                        setTimePart(e.target.value)
                        commitSchedule(datePart, e.target.value)
                      }}
                    />
                  </label>
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid="schedule-now"
                    onClick={clearSchedule}
                  >
                    {t('scheduleNow')}
                  </Button>
                </div>
              ) : null}
            </span>
            {canOpen && args !== undefined ? (
              <Button size="sm" aria-label={t('openDir')} onClick={() => openPath(args.planDir)}>
                {t('openDir')}
              </Button>
            ) : null}
          </span>
        </header>
        <div className="pae-body">
          {args?.summary !== undefined ? <p className="pae-summary">{args.summary}</p> : null}
          {args === undefined ? null : (
            <ol className="pae-steps">
              {args.steps.map((step, index) => {
                const i = index + 1
                const value = selection[i] ?? defaultValue
                return (
                  <li className="pae-step" key={step.file}>
                    {canOpen ? (
                      // 点击步骤标题在宿主机默认应用打开步骤 md 文件（文件名不再展示）
                      <button
                        type="button"
                        className="pae-step-title-btn"
                        aria-label={`${t('openStep')} ${i}. ${step.title}`}
                        title={`${args.planDir}/${step.file}`}
                        onClick={() => openPath(`${args.planDir}/${step.file}`)}
                      >
                        {i}. {step.title}
                        {step.requiresConfirmation === true ? ' ⚠' : ''}
                      </button>
                    ) : (
                      <span className="pae-step-title">
                        {i}. {step.title}
                        {step.requiresConfirmation === true ? ' ⚠' : ''}
                      </span>
                    )}
                    <select
                      className="pae-step-select"
                      aria-label={`model-${i}`}
                      value={value}
                      onChange={(event) => onModelChange(i, event.target.value)}
                    >
                      {options.map((option) => (
                        <option key={optionKey(option)} value={optionKey(option)}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </li>
                )
              })}
            </ol>
          )}
          <label className="pae-feedback">
            {t('feedback')}
            <textarea
              className="pae-feedback-textarea"
              value={feedback}
              onChange={(event) => setFeedback(event.target.value)}
              placeholder={t('feedbackHint')}
            />
          </label>
          <div className="pae-error" role="status">
            {error}
          </div>
        </div>
        <footer className="pae-footer">
          <span className="pae-actions">
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                settle(() => pending.cancel())
              }}
            >
              {t('discuss')}
            </Button>
          </span>
          <span className="pae-actions">
            {review?.options.map((option, index) => (
              <Button
                key={option.label}
                variant={index === review.options.length - 1 ? 'primary' : 'outline'}
                disabled={busy}
                title={option.description}
                onClick={() => decide(option.label, feedback)}
              >
                {optionLabel(option.label)}
              </Button>
            ))}
          </span>
        </footer>
      </section>
    </div>
  )
}

/**
 * session 远端面的最小契约：审批卡只消费这三个方法，
 * 注册入口传入真实 ClientRemote['session']（Pick 即真实签名，结构赋值零 as）。
 */
type ReviewSessionRemoteLike = Pick<
  ClientRemote['session'],
  'modelCatalog' | 'canOpenWorkspacePath' | 'openWorkspacePath'
>

/** settings 远端面：静默写模型选择（Pick 即真实签名）。 */
type ReviewSettingsRemoteLike = Pick<ClientRemote['settings'], 'update'>

/** 审批卡注入面（注册入口 inject 工厂返回）。 */
export interface PaeReviewCardInjected {
  readonly sessionRemote: ReviewSessionRemoteLike
  readonly settingsRemote: ReviewSettingsRemoteLike
  readonly connection: { readonly isLoopback: boolean }
}

/** conversation.composer 注册入口的完整组件 props（owner + locale + 注入面）。 */
type PaeReviewCardViewProps = PaeReviewCardInjected &
  PropsLocale<typeof NS> & {
    /** 会话标识（composer owner props；与宿主 agent.id 同源，缺失时回退 pending.sessionId）。 */
    readonly sessionId: string | undefined
    /** 当前会话待审批交互（owner props；结构判定见 isPlanReviewPending）。 */
    readonly pendingInteraction: unknown
  }

/**
 * plan-review 审批卡薄包装：挂载时取 modelCatalog/canOpenWorkspacePath，
 * 步骤数据从审批问题 detail 解析（parsePlanDetail——不使用 useChat，见文件头事故说明），
 * 组装 PaeReviewCardProps 渲染 PaeReviewCard；openPath 走 session.openWorkspacePath。
 */
export function PaeReviewCardView({
  sessionId,
  pendingInteraction,
  t,
  sessionRemote,
  settingsRemote,
  connection,
}: PaeReviewCardViewProps): ReactElement | null {
  const [catalog, setCatalog] = useState<ModelCatalog | undefined>(undefined)
  const [canOpen, setCanOpen] = useState(false)

  /** 挂载时并行取模型目录与「可打开工作区路径」能力；cancelled 竞态防护（卸载后不再 setState）。 */
  useEffect(() => {
    let cancelled = false
    void Promise.all([sessionRemote.modelCatalog(), sessionRemote.canOpenWorkspacePath()])
      .then(([catalogResult, canOpenResult]) => {
        if (cancelled) return
        if (catalogResult.ok) setCatalog(catalogResult.value)
        if (canOpenResult.ok) setCanOpen(canOpenResult.value)
      })
      .catch(() => {
        // 装配/连接故障：保持「目录不可用」默认呈现
      })
    return () => {
      cancelled = true
    }
  }, [sessionRemote])

  // owner props 的 pendingInteraction 与 selector 的 matched 同值；结构判定不过则不接管
  if (!isPlanReviewPending(pendingInteraction)) return null
  const pending = pendingInteraction
  const review = questionView(pending.questions)
  const args = review?.detail === undefined ? undefined : parsePlanDetail(review.detail)

  return (
    <PaeReviewCard
      sessionId={sessionId ?? pending.sessionId ?? ''}
      pending={pending}
      args={args}
      scheduledAt={args?.scheduledAt}
      canOpen={canOpen && connection.isLoopback}
      // 目录未就绪时先渲染决策按钮（选项空）；就绪后下拉出现（提交按钮不依赖目录）
      options={catalog === undefined ? [] : flattenCatalog(catalog)}
      current={catalog?.default ?? { provider: '', model: '' }}
      openPath={(path) => sessionRemote.openWorkspacePath({ path })}
      settings={{ update: settingsRemote.update }}
      t={t as (key: string) => string}
    />
  )
}
