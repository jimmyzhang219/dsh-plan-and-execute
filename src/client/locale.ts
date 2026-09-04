/**
 * plan-review 审批卡文案（`dsh-plan-and-execute` 命名空间）。
 * 键集以 zh 为准，en 同键翻译；`locale` 服务的 register 需要两份字典。
 * @module dsh-plan-and-execute/client/locale
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** 审批卡文案命名空间（register 的 locale 字段引用）。 */
export const NS = 'dsh-plan-and-execute'

/** zh 文案（键集源，默认语言）。 */
export const zh = {
  planReview: '计划审批',
  openDir: '打开计划目录',
  openStep: '打开步骤文件',
  approve: '批准',
  keep: '继续修改',
  feedback: '驳回反馈',
  feedbackHint: '选「继续修改」时附上反馈，可选；新增的独立任务会成为新步骤',
  discuss: '讨论',
  scheduleNow: '立即执行', // chip 默认态 + 浮层「立即执行」按钮
  scheduleClear: '清除排期', // 排期态 chip × 的可访问名（与浮层「立即执行」按钮区分）
  scheduleDate: '日期',
  scheduleTime: '时间',
  scheduleAtHint: '计划于 %s 执行', // chip 排期态模板（%s=YYYY-MM-DD HH:mm）
  schedulePast: '执行时间需晚于当前时刻',
  scheduleHint: '选择完整日期与时间后生效',
}

/** en 文案（同键集）。 */
export const en: Record<PaeCardKey, string> = {
  planReview: 'Plan review',
  openDir: 'Open plan directory',
  openStep: 'Open step file',
  approve: 'Approve',
  keep: 'Revise',
  feedback: 'Rejection feedback',
  feedbackHint: 'Feedback when declining, optional; new independent tasks become new steps',
  discuss: 'Discuss',
  scheduleNow: 'Run now',
  scheduleClear: 'Clear schedule',
  scheduleDate: 'Date',
  scheduleTime: 'Time',
  scheduleAtHint: 'Scheduled for %s',
  schedulePast: 'Execution time must be later than now',
  scheduleHint: 'Takes effect once a full date and time is selected',
}

/** 本命名空间字典键（注入面 t 与 register 的类型域）。 */
export type PaeCardKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** plan-review 审批卡文案键集。 */
    'dsh-plan-and-execute': PaeCardKey
  }
}
