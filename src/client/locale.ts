/**
 * plan-review 审批卡文案（`plan-and-execute` 命名空间）。
 * 键集以 zh 为准，en 同键翻译；`locale` 服务的 register 需要两份字典。
 * @module plan-and-execute/client/locale
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** 审批卡文案命名空间（register 的 locale 字段引用）。 */
export const NS = 'plan-and-execute'

/** zh 文案（键集源，默认语言）。 */
export const zh = {
  planReview: '计划审批',
  openDir: '打开计划目录',
  openStep: '打开步骤文件',
  approve: '批准',
  keep: '继续修改',
  feedback: '驳回反馈',
  feedbackHint: '选「继续修改」时附上反馈，可选',
  discuss: '讨论',
}

/** en 文案（同键集）。 */
export const en: Record<PaeCardKey, string> = {
  planReview: 'Plan review',
  openDir: 'Open plan directory',
  openStep: 'Open step file',
  approve: 'Approve',
  keep: 'Revise',
  feedback: 'Rejection feedback',
  feedbackHint: 'Feedback when declining, optional',
  discuss: 'Discuss',
}

/** 本命名空间字典键（注入面 t 与 register 的类型域）。 */
export type PaeCardKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** plan-review 审批卡文案键集。 */
    'plan-and-execute': PaeCardKey
  }
}
