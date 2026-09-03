/**
 * dsh-plan-and-execute 的编排状态词汇与工具函数。
 *
 * 注意：dsh 的会话事件白名单（KNOWN_SESSION_EVENT_TYPES）不接受外部插件的
 * 自定义事件类型，因此编排控制流状态不写入会话日志，而是持久化在
 * planDir/orchestrator.json（见 persist.ts）；会话日志只记录标准事件
 * （todo/write、turn/* 等）。
 * @module dsh-plan-and-execute/state
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'

/** 插件标识（消息 source.plugin、编排目录命名空间）。 */
export const PAE_PLUGIN = 'dsh-plan-and-execute'

/**
 * 每步模型选择的 settings 命名空间名（全局用户配置，按 sessionId 分键）。
 * 定义在本文件（无运行时依赖）：宿主 settings.ts 与 client half 都引用它，
 * 放在带 schemastery 值导入的 settings.ts 会把该依赖拖进浏览器 bundle。
 * 品牌类型仅 type-only 导入（构建时擦除），不产生运行时 require。
 */
export const PAE_MODELS_NS = 'pae-step-models' as SettingsNamespace

/** 编排阶段：planning（规划）→ executing（执行，可暂停）→ completed/aborted（终态）。 */
export type PaePhase = 'planning' | 'executing' | 'paused' | 'completed' | 'aborted'
/** 暂停原因：确认点等待用户 / 步骤失败 / 用户终止。 */
export type PaePausedReason = 'confirm-point' | 'failure' | 'cancelled'

/** manifest 的单步描述（控制流；内容在步骤 md 文件里）。 */
export interface PlanStep {
  /** 步骤 Markdown 文件名（相对 planDir；manifest 校验路径安全）。 */
  readonly file: string
  /** 步骤短标题。 */
  readonly title: string
  /** 风险步骤标记：执行前需用户确认。 */
  readonly requiresConfirmation?: boolean
}

/** submit_plan 提交的计划载荷（批准后即执行清单）。 */
export interface PaePlanPayload {
  /** 计划目录：步骤 Markdown 文件所在（相对会话 cwd）。 */
  readonly planDir: string
  /** 计划一句话概述（可缺省）。 */
  readonly summary?: string
  /** 步骤清单；数组顺序即执行顺序。 */
  readonly steps: readonly PlanStep[]
}

/** 单步模型选择（Web UI 步骤卡片设置；apply 后执行期按步生效）。 */
export interface PaeStepModel {
  /** 注册的 provider 路由。 */
  readonly provider: string
  /** provider 拥有的模型 id。 */
  readonly model: string
}

/** report_step 的单步结局：success=已完成；failed=受阻/失败（blocked 语义并入）。 */
export type StepReportStatus = 'success' | 'failed'

/** report_step 的单步汇报载荷（内存态；不写会话日志）。 */
export interface PaeStepReportPayload {
  /** 汇报的步骤号（1-based）。 */
  readonly stepIndex: number
  /** 结局：success=已完成本步；failed=无法完成/受阻。 */
  readonly status: StepReportStatus
  /** 本步产出/涉及的文件路径（相对会话 cwd；可为空数组）。 */
  readonly artifacts: readonly string[]
  /** 结果抽象描述（尽量不超过 200 字，不含原文复现）。 */
  readonly summary: string
  /** 最后命令退出码（0=成功；受阻等无命令场景可省略）。 */
  readonly exit_code?: number
}

/** 构造 `todo/write` 整表快照；statuses 缺省为 pending（1-based）。 */
export function buildTodoPayload(
  steps: readonly PlanStep[],
  statuses: ReadonlyMap<number, TodoItem['status']>,
): { todos: TodoItem[] } {
  return {
    todos: steps.map((step, index) => ({
      content: `${index + 1}. ${step.title}`,
      status: statuses.get(index + 1) ?? 'pending',
    })),
  }
}

/** 目录归一化（去尾部斜杠；planDir 校验用）。 */
export function normalizeDir(path: string): string {
  return path.replace(/\/+$/, '')
}

/**
 * 宿主 plan-mode 是否激活。不依赖 dsh-plan-mode 包类型：事件类型不在本工程
 * 编译单元的 SessionEventMap 联合里，读 data 需要一次断言（唯一一处）。
 */
export function isPlanModeActive(events: readonly SessionEvent[]): boolean {
  let active = false
  for (const event of events) {
    if ((event.type as string) === 'plan/mode') {
      active = (event.data as unknown as { active: boolean }).active
    }
  }
  return active
}
