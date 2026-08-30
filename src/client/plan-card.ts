/**
 * 审批卡模型选择相关的纯函数层（无 React/DOM 依赖，可 node 单测）。
 * 注：submit_plan toolview 卡片已于 2026-08-30 移除（功能收敛到审批卡），
 * 本模块保留审批卡仍在消费的形状与函数。
 * @module plan-and-execute/client/plan-card
 */

/** 卡片载荷（submit_plan 参数；审批卡经 parsePlanDetail 构造）。 */
export interface CardArgs {
  /** 计划目录（相对会话 cwd；打开路径的数据来源）。 */
  readonly planDir: string
  /** 计划一句话概述（可缺省）。 */
  readonly summary?: string
  /** 步骤清单。 */
  readonly steps: ReadonlyArray<{
    readonly file: string
    readonly title: string
    readonly requiresConfirmation?: boolean
  }>
}

/** 下拉选项（provider × model 展平）。 */
export interface ModelOption {
  readonly provider: string
  readonly model: string
  readonly label: string
}

/** 模型目录（与宿主 ModelCatalog 形状一致的最小面）。 */
interface ModelCatalogLike {
  readonly default: { readonly provider: string; readonly model: string }
  readonly groups: ReadonlyArray<{
    readonly id: string
    readonly models: ReadonlyArray<{ readonly id: string }>
  }>
}

/** 下拉拼接值（provider|model）。 */
export function optionKey(option: { readonly provider: string; readonly model: string }): string {
  return `${option.provider}|${option.model}`
}

/** groups × models 展平为下拉选项（provider 前缀区分同名模型）。 */
export function flattenCatalog(catalog: ModelCatalogLike): ModelOption[] {
  const options: ModelOption[] = []
  for (const group of catalog.groups) {
    for (const model of group.models) {
      options.push({ provider: group.id, model: model.id, label: `${group.id} · ${model.id}` })
    }
  }
  return options
}

/** 选择值 → 命令载荷（provider|model 拼接值还原）。 */
export function serializeStepModels(
  selection: Readonly<Record<number, string>>,
): Record<number, { provider: string; model: string }> {
  const models: Record<number, { provider: string; model: string }> = {}
  for (const [key, value] of Object.entries(selection)) {
    const [provider = '', model = ''] = value.split('|')
    models[Number(key)] = { provider, model }
  }
  return models
}
