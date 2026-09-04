/**
 * 每步模型选择的 settings 命名空间：Web UI 审批卡下拉经
 * ctx.remote.settings.update 静默写入（不走会话消息/斜杠命令），
 * 宿主侧监听 settings/updated 桥接到编排器。
 * @module dsh-plan-and-execute/settings
 */
import Schema from '@deepseek-ai/schemastery'
import type { PaeStepModel } from './state.ts'

// PAE_MODELS_NS 定义在 state.ts（无运行时依赖）：client half 也引用它，
// 若定义在本文件会把 schemastery 值导入拖进浏览器 bundle（tsup 将
// peerDeps 标 external → 运行时 require 在模块表缺失即崩）。
export { PAE_MODELS_NS, PAE_SCHEDULE_NS } from './state.ts'

/** 命名空间 schema：sessionId → {at: 执行时刻 epoch ms | null（null=立即执行）}。 */
export const PAE_SCHEDULE_SCHEMA = Schema.dict(
  Schema.object({
    at: Schema.union([Schema.number(), Schema.const(null)]).required(),
  }),
)

/**
 * 从 settings 载荷解析排期值（单个 sessionId 的 {at} 段）。
 * @param section - settings/updated 的 next 中该 sessionId 对应的值。
 * @returns 排期意图：number=未来时刻；null=立即执行；undefined=载荷非法（忽略）。
 */
export function parsePaeSchedule(section: unknown): number | null | undefined {
  if (typeof section !== 'object' || section === null) return undefined
  const at = (section as { at?: unknown }).at
  if (at === null) return null
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at <= 0) return undefined
  return at
}

/** 命名空间 schema：sessionId → 步骤号(数字字符串) → {provider, model}。 */
export const PAE_MODELS_SCHEMA = Schema.dict(
  Schema.dict(
    Schema.object({
      provider: Schema.string().required(),
      model: Schema.string().required(),
    }),
  ),
)

/**
 * 从 settings 载荷解析合法步骤模型（非法条目丢弃，不抛）。
 * @param section - 单个 sessionId 的载荷（settings/updated 的 next 中对应键的值）。
 * @returns 1-based 步骤号 → 模型。
 */
export function parsePaeModels(section: unknown): Record<number, PaeStepModel> {
  if (typeof section !== 'object' || section === null) return {}
  const models: Record<number, PaeStepModel> = {}
  for (const [stepKey, value] of Object.entries(section)) {
    const index = Number(stepKey)
    if (!Number.isInteger(index) || index < 1) continue
    const v = value as { provider?: unknown; model?: unknown } | null
    if (typeof v?.provider !== 'string' || typeof v?.model !== 'string') continue
    models[index] = { provider: v.provider, model: v.model }
  }
  return models
}
