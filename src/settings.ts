/**
 * 每步模型选择的 settings 命名空间：Web UI 审批卡下拉经
 * ctx.remote.settings.update 静默写入（不走会话消息/斜杠命令），
 * 宿主侧监听 settings/updated 桥接到编排器。
 * @module plan-and-execute/settings
 */
import Schema from '@deepseek-ai/schemastery'
import type { PaeStepModel } from './state.ts'

// PAE_MODELS_NS 定义在 state.ts（无运行时依赖）：client half 也引用它，
// 若定义在本文件会把 schemastery 值导入拖进浏览器 bundle（tsup 将
// peerDeps 标 external → 运行时 require 在模块表缺失即崩）。
export { PAE_MODELS_NS } from './state.ts'

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
