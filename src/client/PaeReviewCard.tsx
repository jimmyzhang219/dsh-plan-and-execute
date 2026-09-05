/**
 * plan-review 审批卡替换：步骤打开文件/目录 + 每步模型下拉（静默写 settings）+ 决策按钮。
 * 注册于 conversation.composer（priority -1），仅接管 plan-review 待审批。
 * 数据获取与异步（modelCatalog/canOpenWorkspacePath）在 PaeReviewCardView 薄包装里完成，
 * PaeReviewCard 只收纯数据 props（便于 jsdom 单测）。
 *
 * 注意（2026-08-30 线上事故）：视图不得使用 useChat/useProjection——composer 座位调用
 * useChat 触发宿主聊天快照构建器脱绑崩溃（this.valuesDirty），审批提问不可见导致宿主
 * askOrDismiss 永久挂起。步骤数据一律来自审批问题 detail（parsePlanDetail，自有格式）。
 *
 * 排期交互（Wave 3 验收定案）：chip 点开浮层（两态分段 + 日历 + 时/分）选时间，全部
 * 本地状态、零后端调用（不再写 pae-schedule settings）；「批准」时经 encodeApprovalSchedule
 * 把排期意图随答案 custom 传回。日历控件用 react-day-picker@9.14.0（tsup 打进 client
 * bundle）：不引入其 package css（无 css 管线），不依赖 date-fns locale，样式全部
 * classNames + 本文件同目录 styles.ts 自绘。
 * @module dsh-plan-and-execute/client/PaeReviewCard
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
// react-dom 是 client 种子词（运行时由宿主提供）：浮层经 portal 渲染到 document.body，
// 脱离 .pae-card overflow:hidden 的裁剪范围（fixed 浮层由坐标计算控制，见 placeSchedulePicker）。
import { createPortal } from 'react-dom'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClientRemote, ModelCatalog } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only：composer 槽位类型合并（本组件不再消费 useChat/useProjection）。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { DayPicker } from 'react-day-picker'
import type { CaptionLabelProps, WeekdayProps } from 'react-day-picker'
import type { CardArgs, ModelOption } from './plan-card.ts'
import { flattenCatalog, optionKey } from './plan-card.ts'
import { PAE_MODELS_NS } from '../state.ts'
import {
  buildSettingsPatch,
  encodeApprovalSchedule,
  isPlanReviewPending,
  parsePlanDetail,
  placeSchedulePicker,
  questionView,
  type PlanReviewPendingLike,
  type PickerPlacement,
} from './review-card.ts'
import { zh as zhTexts, type NS } from './locale.ts'

/** 中文星期单字（数组下标 = Date.getDay()：0=周日 → 「日」…6=周六 → 「六」）。 */
const ZH_WEEKDAY = ['日', '一', '二', '三', '四', '五', '六']
/** 英文星期缩写（数组下标 = Date.getDay()；列序由 weekStartsOn=1 的日期序列决定）。 */
const EN_WEEKDAY = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
/** 英文月份全称（数组下标 = month - 1；中文月份走 zh 文案拼写，不经 date-fns locale）。 */
const EN_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

/**
 * CaptionLabel 覆盖：react-day-picker@9.14 的 CaptionLabel 组件不接收日期（文案以
 * children 传入、且默认携带 role=status 会与卡内排期状态行重复播报），因此本覆盖渲染
 * 净化的 <span>（丢弃 role/aria-live，保留 className 供样式与测试定位）——中文月份
 * 文案（如「2026年9月」）由下方 formatCaption formatter 计算进 children（formatter
 * 才持有展示月 Date，见 DayPicker 内部装配）。
 */
function PaeCaptionLabel(props: CaptionLabelProps): ReactElement {
  return <span className={props.className}>{props.children}</span>
}

/**
 * Weekday 覆盖：同 CaptionLabel 情形，@9.14 的 Weekday 不接收星期序号（单字文案以
 * children 传入），本覆盖保持 <th> 语义透传——中文单字（周一开头 一…日）由下方
 * formatWeekdayName formatter 计算进 children。
 */
function PaeWeekday({ children, ...rest }: WeekdayProps): ReactElement {
  return <th {...rest}>{children}</th>
}

/** 决策答案形状（与宿主 AskUserQuestionAnswer 一致的最小面）。 */
interface AnswerLike {
  answers: ReadonlyArray<{
    readonly id: string
    readonly selected: readonly string[]
    readonly custom?: string
  }>
}

/** 浮层锚点：chip 打开时刻相对视口的矩形快照（placeSchedulePicker 的 anchor 入参）。 */
interface PickerAnchor {
  readonly left: number
  readonly top: number
  readonly bottom: number
  readonly width: number
}

/**
 * JSON 值（settings 通道载荷类型）。宿主侧定义于 dsh-util-values，
 * 该包运行时由 dsh 进程提供、不随本插件安装，故在此本地复刻，
 * 语义与宿主一致（见 review-card.ts 的 buildSettingsPatch 载荷）。
 */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** epoch ms → 本地 'YYYY-MM-DD HH:mm'（chip/状态行显示；与服务端 formatScheduleAt 同格式）。 */
function formatLocal(at: number): string {
  const d = new Date(at)
  const pad = (v: number): string => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** epoch ms → 日历选中日（本地零点）与 时/分 三份本地值（at 草稿拆分）。 */
function splitLocal(at: number): { day: Date; hour: number; minute: number } {
  const d = new Date(at)
  return {
    day: new Date(d.getFullYear(), d.getMonth(), d.getDate()),
    hour: d.getHours(),
    minute: d.getMinutes(),
  }
}

/** 日历日 + 时/分 → epoch ms（本地时刻；day 缺省返回 undefined）。 */
function composeAt(day: Date | undefined, hour: number, minute: number): number | undefined {
  if (day === undefined) return undefined
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute).getTime()
}

/** at 模式默认草稿：now+1h 取整到分（跨天进位由 Date 构造自然处理；必晚于当前时刻）。 */
function defaultDraftAt(now: number): number {
  return Math.floor((now + 3_600_000) / 60_000) * 60_000
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
  /** 静默写 settings 通道（模型选择持久化；排期已不走此通道）。 */
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
  /** 排期选择（本地态）：null=立即执行；number=指定时刻。 */
  const [when, setWhen] = useState<number | null>(scheduledAt ?? null)
  /** 浮层开合（chip 点击切换；草稿经「确定」才写回 when）。 */
  const [open, setOpen] = useState(false)
  /** 浮层锚点：chip 打开时刻的视口矩形（null=未展开；失焦/滚动关闭时一并清空）。 */
  const [anchor, setAnchor] = useState<PickerAnchor | null>(null)
  /** 浮层面板 fixed 定位坐标（anchor + 面板实测尺寸经 placeSchedulePicker 计算）。 */
  const [placement, setPlacement] = useState<PickerPlacement | null>(null)
  /** chip 控件组 ref：打开时测量锚点矩形 + 失焦关闭的命中判定。 */
  const chipRef = useRef<HTMLSpanElement | null>(null)
  /** 浮层面板 ref：portal 内实测尺寸 + 失焦关闭的命中判定。 */
  const panelRef = useRef<HTMLDivElement | null>(null)
  /** 浮层两态：'immediate'=立即执行；'at'=指定时间（日历 + 时/分）。 */
  const [mode, setMode] = useState<'immediate' | 'at'>('immediate')
  /** at 态草稿：日历选中日（本地零点；未选=undefined 提示 scheduleHint）。 */
  const [draftDay, setDraftDay] = useState<Date | undefined>(undefined)
  /** at 态草稿：时（0-23）。 */
  const [draftHour, setDraftHour] = useState(0)
  /** at 态草稿：分（0-59）。 */
  const [draftMinute, setDraftMinute] = useState(0)

  /** 决策提交包装：置 busy、清错误；send 抛错时折叠为卡片内错误文案。 */
  const settle = (send: () => Promise<unknown>): void => {
    setBusy(true)
    setError(null)
    void send().catch((cause: unknown) => {
      setBusy(false)
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }
  /**
   * 决策按钮点击：批准 → custom 仅承载排期载荷编码（encodeApprovalSchedule，
   * 反馈文本只随「继续修改」）；继续修改 → 反馈文本（trim 后空则省略）。
   */
  const decide = (label: string): void => {
    if (review === undefined) return
    const custom =
      label === '批准'
        ? // 原排期以顶层 scheduledAt prop 为准（与 when 初值同源；生产取值即
          // View 从 detail 解析透传的 args.scheduledAt——见组件契约注释）
          encodeApprovalSchedule(when, scheduledAt)
        : feedback.trim() === ''
          ? undefined
          : feedback.trim()
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

  /** 按时刻填充 at 草稿（日历日 + 时/分）。 */
  const seedDraft = (at: number): void => {
    const parts = splitLocal(at)
    setDraftDay(parts.day)
    setDraftHour(parts.hour)
    setDraftMinute(parts.minute)
  }
  /** 浮层关闭态 → 草稿无效标记：让下次展开按 mode 重新播种（不提交即丢弃）。 */
  const resetDraft = (): void => {
    setDraftDay(undefined)
  }
  /** 两态切换（进入 at 且草稿未播种时：已排期=原时刻；未排期=now+1h 默认草稿）。 */
  const enterMode = (next: 'immediate' | 'at'): void => {
    setMode(next)
    if (next === 'at' && draftDay === undefined) {
      if (when !== null) seedDraft(when)
      else seedDraft(defaultDraftAt(Date.now()))
    }
  }
  /** 收起浮层（chip 再点 / 失焦 pointerdown / resize·scroll 共用）：丢弃草稿并清锚点。 */
  const dismissPicker = (): void => {
    setOpen(false)
    setAnchor(null)
    resetDraft()
  }
  /** chip 点击：展开时先测 chip 视口矩形作锚点，再按 when 播种两态与草稿（零后端调用）。 */
  const togglePicker = (): void => {
    if (open) {
      dismissPicker()
      return
    }
    const chip = chipRef.current
    if (chip === null) return
    const rect = chip.getBoundingClientRect()
    setAnchor({ left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width })
    setMode(when === null ? 'immediate' : 'at')
    if (when !== null) seedDraft(when)
    setOpen(true)
  }
  /** 日历选中：只更新草稿日期（时/分保留在 select 中）。 */
  const onSelectDay = (day: Date | undefined): void => {
    setDraftDay(
      day === undefined ? undefined : new Date(day.getFullYear(), day.getMonth(), day.getDate()),
    )
  }
  /** at 草稿完整时刻（本地）；日未选 → undefined（提示 scheduleHint）。 */
  const draftAt = composeAt(draftDay, draftHour, draftMinute)
  /** at 草稿是否合法（晚于当前时刻）。 */
  const draftReady = draftAt !== undefined && draftAt > Date.now()
  /** 浮层状态行修饰类：合法=--ok、过去=--err、immediate/不完整=无。 */
  const draftStatusMod =
    mode === 'immediate' ? '' : draftAt === undefined ? '' : draftReady ? '--ok' : '--err'
  /** 浮层状态行文案：immediate=即时提示；at 完整未来=绿色预览；at 过去=红错；未选日=弱化提示。 */
  const draftStatusText =
    mode === 'immediate'
      ? t('scheduleImmediate')
      : draftAt === undefined
        ? t('scheduleHint')
        : draftReady
          ? t('schedulePreview').replace('%s', formatLocal(draftAt))
          : t('schedulePast')
  /** 「确定」收口（本地）：immediate → when=null（清排期）；at 合法 → when=草稿。关浮层。 */
  const commitSchedule = (): void => {
    if (mode === 'immediate') {
      setWhen(null)
    } else {
      if (draftAt === undefined || !draftReady) return
      setWhen(draftAt)
    }
    setOpen(false)
    setAnchor(null)
    resetDraft()
    setError(null)
  }
  /** 清除排期（chip ×）：仅本地清 when=null（排期意图在批准时随载荷传达）。 */
  const clearSchedule = (): void => {
    setWhen(null)
    setOpen(false)
    setAnchor(null)
    resetDraft()
    setError(null)
  }

  /**
   * 浮层坐标：面板挂载后（portal 子树就绪）在布局阶段实测尺寸，结合锚点矩形经
   * placeSchedulePicker 得 fixed 定位写回 style——保证首帧即到位、无错位闪动。
   * 面板高度随两态/日历选中（mode/draftDay）变化，重算防越界；值不变则保留
   * 原引用避免无谓重渲染。
   */
  useLayoutEffect(() => {
    if (!open || anchor === null || panelRef.current === null) return
    const rect = panelRef.current.getBoundingClientRect()
    const next = placeSchedulePicker(
      anchor,
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight },
    )
    setPlacement((prev) =>
      prev !== null && prev.left === next.left && prev.top === next.top ? prev : next,
    )
  }, [open, anchor, mode, draftDay])

  /**
   * 失焦/位移收口：仅浮层打开期间挂监听（关闭即卸载清理，成对 add/remove）。
   * pointerdown 用 capture 在 document 先于卡内其他处理器判定；命中面板/chip 内
   * 不关（面板内交互经原生 pointerdown→click 序列，chip 收起由再点负责）。
   * resize 与任意元素 scroll（capture 捕获不冒泡的 scroll）也收口，防锚点错位。
   */
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (
        target instanceof Node &&
        (panelRef.current?.contains(target) === true || chipRef.current?.contains(target) === true)
      ) {
        return
      }
      dismissPicker()
    }
    const onViewportChange = (): void => dismissPicker()
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('resize', onViewportChange)
    window.addEventListener('scroll', onViewportChange, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('resize', onViewportChange)
      window.removeEventListener('scroll', onViewportChange, true)
    }
  }, [open, anchor])

  // —— 日历中文本地化（不经 date-fns locale；语言按 t 的 approve 输出判定）——
  const zhLocale = t('approve') === zhTexts.approve
  /** 展示月 caption：zh「2026年9月」/ en「September 2026」。 */
  const formatCaption = (date: Date): string =>
    zhLocale
      ? `${date.getFullYear()}年${date.getMonth() + 1}月`
      : `${EN_MONTHS[date.getMonth()]} ${date.getFullYear()}`
  /** 星期表头单字：zh 一二三四五六日（周一开头）；en Mo..Su（按日期的 getDay 取字）。 */
  const formatWeekdayName = (date: Date): string =>
    zhLocale ? ZH_WEEKDAY[date.getDay()]! : EN_WEEKDAY[date.getDay()]!
  /** 今天（本地零点）：日历禁用早于今天的所有日期。 */
  const startOfToday = ((): Date => {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth(), now.getDate())
  })()

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
            <span className="pae-schedule" ref={chipRef}>
              {/* chip：显示当前选择（立即执行 / 计划于 …）；点击开/关浮层 */}
              <Button
                size="sm"
                variant={when === null ? 'outline' : 'toolbar'}
                className="pae-schedule-toggle"
                aria-expanded={open}
                onClick={togglePicker}
              >
                {when === null
                  ? t('immediateMode')
                  : t('scheduleAtChip').replace('%s', formatLocal(when))}
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
              {open
                ? // 浮层经 portal 渲染到 document.body：脱离 .pae-card overflow:hidden 裁剪范围；
                  // fixed 定位坐标由 useLayoutEffect 实测面板后按锚点计算（placement），写回 style
                  createPortal(
                    <div
                      className="pae-schedule-picker"
                      data-testid="schedule-picker"
                      ref={panelRef}
                      style={
                        placement === null
                          ? undefined
                          : {
                              position: 'fixed',
                              left: placement.left,
                              top: placement.top,
                              zIndex: 1000,
                            }
                      }
                    >
                      {/* 两态分段：立即执行（确定=清排期）/ 指定时间（日历 + 时/分） */}
                      <div className="pae-schedule-modes" role="group" aria-label={t('atMode')}>
                        <button
                          type="button"
                          className={`pae-schedule-mode${mode === 'immediate' ? ' pae-schedule-mode--active' : ''}`}
                          data-testid="schedule-mode-now"
                          aria-pressed={mode === 'immediate'}
                          onClick={() => enterMode('immediate')}
                        >
                          {t('immediateMode')}
                        </button>
                        <button
                          type="button"
                          className={`pae-schedule-mode${mode === 'at' ? ' pae-schedule-mode--active' : ''}`}
                          data-testid="schedule-mode-at"
                          aria-pressed={mode === 'at'}
                          onClick={() => enterMode('at')}
                        >
                          {t('atMode')}
                        </button>
                      </div>
                      {mode === 'at' ? (
                        <>
                          {/* 日历：react-day-picker（classNames 全量映射，样式见 styles.ts；无包 css） */}
                          <div className="pae-schedule-calendar" data-testid="schedule-calendar">
                            <DayPicker
                              mode="single"
                              weekStartsOn={1}
                              selected={draftDay}
                              onSelect={onSelectDay}
                              disabled={{ before: startOfToday }}
                              classNames={{
                                root: 'pae-rdp-root',
                                months: 'pae-rdp-months',
                                month: 'pae-rdp-month',
                                month_caption: 'pae-rdp-caption',
                                caption_label: 'pae-rdp-caption_label',
                                nav: 'pae-rdp-nav',
                                button_previous: 'pae-rdp-nav_button',
                                button_next: 'pae-rdp-nav_button',
                                month_grid: 'pae-rdp-table',
                                weekdays: 'pae-rdp-head_row',
                                weekday: 'pae-rdp-head_cell',
                                weeks: 'pae-rdp-weeks',
                                week: 'pae-rdp-row',
                                day: 'pae-rdp-day',
                                day_button: 'pae-rdp-day_button',
                                today: 'pae-rdp-day_today',
                                outside: 'pae-rdp-day_outside',
                                disabled: 'pae-rdp-day_disabled',
                                selected: 'pae-rdp-day_selected',
                              }}
                              components={{ CaptionLabel: PaeCaptionLabel, Weekday: PaeWeekday }}
                              formatters={{
                                formatCaption: (date: Date) => formatCaption(date),
                                formatWeekdayName: (date: Date) => formatWeekdayName(date),
                              }}
                              labels={{
                                labelPrevious: () => t('schedulePrev'),
                                labelNext: () => t('scheduleNext'),
                              }}
                            />
                          </div>
                          {/* 时/分原生 select（步长 1；只进草稿态，确定才收口） */}
                          <div className="pae-schedule-time">
                            <select
                              className="pae-schedule-select"
                              aria-label={t('scheduleHour')}
                              value={draftHour}
                              onChange={(event) => setDraftHour(Number(event.target.value))}
                            >
                              {Array.from({ length: 24 }, (_, hour) => (
                                <option key={hour} value={hour}>
                                  {String(hour).padStart(2, '0')}
                                </option>
                              ))}
                            </select>
                            <span className="pae-schedule-colon">:</span>
                            <select
                              className="pae-schedule-select"
                              aria-label={t('scheduleMinute')}
                              value={draftMinute}
                              onChange={(event) => setDraftMinute(Number(event.target.value))}
                            >
                              {Array.from({ length: 60 }, (_, minute) => (
                                <option key={minute} value={minute}>
                                  {String(minute).padStart(2, '0')}
                                </option>
                              ))}
                            </select>
                          </div>
                        </>
                      ) : null}
                      {/* 草稿即时反馈状态行：immediate=即时提示 / at=预览·过去·不完整；
                      role=status + aria-live：对屏幕阅读器即时播报（空文案不播报，
                      与卡底 .pae-error 的 role=status 并存无冲突） */}
                      <div
                        className={`pae-schedule-status${draftStatusMod}`}
                        data-testid="schedule-status"
                        role="status"
                        aria-live="polite"
                      >
                        {draftStatusText}
                      </div>
                      <div className="pae-schedule-picker-actions">
                        <Button
                          size="sm"
                          variant="primary"
                          data-testid="schedule-commit"
                          disabled={mode === 'at' && !draftReady}
                          onClick={commitSchedule}
                        >
                          {t('scheduleConfirm')}
                        </Button>
                      </div>
                    </div>,
                    document.body,
                  )
                : null}
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
                onClick={() => decide(option.label)}
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
