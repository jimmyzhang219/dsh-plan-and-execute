/**
 * 编排控制流状态的磁盘持久化。dsh 的会话事件白名单（KNOWN_SESSION_EVENT_TYPES）
 * 不接受外部插件自定义事件类型（写了会导致会话历史拒读），因此编排状态
 * 存为 planDir 下的 orchestrator.json（整值替换快照，原子写入）。
 * @module plan-and-execute/persist
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo'
import type {
  PaePausedReason,
  PaePhase,
  PaePlanPayload,
  PaeStepModel,
  PaeStepReportPayload,
} from './state.ts'

/** JSON 安全的编排状态快照（Map/Set 已转 Record/数组）。 */
export interface PersistedOrchestratorState {
  /** 编排阶段（终态 completed/aborted 也持久化，供恢复判定）。 */
  readonly phase: PaePhase
  /** 编排任务文本（用户输入）。 */
  readonly task?: string
  /** 计划目录。 */
  readonly planDir?: string
  /** 当前步骤号（1-based；planning 阶段为 undefined）。 */
  readonly stepIndex?: number
  /** 暂停原因（paused 阶段）。 */
  readonly pausedReason?: PaePausedReason
  /** 已批准的计划（executing/paused 阶段）。 */
  readonly plan?: PaePlanPayload
  /** 各步汇报记录（按 stepIndex 去重，数组序）。 */
  readonly stepReports: readonly PaeStepReportPayload[]
  /** 各步 todo 状态（键为 1-based 步号）。 */
  readonly statuses: Readonly<Record<number, TodoItem['status']>>
  /** 各步模型选择（键为 1-based 步号；缺省 = 用会话当前模型）。 */
  readonly stepModels?: Readonly<Record<number, PaeStepModel>>
  /** 被跳过（skip）的步骤号集合。 */
  readonly skipped: readonly number[]
}

/** 状态文件名（位于 planDir 下）。 */
const STATE_FILE = 'orchestrator.json'

/** 读编排状态；无状态文件返回 undefined（宽松解析，坏文件视为无状态）。 */
async function readState(planDir: string): Promise<PersistedOrchestratorState | undefined> {
  try {
    const raw = await readFile(join(planDir, STATE_FILE), 'utf8')
    const parsed = JSON.parse(raw) as PersistedOrchestratorState
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.phase !== 'string') {
      return undefined
    }
    return parsed
  } catch {
    return undefined
  }
}

/** 原子写状态快照（同目录临时文件 + rename）。 */
async function writeState(planDir: string, state: PersistedOrchestratorState): Promise<void> {
  await mkdir(planDir, { recursive: true })
  const target = join(planDir, STATE_FILE)
  const tmp = `${target}.tmp`
  await writeFile(tmp, `${JSON.stringify(state)}\n`, 'utf8')
  await rename(tmp, target)
}

/** 清空编排目录（新编排开始时的旧终态/步骤文件残留）。 */
export async function resetPlanDir(planDir: string): Promise<void> {
  await rm(planDir, { recursive: true, force: true })
  await mkdir(planDir, { recursive: true })
}

/** 编排器依赖的持久化接口。 */
export interface PersistedStorage {
  load(): Promise<PersistedOrchestratorState | undefined>
  save(state: PersistedOrchestratorState): Promise<void>
}

/** 基于 planDir 的真实文件存储。 */
export function fileStorage(planDir: string): PersistedStorage {
  return {
    load: () => readState(planDir),
    save: (state) => writeState(planDir, state),
  }
}

/** 让 Map/Set 状态可 JSON 序列化的提取（phase 'none' 仅内存态，save 前必已是 PaePhase）。 */
export function snapshotState(state: {
  phase: PaePhase | 'none'
  task?: string
  planDir?: string
  stepIndex?: number
  pausedReason?: PaePausedReason
  plan?: PaePlanPayload
  stepReports: ReadonlyMap<number, PaeStepReportPayload>
  statuses: ReadonlyMap<number, TodoItem['status']>
  stepModels: ReadonlyMap<number, PaeStepModel>
  skipped: ReadonlySet<number>
}): PersistedOrchestratorState {
  return {
    phase: state.phase as PaePhase,
    ...(state.task === undefined ? {} : { task: state.task }),
    ...(state.planDir === undefined ? {} : { planDir: state.planDir }),
    ...(state.stepIndex === undefined ? {} : { stepIndex: state.stepIndex }),
    ...(state.pausedReason === undefined ? {} : { pausedReason: state.pausedReason }),
    ...(state.plan === undefined ? {} : { plan: state.plan }),
    stepReports: [...state.stepReports.values()],
    statuses: Object.fromEntries(state.statuses) as Record<number, TodoItem['status']>,
    ...(state.stepModels.size === 0 ? {} : { stepModels: Object.fromEntries(state.stepModels) }),
    skipped: [...state.skipped],
  }
}

/** 从持久化快照恢复内存集合。 */
export function restoreState(persisted: PersistedOrchestratorState): {
  stepReports: Map<number, PaeStepReportPayload>
  statuses: Map<number, TodoItem['status']>
  stepModels: Map<number, PaeStepModel>
  skipped: Set<number>
} {
  return {
    stepReports: new Map(persisted.stepReports.map((report) => [report.stepIndex, report])),
    statuses: new Map(Object.entries(persisted.statuses).map(([k, v]) => [Number(k), v])),
    stepModels: new Map(Object.entries(persisted.stepModels ?? {}).map(([k, v]) => [Number(k), v])),
    skipped: new Set(persisted.skipped),
  }
}
