/**
 * 审批卡替换的纯函数层（无 React/DOM 依赖，可 node 单测）。
 * @module dsh-plan-and-execute/client/review-card
 */
import type { CardArgs } from './plan-card.ts'
import { serializeStepModels } from './plan-card.ts'

/** 结构判定面：plan-review 待审批（避免 instanceof 值导入非种子包）。 */
export interface PlanReviewPendingLike {
  readonly kind: 'plan-review'
  readonly key: string
  /** 宿主 PendingQuestion 自带会话标识（composer owner sessionId 缺失时回退）。 */
  readonly sessionId?: string
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

/** 审批卡决策面（首个问题的 id/标题/选项/详情文本）。 */
interface ReviewView {
  readonly id: string
  readonly question: string
  readonly options: ReadonlyArray<{ readonly label: string; readonly description?: string }>
  /** 问题详情文本（planReviewDetail 输出；步骤数据来源）。 */
  readonly detail?: string
}

/** 从问题载荷提取决策面；形状不符返回 undefined。 */
export function questionView(questions: readonly unknown[]): ReviewView | undefined {
  const q = questions[0] as
    | {
        id?: unknown
        question?: unknown
        options?: unknown
        detail?: unknown
      }
    | undefined
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
  return {
    id: q.id,
    question: q.question,
    options,
    ...(typeof q.detail === 'string' ? { detail: q.detail } : {}),
  }
}

/** detail 排期行前缀（与服务端 prompts.ts 的 SCHEDULE_LINE_PREFIX 保持同步；client 不能值导入宿主侧模块）。 */
const SCHEDULE_LINE_PREFIX = '执行排期：'

/**
 * 本地 'YYYY-MM-DD HH:mm' → epoch ms（与服务端 formatScheduleAt 同一本地语义）。
 * @param text - 排期行文本值。
 * @returns epoch ms；格式非法返回 undefined。
 */
export function parseScheduleAt(text: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(text.trim())
  if (match === null) return undefined
  const [, year, month, day, hour, minute] = match
  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
  )
  // 构造结果与输入不一致（如 2026-13-05 溢出进位）视为非法
  if (
    date.getFullYear() !== Number(year) ||
    date.getMonth() !== Number(month) - 1 ||
    date.getDate() !== Number(day) ||
    date.getHours() !== Number(hour) ||
    date.getMinutes() !== Number(minute)
  ) {
    return undefined
  }
  return date.getTime()
}

/**
 * 从审批问题详情（宿主 planReviewDetail 输出，本插件自有格式）解析步骤数据。
 * 格式：首行 `计划目录：<planDir>`，后续行 `N. <标题> — <文件>[ ⚠ 确认点]`。
 * 标题可含 " — "（以最后一个分隔符切分）；非标准行跳过；缺计划目录行返回 undefined。
 * 注意：审批卡不读 chat 快照（composer 座位 useChat 会导致宿主聊天快照
 * 构建器脱绑崩溃——2026-08-30 线上事故），步骤数据一律来自本函数。
 */
export function parsePlanDetail(detail: string): CardArgs | undefined {
  const lines = detail.split('\n')
  const first = lines[0]?.trim() ?? ''
  if (!first.startsWith('计划目录：')) return undefined
  const planDir = first.slice('计划目录：'.length).trim()
  if (planDir === '') return undefined
  const steps: Array<CardArgs['steps'][number]> = [] // ReadonlyArray 无 push
  let scheduledAt: number | undefined
  for (const line of lines.slice(1)) {
    const trimmed = line.trim()
    if (trimmed.startsWith(SCHEDULE_LINE_PREFIX)) {
      scheduledAt = parseScheduleAt(trimmed.slice(SCHEDULE_LINE_PREFIX.length))
      // 解析成功则此行使 scheduledAt 有值；失败保持 undefined（不打断其他行）
      continue
    }
    const match = /^(\d+)\. (.+) — (.+?)( ⚠ 确认点)?$/.exec(trimmed)
    if (match === null) continue
    // noUncheckedIndexedAccess：正则保证分组 2-3 非空，解构默认值仅为类型收窄
    const [, , title = '', file = '', mark] = match
    steps.push({
      file,
      title,
      ...(mark === undefined ? {} : { requiresConfirmation: true }),
    })
  }
  return { planDir, steps, ...(scheduledAt === undefined ? {} : { scheduledAt }) }
}

/** 下拉选择 → settings.update 载荷（sessionId 键 + 完整修改后映射）。 */
export function buildSettingsPatch(
  sessionId: string,
  selection: Readonly<Record<number, string>>,
): Record<string, Record<number, { provider: string; model: string }>> {
  return { [sessionId]: serializeStepModels(selection) }
}

/** 排期意图 → settings.update 载荷（sessionId 键；null=立即执行）。 */
export function buildSchedulePatch(
  sessionId: string,
  at: number | null,
): Record<string, { at: number | null }> {
  return { [sessionId]: { at } }
}
