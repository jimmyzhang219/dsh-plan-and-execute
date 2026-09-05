/**
 * settings 命名空间的两个静默写通道：审批卡模型下拉（pae-step-models）与
 * 会话查看脉冲（pae-ping）。Web UI 侧经 ctx.remote.settings.update 静默写入
 * （不走会话消息/斜杠命令），宿主侧监听 settings/updated 桥接到编排器。
 * @module dsh-plan-and-execute/settings
 */
import Schema from '@deepseek-ai/schemastery'
import type { PaeStepModel } from './state.ts'

// NS 常量定义在 state.ts（无运行时依赖）：client half 也引用它们，若定义在
// 本文件会把 schemastery 值导入拖进浏览器 bundle（tsup 将 peerDeps 标
// external → 运行时 require 在模块表缺失即崩）。
export { PAE_MODELS_NS, PAE_PING_NS } from './state.ts'

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

/**
 * 会话查看脉冲的命名空间 schema：sessionId → {t: epoch ms}。
 * 语义只是脉冲存在性（t 为有限数即视为一次查看信号），payload 不落业务。
 */
export const PAE_PING_SCHEMA = Schema.dict(Schema.object({ t: Schema.number().required() }))

/**
 * 解析单个 sessionId 的查看脉冲载荷（settings/updated 的 next 中对应键的值）。
 * @param section - 单会话载荷。
 * @returns 是否为合法脉冲（对象且 t 为有限数）。
 */
export function parsePaePing(section: unknown): boolean {
  if (typeof section !== 'object' || section === null) return false
  const v = section as { t?: unknown }
  return typeof v.t === 'number' && Number.isFinite(v.t)
}
