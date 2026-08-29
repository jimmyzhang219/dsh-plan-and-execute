/**
 * submit_plan 步骤卡片：打开文件/目录 + 每步模型下拉。
 * 数据获取与异步（modelCatalog/canOpenWorkspacePath/prompt）在 SubmitPlanCardView
 * 薄包装里完成，PlanCard 只收纯数据 props（便于 jsdom 单测）。
 * @module plan-and-execute/client/PlanCard
 */
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  ModelCatalog,
  ModelSelectionProjection,
  SessionRequestId,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
// Type-only：session 作用域标准钩子（sessionId/useProjection）与全局标准钩子。
import type {} from '@deepseek-ai/dsh-client-ui-session'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './locale.ts'
import type { CardArgs, ModelOption } from './plan-card.ts'
import {
  buildSetModelsPrompt,
  degradedCardArgs,
  flattenCatalog,
  parseCardArgs,
  resolveCurrentModel,
  serializeStepModels,
} from './plan-card.ts'

/** 下拉拼接值（provider|model）。 */
export function optionKey(option: { readonly provider: string; readonly model: string }): string {
  return `${option.provider}|${option.model}`
}

export interface PlanCardProps {
  /** submit_plan 解析后的参数。 */
  readonly args: CardArgs
  /** 是否可打开宿主路径（isLoopback && canOpenWorkspacePath，由入口计算）。 */
  readonly canOpen: boolean
  /** 模型下拉选项（flattenCatalog 结果）。 */
  readonly options: readonly ModelOption[]
  /** 当前会话模型（resolveCurrentModel 结果）。 */
  readonly current: { readonly provider: string; readonly model: string }
  /** 打开宿主路径（owner openFile）。 */
  readonly openFile: (path: string) => void
  /** 应用模型选择（入口包装：session.prompt 发送命令；成功乐观置位）。 */
  readonly onSubmit: (models: Record<number, { provider: string; model: string }>) => Promise<void>
  /** locale 翻译。 */
  readonly t: (key: string) => string
}

/** 步骤卡片（受控下拉 + 打开按钮）。 */
export function PlanCard({
  args,
  canOpen,
  options,
  current,
  openFile,
  onSubmit,
  t,
}: PlanCardProps): ReactElement {
  const defaultValue = optionKey(current)
  const [selection, setSelection] = useState<Record<number, string>>({})
  const [applied, setApplied] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  // 缺 planDir（旧会话降级载荷）→ 打开路径不可用：目录区与打开按钮都不渲染
  const openable = canOpen && args.planDir !== ''
  const dirty = args.steps.some(
    (_step, index) => (selection[index + 1] ?? defaultValue) !== defaultValue,
  )

  const apply = async (): Promise<void> => {
    try {
      await onSubmit(
        serializeStepModels({ ...defaultSelection(args.steps.length, defaultValue), ...selection }),
      )
      setApplied(true)
      setError(undefined)
    } catch (err) {
      // 提交失败（如 session.prompt 拒绝）：行内报错，不置 applied
      setApplied(false)
      setError(`应用失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return (
    <div data-testid="pae-plan-card">
      {args.planDir !== '' ? (
        <div>
          <strong>
            {t('planDir')}：{args.planDir}
          </strong>
          {canOpen ? (
            <button type="button" aria-label={t('openDir')} onClick={() => openFile(args.planDir)}>
              {t('openDir')}
            </button>
          ) : (
            <span>{args.planDir}</span>
          )}
          {args.summary !== undefined ? <p>{args.summary}</p> : null}
        </div>
      ) : null}
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
              {openable ? (
                <button
                  type="button"
                  aria-label={t('openFile')}
                  onClick={() => openFile(`${args.planDir}/${step.file}`)}
                >
                  {t('openFile')}
                </button>
              ) : null}{' '}
              <select
                aria-label={`model-${i}`}
                value={value}
                onChange={(event) => {
                  setSelection((prev) => ({ ...prev, [i]: event.target.value }))
                  setApplied(false)
                  setError(undefined)
                }}
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
      <button
        type="button"
        aria-label={t('applyModels')}
        disabled={!dirty}
        onClick={() => void apply()}
      >
        {applied ? t('applied') : t('applyModels')}
      </button>
      {error !== undefined ? <p data-testid="pae-apply-error">{error}</p> : null}
    </div>
  )
}

/** 全步默认选择（未改动时逐行等于当前会话模型）。 */
function defaultSelection(count: number, defaultValue: string): Record<number, string> {
  const map: Record<number, string> = {}
  for (let i = 1; i <= count; i++) map[i] = defaultValue
  return map
}

/**
 * session 远端面的最小契约：组件只消费这三个方法，
 * 注册入口传入真实 ClientRemote['session']（Pick 即真实签名，结构赋值零 as）。
 */
export type SessionRemoteLike = Pick<
  ClientRemote['session'],
  'modelCatalog' | 'canOpenWorkspacePath' | 'prompt'
>

/** submit_plan 卡片注入面（注册入口 inject 工厂返回）。 */
export interface SubmitPlanCardInjected {
  readonly sessionRemote: SessionRemoteLike
  readonly connection: { readonly isLoopback: boolean }
}

/** tool.call.toolview（key: submit_plan）注册入口的完整组件 props。 */
export type SubmitPlanCardViewProps = ToolCallViewProps &
  PropsLocale<typeof NS> &
  SubmitPlanCardInjected

/** 从 tool call block 提取 submit_plan 参数（running/settled 两形态）。 */
function parseBlockArgs(block: ToolCallViewProps['block']): CardArgs | undefined {
  const raw = 'kind' in block ? (block.call?.argsRaw ?? '') : block.argsRaw
  if (raw === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // 流式可见截断的 JSON 前缀：按不可解析处理（SkillRow 同款容错）
    return undefined
  }
  // 旧会话载荷缺 planDir：降级为仅步骤列表（打开路径不可用，见 PlanCard 的 planDir 空串门控）
  return parseCardArgs(parsed) ?? degradedCardArgs(parsed)
}

/**
 * submit_plan toolview 薄包装：挂载时取 modelCatalog/canOpenWorkspacePath，
 * useProjection 读会话 modelSelection 投影，组装 PlanCardProps 渲染 PlanCard。
 * onSubmit 通过 session.prompt 排队发送 set-models 命令（prompt 只回 ack）。
 */
export function SubmitPlanCardView({
  block,
  openFile,
  sessionId,
  useProjection,
  t,
  sessionRemote,
  connection,
}: SubmitPlanCardViewProps): ReactElement | null {
  const args = useMemo(() => parseBlockArgs(block), [block])
  // 会话模型投影（真实 ModelSelectionProjection 形状，resolveCurrentModel 消费）。
  const projection: ModelSelectionProjection | undefined = useProjection('modelSelection')
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

  if (args === undefined) return null
  if (catalog === undefined) {
    return (
      <div data-testid="pae-plan-card">
        <span>{args.planDir}</span>
        <span>{t('modelUnavailable')}</span>
      </div>
    )
  }
  return (
    <PlanCard
      args={args}
      canOpen={canOpen && connection.isLoopback}
      options={flattenCatalog(catalog)}
      current={resolveCurrentModel(catalog, projection)}
      openFile={openFile}
      onSubmit={async (models) => {
        await sessionRemote.prompt({
          requestId: crypto.randomUUID() as SessionRequestId,
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: buildSetModelsPrompt(models) }],
        })
      }}
      t={t as (key: string) => string}
    />
  )
}
