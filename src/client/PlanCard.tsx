/**
 * submit_plan 步骤卡片：打开文件/目录（纯展示；模型选择唯一入口 = 审批卡）。
 * 数据获取与异步（canOpenWorkspacePath）在 SubmitPlanCardView 薄包装里完成，
 * PlanCard 只收纯数据 props（便于 jsdom 单测）。
 * @module plan-and-execute/client/PlanCard
 */
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
// Type-only：session 作用域标准钩子（sessionId/useProjection）与全局标准钩子。
import type {} from '@deepseek-ai/dsh-client-ui-session'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './locale.ts'
import type { CardArgs } from './plan-card.ts'
import { degradedCardArgs, parseCardArgs } from './plan-card.ts'

/** 下拉拼接值（provider|model）——供 PaeReviewCard 审批卡每步模型下拉复用。 */
export function optionKey(option: { readonly provider: string; readonly model: string }): string {
  return `${option.provider}|${option.model}`
}

export interface PlanCardProps {
  /** submit_plan 解析后的参数。 */
  readonly args: CardArgs
  /** 是否可打开宿主路径（isLoopback && canOpenWorkspacePath，由入口计算）。 */
  readonly canOpen: boolean
  /** 打开宿主路径（owner openFile）。 */
  readonly openFile: (path: string) => void
  /** locale 翻译。 */
  readonly t: (key: string) => string
}

/** 步骤卡片（纯展示：步骤行 + 打开文件/目录按钮）。 */
export function PlanCard({ args, canOpen, openFile, t }: PlanCardProps): ReactElement {
  // 缺 planDir（旧会话降级载荷）→ 打开路径不可用：目录区与打开按钮都不渲染
  const openable = canOpen && args.planDir !== ''
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
              ) : null}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

/**
 * session 远端面的最小契约：组件只消费这一个方法，
 * 注册入口传入真实 ClientRemote['session']（Pick 即真实签名，结构赋值零 as）。
 */
export type SessionRemoteLike = Pick<ClientRemote['session'], 'canOpenWorkspacePath'>

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
 * submit_plan toolview 薄包装：挂载时取 canOpenWorkspacePath，
 * 组装 PlanCardProps 渲染 PlanCard（纯展示；模型选择唯一入口 = 审批卡）。
 */
export function SubmitPlanCardView({
  block,
  openFile,
  t,
  sessionRemote,
  connection,
}: SubmitPlanCardViewProps): ReactElement | null {
  const args = useMemo(() => parseBlockArgs(block), [block])
  const [canOpen, setCanOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    void sessionRemote
      .canOpenWorkspacePath()
      .then((result) => {
        if (cancelled) return
        if (result.ok) setCanOpen(result.value)
      })
      .catch(() => {
        // 装配/连接故障：canOpen 保持 false → 无打开按钮（卡片仍渲染步骤，不白屏）
      })
    return () => {
      cancelled = true
    }
  }, [sessionRemote])

  if (args === undefined) return null
  return (
    <PlanCard
      args={args}
      canOpen={canOpen && connection.isLoopback}
      openFile={openFile}
      t={t as (key: string) => string}
    />
  )
}
