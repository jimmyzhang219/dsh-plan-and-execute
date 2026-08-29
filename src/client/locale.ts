/**
 * submit_plan 步骤卡片文案（`plan-and-execute` 命名空间）。
 * 键集以 zh 为准，en 同键翻译；`locale` 服务的 register 需要两份字典。
 * @module plan-and-execute/client/locale
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** 步骤卡片文案命名空间（register 的 locale 字段引用）。 */
export const NS = 'plan-and-execute'

/** zh 文案（键集源，默认语言）。 */
export const zh = {
  openDir: '打开计划目录',
  openFile: '打开文件',
  applyModels: '应用模型选择',
  applied: '已应用',
  planDir: '计划目录',
  modelUnavailable: '模型目录不可用',
}

/** en 文案（同键集）。 */
export const en: Record<PlanCardKey, string> = {
  openDir: 'Open plan directory',
  openFile: 'Open file',
  applyModels: 'Apply model selection',
  applied: 'Applied',
  planDir: 'Plan directory',
  modelUnavailable: 'Model catalog unavailable',
}

/** 本命名空间字典键（注入面 t 与 register 的类型域）。 */
export type PlanCardKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** submit_plan 卡片文案键集。 */
    'plan-and-execute': PlanCardKey
  }
}
