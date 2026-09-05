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
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute))
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
 * 格式：首行 `计划目录：<planDir>`，后续行 `N. <标题> — <文件>[ ⚠ 确认点]`；
 * 执行排期行协议：`执行排期：YYYY-MM-DD HH:mm`（本地时间，与服务端 formatScheduleAt
 * 同格式，见 parseScheduleAt）——解析成功即作为 scheduledAt 回显，畸形行跳过不打断其他行。
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

/**
 * 批准载荷排期编码前缀（服务端 state.ts 的 decodeApprovalSchedule 同协议双写——
 * 两侧字符串常量各自维护，不能值互 import，改动须两侧同步）。
 * 值形态：`<前缀>now` 或 `<前缀>at:<epochMs>`。
 */
const PAE_SCHEDULE_PREFIX = 'paeSchedule:'

/**
 * 批准时构造排期载荷（planning 首卡与 scheduled 回显卡的差异编码）。
 * @param when - 卡片当前选择：null=立即执行；number=指定时刻。
 * @param hadScheduledAt - detail 解析出的原排期（undefined=首卡）。
 * @returns answer custom 载荷；undefined=不携带排期编码。
 */
export function encodeApprovalSchedule(
  when: number | null,
  hadScheduledAt: number | undefined,
): string | undefined {
  // 首卡（无原排期）：默认立即执行不携带编码；指定时刻才编码。
  // 回显卡：清为立即 → now；保持原排期（同值）→ 不携带；新时刻 → at。
  if (when === null) return hadScheduledAt === undefined ? undefined : `${PAE_SCHEDULE_PREFIX}now`
  if (when === hadScheduledAt) return undefined
  return `${PAE_SCHEDULE_PREFIX}at:${when}`
}

/** 排期浮层相对视口的 fixed 定位结果（left/top 均为 px）。 */
export interface PickerPlacement {
  /** 面板左缘距视口左缘（px）。 */
  readonly left: number
  /** 面板顶缘距视口顶缘（px）。 */
  readonly top: number
}

/**
 * 计算排期浮层面板相对视口的 fixed 定位：默认挂在锚点（chip）下方；下方放不下
 * 且上方空间足够时向上翻转；两侧都不足时贴视口底边兜底。水平方向以锚点左缘
 * 对齐，右缘溢出视口时左收（clamp）。返回的四舍五入到整数 px。
 * @param anchor - 锚点（chip）相对视口的矩形：left/top/bottom 与 width。
 * @param panel - 面板实测尺寸（width/height）。
 * @param viewport - 视口尺寸（innerWidth/innerHeight）。
 * @param gap - 面板与锚点的垂直间距（px，默认 4）。
 * @returns fixed 定位的 left/top。
 */
export function placeSchedulePicker(
  anchor: { left: number; bottom: number; top: number; width: number },
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = 4,
): PickerPlacement {
  // 默认锚点下方；右缘放不下时把 left 收进视口（两边各留 4px 呼吸）
  const left = Math.min(Math.max(anchor.left, 4), viewport.width - panel.width - 4)
  const belowTop = anchor.bottom + gap
  let top = belowTop
  if (belowTop + panel.height > viewport.height - 4) {
    // 下方放不下：上方空间足够（顶距 ≥4）→ 上翻；否则贴底兜底（不遮锚点上越界）
    top =
      anchor.top - gap - panel.height >= 4
        ? anchor.top - gap - panel.height
        : Math.max(4, viewport.height - panel.height - 4)
  }
  return { left: Math.round(left), top: Math.round(top) }
}
