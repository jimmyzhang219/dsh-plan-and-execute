/**
 * plan-review 审批卡替换：步骤打开文件/目录 + 每步模型下拉（静默写 settings）+ 决策按钮。
 * 注册于 conversation.composer（priority -1），仅接管 plan-review 待审批。
 * 数据获取与异步（modelCatalog/canOpenWorkspacePath）在 PaeReviewCardView 薄包装里完成，
 * PaeReviewCard 只收纯数据 props（便于 jsdom 单测）。
 *
 * 注意（2026-08-30 线上事故）：视图不得使用 useChat/useProjection——composer 座位调用
 * useChat 触发宿主聊天快照构建器脱绑崩溃（this.valuesDirty），审批提问不可见导致宿主
 * askOrDismiss 永久挂起。步骤数据一律来自审批问题 detail（parsePlanDetail，自有格式）。
 * @module plan-and-execute/client/PaeReviewCard
 */
import { useEffect, useState, type ReactElement } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClientRemote, JsonValue, ModelCatalog } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only：composer 槽位类型合并（本组件不再消费 useChat/useProjection）。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { CardArgs, ModelOption } from './plan-card.ts'
import { flattenCatalog, optionKey } from './plan-card.ts'
import { PAE_MODELS_NS } from '../state.ts'
import {
  buildSettingsPatch,
  isPlanReviewPending,
  parsePlanDetail,
  questionView,
  type PlanReviewPendingLike,
} from './review-card.ts'
import type { NS } from './locale.ts'

/** 决策答案形状（与宿主 AskUserQuestionAnswer 一致的最小面）。 */
export interface AnswerLike {
  answers: ReadonlyArray<{
    readonly id: string
    readonly selected: readonly string[]
    readonly custom?: string
  }>
}

export interface PaeReviewCardProps {
  readonly sessionId: string
  readonly pending: PlanReviewPendingLike
  readonly args: CardArgs | undefined
  readonly canOpen: boolean
  readonly options: readonly ModelOption[]
  readonly current: { readonly provider: string; readonly model: string }
  readonly openPath: (path: string) => void
  readonly settings: {
    readonly update: (
      ns: string,
      patch: Record<string, JsonValue>,
      rev: number | undefined,
    ) => Promise<unknown>
  }
  readonly t: (key: string) => string
}

/** 审批卡（受控下拉 + 静默写 + 决策按钮，busy/error settle 同宿主 PlanReviewPanel）。 */
export function PaeReviewCard({
  sessionId,
  pending,
  args,
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

  const settle = (send: () => Promise<unknown>): void => {
    setBusy(true)
    setError(null)
    void send().catch((cause: unknown) => {
      setBusy(false)
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }
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
  const onModelChange = (step: number, value: string): void => {
    const next = { ...selection, [step]: value }
    setSelection(next)
    setError(null)
    // 会话标识缺失（极边缘路径）时跳过静默写：决策按钮仍可用，下拉仅本地生效。
    if (sessionId === '') {
      console.warn('[plan-and-execute] 审批卡缺少 sessionId，跳过模型选择保存')
      return
    }
    void settings
      .update(PAE_MODELS_NS, buildSettingsPatch(sessionId, next), undefined)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
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
          {canOpen && args !== undefined ? (
            <span className="pae-header-actions">
              <Button size="sm" aria-label={t('openDir')} onClick={() => openPath(args.planDir)}>
                {t('openDir')}
              </Button>
            </span>
          ) : null}
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
export type ReviewSessionRemoteLike = Pick<
  ClientRemote['session'],
  'modelCatalog' | 'canOpenWorkspacePath' | 'openWorkspacePath'
>

/** settings 远端面：静默写模型选择（Pick 即真实签名）。 */
export type ReviewSettingsRemoteLike = Pick<ClientRemote['settings'], 'update'>

/** 审批卡注入面（注册入口 inject 工厂返回）。 */
export interface PaeReviewCardInjected {
  readonly sessionRemote: ReviewSessionRemoteLike
  readonly settingsRemote: ReviewSettingsRemoteLike
  readonly connection: { readonly isLoopback: boolean }
}

/** conversation.composer 注册入口的完整组件 props（owner + locale + 注入面）。 */
export type PaeReviewCardViewProps = PaeReviewCardInjected &
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
