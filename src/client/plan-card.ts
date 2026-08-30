/**
 * plan-and-execute 步骤卡片的纯函数层（无 React/DOM 依赖，可 node 单测）。
 * @module plan-and-execute/client/plan-card
 */

/** 卡片载荷（submit_plan 参数）。 */
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
export interface ModelCatalogLike {
  readonly default: { readonly provider: string; readonly model: string }
  readonly groups: ReadonlyArray<{
    readonly id: string
    readonly models: ReadonlyArray<{ readonly id: string }>
  }>
}

/** 校验并解析 submit_plan 原始参数；形状不符返回 undefined。 */
export function parseCardArgs(raw: unknown): CardArgs | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as { planDir?: unknown; summary?: unknown; steps?: unknown }
  if (typeof r.planDir !== 'string' || r.planDir === '') return undefined
  if (!Array.isArray(r.steps)) return undefined
  const steps: Array<CardArgs['steps'][number]> = []
  for (const s of r.steps) {
    const step = s as { file?: unknown; title?: unknown; requiresConfirmation?: unknown }
    if (typeof step?.file !== 'string' || typeof step?.title !== 'string') return undefined
    steps.push({
      file: step.file,
      title: step.title,
      ...(step.requiresConfirmation === true ? { requiresConfirmation: true } : {}),
    })
  }
  return {
    planDir: r.planDir,
    ...(typeof r.summary === 'string' ? { summary: r.summary } : {}),
    steps,
  }
}

/**
 * 旧会话 submit_plan 载荷缺 planDir 时的降级解析：步骤信息仍可展示，
 * 打开路径不可用（planDir 置空串作标记）。仅 steps 合法时返回。
 */
export function degradedCardArgs(raw: unknown): CardArgs | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as { summary?: unknown; steps?: unknown }
  if (!Array.isArray(r.steps) || r.steps.length === 0) return undefined
  const steps: Array<CardArgs['steps'][number]> = []
  for (const s of r.steps) {
    const step = s as { file?: unknown; title?: unknown; requiresConfirmation?: unknown }
    if (typeof step?.file !== 'string' || typeof step?.title !== 'string') return undefined
    steps.push({
      file: step.file,
      title: step.title,
      ...(step.requiresConfirmation === true ? { requiresConfirmation: true } : {}),
    })
  }
  return {
    planDir: '',
    ...(typeof r.summary === 'string' ? { summary: r.summary } : {}),
    steps,
  }
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
