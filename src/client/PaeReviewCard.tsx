/**
 * plan-review 审批卡替换：步骤打开文件/目录 + 每步模型下拉（静默写 settings）+ 决策按钮。
 * 注册于 conversation.composer（priority -1），仅接管 plan-review 待审批。
 * 数据获取与异步（modelCatalog/canOpenWorkspacePath/useChat/useProjection）在
 * PaeReviewCardView 薄包装里完成，PaeReviewCard 只收纯数据 props（便于 jsdom 单测）。
 * @module plan-and-execute/client/PaeReviewCard
 */
import { useEffect, useState, type ReactElement } from 'react'
import type { ClientRemote, JsonValue, ModelCatalog, ModelSelectionProjection } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { UseChat } from '@deepseek-ai/dsh-client-ui-chat/client'
// Type-only：会话作用域标准钩子（sessionId/useProjection）与 composer 槽位/useChat 合并。
import type {} from '@deepseek-ai/dsh-client-ui-session'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { CardArgs, ModelOption } from './plan-card.ts'
import { flattenCatalog, resolveCurrentModel } from './plan-card.ts'
import { optionKey } from './PlanCard.tsx'
import { PAE_MODELS_NS } from '../state.ts'
import { buildSettingsPatch, findLatestSubmitPlanArgs, isPlanReviewPending, questionView, type PlanReviewPendingLike } from './review-card.ts'
import type { NS } from './locale.ts'

/** 决策答案形状（与宿主 AskUserQuestionAnswer 一致的最小面）。 */
export interface AnswerLike {
  answers: ReadonlyArray<{ readonly id: string; readonly selected: readonly string[]; readonly custom?: string }>
}

export interface PaeReviewCardProps {
  readonly sessionId: string
  readonly pending: PlanReviewPendingLike
  readonly args: CardArgs | undefined
  readonly canOpen: boolean
  readonly options: readonly ModelOption[]
  readonly current: { readonly provider: string; readonly model: string }
  readonly openPath: (path: string) => void
  readonly settings: { readonly update: (ns: string, patch: Record<string, JsonValue>, rev: number | undefined) => Promise<unknown> }
  readonly t: (key: string) => string
}

/** 审批卡（受控下拉 + 静默写 + 决策按钮，busy/error settle 同宿主 PlanReviewPanel）。 */
export function PaeReviewCard({
  sessionId, pending, args, canOpen, options, current, openPath, settings, t,
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
      { id: review.id, selected: [label], ...(custom === undefined || custom === '' ? {} : { custom }) },
    ]
    settle(() => pending.answer({ answers }))
  }
  const onModelChange = (step: number, value: string): void => {
    const next = { ...selection, [step]: value }
    setSelection(next)
    setError(null)
    void settings.update(PAE_MODELS_NS, buildSettingsPatch(sessionId, next), undefined).catch(
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    )
  }

  return (
    <section data-testid="pae-review-card" aria-label={review?.question ?? 'plan review'}>
      <header>
        <strong>{t('planReview')}</strong>
        {args?.summary !== undefined ? <p>{args.summary}</p> : null}
        {canOpen && args !== undefined ? (
          <button type="button" aria-label={t('openDir')} onClick={() => openPath(args.planDir)}>
            {t('openDir')}
          </button>
        ) : null}
      </header>
      {args === undefined ? null : (
        <ol>
          {args.steps.map((step, index) => {
            const i = index + 1
            const value = selection[i] ?? defaultValue
            return (
              <li key={step.file}>
                <span>
                  {i}. {step.title}
                  {step.requiresConfirmation === true ? ' ⚠' : ''}
                </span>{' '}
                <code>{step.file}</code>{' '}
                {canOpen ? (
                  <button type="button" aria-label={t('openFile')} onClick={() => openPath(`${args.planDir}/${step.file}`)}>
                    {t('openFile')}
                  </button>
                ) : null}{' '}
                <select
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
      <label>
        {t('feedback')}
        <textarea
          value={feedback}
          onChange={(event) => setFeedback(event.target.value)}
          placeholder={t('feedbackHint')}
        />
      </label>
      <div role="status">{error}</div>
      <footer>
        <button type="button" disabled={busy} onClick={() => { settle(() => pending.cancel()) }}>
          {t('discuss')}
        </button>
        {review?.options.map((option) => (
          <button
            key={option.label}
            type="button"
            disabled={busy}
            title={option.description}
            onClick={() => decide(option.label, feedback)}
          >
            {option.label}
          </button>
        ))}
      </footer>
    </section>
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

/** conversation.composer 注册入口的完整组件 props（owner + 标准钩子 + locale + 注入面）。 */
export type PaeReviewCardViewProps = PaeReviewCardInjected &
  PropsLocale<typeof NS> & {
    /** 会话标识（composer owner props；与宿主 agent.id 同源，见集成点核）。 */
    readonly sessionId: SessionId | undefined
    /** 当前会话待审批交互（owner props；结构判定见 isPlanReviewPending）。 */
    readonly pendingInteraction: unknown
    /** Chat 快照选择器（SessionStandardProps.useChat，宿主 ui-chat 标准钩子）。 */
    readonly useChat: UseChat
    /** 会话投影选择器（SessionStandardProps.useProjection）。 */
    readonly useProjection: (key: string) => unknown
  }

/**
 * plan-review 审批卡薄包装：挂载时取 modelCatalog/canOpenWorkspacePath，
 * useChat 快照找最新 submit_plan 参数，useProjection 读会话模型投影，
 * 组装 PaeReviewCardProps 渲染 PaeReviewCard；openPath 走 session.openWorkspacePath。
 */
export function PaeReviewCardView({
  sessionId,
  pendingInteraction,
  useChat,
  useProjection,
  t,
  sessionRemote,
  settingsRemote,
  connection,
}: PaeReviewCardViewProps): ReactElement | null {
  // 全部 hooks 无条件先执行（Rules of Hooks）：chain 只在 select 命中时渲染本组件，
  // 下面的早退仅为类型收窄与防御（pending 清空时 chain 已改选宿主入口）
  const args = useChat((snapshot) => findLatestSubmitPlanArgs(snapshot))
  // 会话模型投影（真实 ModelSelectionProjection 形状，resolveCurrentModel 消费）
  const projection: ModelSelectionProjection | undefined = useProjection('modelSelection') as
    | ModelSelectionProjection
    | undefined
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
  if (!isPlanReviewPending(pendingInteraction) || sessionId === undefined) return null
  const pending = pendingInteraction

  return (
    <PaeReviewCard
      sessionId={sessionId}
      pending={pending}
      args={args}
      canOpen={canOpen && connection.isLoopback}
      // 目录未就绪时先渲染决策按钮（选项空）；就绪后下拉出现（提交按钮不依赖目录）
      options={catalog === undefined ? [] : flattenCatalog(catalog)}
      current={catalog === undefined ? { provider: '', model: '' } : resolveCurrentModel(catalog, projection)}
      openPath={(path) => sessionRemote.openWorkspacePath({ path })}
      settings={{ update: settingsRemote.update }}
      t={t as (key: string) => string}
    />
  )
}
