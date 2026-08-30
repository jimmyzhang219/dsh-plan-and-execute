/**
 * 审批卡替换的纯函数层（无 React/DOM 依赖，可 node 单测）。
 * @module plan-and-execute/client/review-card
 */
import type { CardArgs } from './plan-card.ts'
import { parseCardArgs, serializeStepModels } from './plan-card.ts'

/** 结构判定面：plan-review 待审批（避免 instanceof 值导入非种子包）。 */
export interface PlanReviewPendingLike {
  readonly kind: 'plan-review'
  readonly key: string
  readonly questions: readonly unknown[]
  readonly answer: (answer: unknown) => Promise<unknown>
  readonly cancel: () => Promise<unknown>
}

/** 结构判定：kind==='plan-review' 且具备 answer/cancel/questions 即命中。 */
export function isPlanReviewPending(value: unknown): value is PlanReviewPendingLike {
  if (typeof value !== 'object' || value === null) return false
  const v = value as { kind?: unknown; answer?: unknown; cancel?: unknown; questions?: unknown }
  return (
    v.kind === 'plan-review' &&
    typeof v.answer === 'function' &&
    typeof v.cancel === 'function' &&
    Array.isArray(v.questions)
  )
}

/** 审批卡决策面（首个问题的 id/标题/选项）。 */
export interface ReviewView {
  readonly id: string
  readonly question: string
  readonly options: ReadonlyArray<{ readonly label: string; readonly description?: string }>
}

/** 从问题载荷提取决策面；形状不符返回 undefined。 */
export function questionView(
  questions: readonly unknown[],
): ReviewView | undefined {
  const q = questions[0] as {
    id?: unknown
    question?: unknown
    options?: unknown
  } | undefined
  if (typeof q?.id !== 'string' || typeof q?.question !== 'string') return undefined
  if (!Array.isArray(q.options)) return undefined
  const options: Array<ReviewView['options'][number]> = []
  for (const o of q.options) {
    const entry = o as { label?: unknown; description?: unknown } | null
    if (typeof entry?.label !== 'string') continue
    options.push({
      label: entry.label,
      ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
    })
  }
  if (options.length === 0) return undefined
  return { id: q.id, question: q.question, options }
}

/** 下拉选择 → settings.update 载荷（sessionId 键 + 完整修改后映射）。 */
export function buildSettingsPatch(
  sessionId: string,
  selection: Readonly<Record<number, string>>,
): Record<string, Record<number, { provider: string; model: string }>> {
  return { [sessionId]: serializeStepModels(selection) }
}

/**
 * 从 chat 快照取最新 submit_plan 调用参数。
 * 遍历 conversation 树找 tool-call 节点（toolName==='submit_plan'，取最后出现者），
 * 读 argsRaw 经 parseCardArgs 解析。节点形状以宿主
 * packages/client/ui-chat/src/client/conversation-nodes（ToolCallBlock）为准：
 * ChatNode<'tool-call'> = ChatConversationViewNode & { kind: 'tool-call', data: { root } }；
 * root 为 RunningToolCall（name/argsRaw 顶层）或 ToolResultNode（call 回填 name/argsRaw），
 * 两者都以 subCalls 递归持有子调用。找不到或形状不符返回 undefined
 * （卡片退化为仅决策按钮）。
 */
export function findLatestSubmitPlanArgs(chat: unknown): CardArgs | undefined {
  if (typeof chat !== 'object' || chat === null) return undefined
  const values = (chat as { nodes?: { values?: unknown } }).nodes?.values
  if (typeof values !== 'function') return undefined
  let latestRaw: string | undefined
  // 递归遍历 ToolCallBlock 树（root + subCalls）：running/settled 两形态各取 name/argsRaw。
  const visit = (block: unknown): void => {
    if (typeof block !== 'object' || block === null) return
    const b = block as { name?: unknown; argsRaw?: unknown; call?: unknown; subCalls?: unknown }
    const name = typeof b.name === 'string' ? b.name : (b.call as { name?: unknown } | null)?.name
    const raw =
      typeof b.argsRaw === 'string' ? b.argsRaw : (b.call as { argsRaw?: unknown } | null)?.argsRaw
    if (name === 'submit_plan' && typeof raw === 'string') latestRaw = raw
    if (Array.isArray(b.subCalls)) for (const child of b.subCalls) visit(child)
  }
  for (const node of (values as () => readonly unknown[])()) {
    if (typeof node !== 'object' || node === null) continue
    const n = node as { kind?: unknown; data?: unknown }
    if (n.kind !== 'tool-call') continue
    visit((n.data as { root?: unknown } | null)?.root)
  }
  if (latestRaw === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(latestRaw)
  } catch {
    // 流式可见截断的 JSON 前缀：按不可解析处理（PlanCard 同款容错）
    return undefined
  }
  return parseCardArgs(parsed)
}
