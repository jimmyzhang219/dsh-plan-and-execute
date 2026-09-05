/**
 * 排期到点前的归档守卫。宿主归档（workspace `archiveSession`）只把会话 id
 * 追加进 `archivedSessionIds` 持久集合（不发事件、不动 agent/session），
 * 因此插件在到点触发时经可选注入的 workspaceRegistry 服务查询归档态：
 * 已归档 → 排期作废（不执行、不补跑，仅落终态 aborted 记录供查看）；
 * 未归档/服务缺失（无法判定）→ 放行保持现状。
 * 决策为纯函数；冷会话（进程重启后未打开、无编排器实例）的终态落盘在本模块
 * 以窄依赖实现（真实接线见 src/index.ts 组合根的适配）。
 * @module dsh-plan-and-execute/archive-guard
 */
import { fileStorage } from './persist.ts'

/**
 * 到点触发动作决策：会话已被归档时作废排期，否则照常执行。
 * workspaceRegistry 服务缺失（archivedIds 为 undefined）视为无法判定 → 放行。
 */
export type ScheduledFireDecision = 'execute' | 'void-by-archive'

/**
 * 判定到点触发动作。workspace 服务缺失（undefined）视为无法判定 → 保持现状放行。
 * @param archivedIds - workspaceRegistry.archivedSessionIds（或 undefined）。
 * @param sessionId - 待触发会话 id。
 * @returns execute=放行；void-by-archive=已归档，应作废排期。
 */
export function decideScheduledFire(
  archivedIds: readonly string[] | undefined,
  sessionId: string,
): ScheduledFireDecision {
  // 服务缺失/会话不在归档集合 → 放行（与引入本守卫前的行为一致）
  if (archivedIds === undefined) return 'execute'
  return archivedIds.includes(sessionId) ? 'void-by-archive' : 'execute'
}

/** 冷会话归档作废的窄依赖（可离线单测；真实接线见 src/index.ts）。 */
export interface VoidColdArchivedSessionOptions {
  /**
   * 会话头列表提供者（宿主 sessionPersistence.list 的窄投影：header.id/header.cwd；
   * undefined = 部署无该服务，无法定位会话 cwd）。
   */
  readonly listHeaders?: () => Promise<ReadonlyArray<{ id: string; cwd?: string }>>
  /** 计划根目录（相对会话 cwd；配置值 config.planDir）。 */
  readonly planRoot: string
  /** 告警日志（无法定位排期文件等降级路径；消息不含公共前缀，由调用方决定格式）。 */
  readonly warn: (message: string) => void
}

/**
 * 冷会话（进程重启后未打开过、无编排器实例）的归档作废：按持久化会话头中的
 * cwd 定位 planDir/orchestrator.json，若仍处 scheduled 等待期则原地改写为
 * 终态 aborted（scheduledAt 删除），避免之后取消归档重开时按 overdue 补执行。
 * 残余窗口（文档注明）：persistence 服务缺失 / 索引无该会话 / header 无 cwd 时
 * 无法定位排期文件，仅记 warn 后返回——状态文件保持 scheduled，下次会话打开
 * 仍会按 overdue 补执行。落盘失败照 fail-loud 上抛（调用方 catch）。
 * @param options - 窄依赖（会话头索引/计划根目录/告警日志）。
 * @param sessionId - 待作废的会话 id。
 * @returns 无（作废结果经状态文件体现；落盘失败上抛由调用方 catch）。
 */
export async function voidColdArchivedSession(
  options: VoidColdArchivedSessionOptions,
  sessionId: string,
): Promise<void> {
  const { listHeaders, planRoot, warn } = options
  if (listHeaders === undefined) {
    warn(
      `归档会话 ${sessionId} 已到点但部署无 sessionPersistence 服务，无法定位排期文件：` +
        '作废未落盘（取消归档重开会话可能按 overdue 补执行）',
    )
    return
  }
  const headers = await listHeaders()
  const header = headers.find((h) => h.id === sessionId)
  if (header === undefined) {
    warn(
      `归档会话 ${sessionId} 不在会话索引中（可能已删除），无法定位排期文件：` +
        '作废未落盘（取消归档重开会话可能按 overdue 补执行）',
    )
    return
  }
  const cwd = header.cwd
  if (cwd === undefined) {
    warn(
      `归档会话 ${sessionId} 的 header 无 cwd，无法定位排期文件：` +
        '作废未落盘（取消归档重开会话可能按 overdue 补执行）',
    )
    return
  }
  // 目录布局与 index.ts 的 planDirOf 同构：<会话 cwd>/<计划根>/<sessionId>
  const storage = fileStorage(`${cwd}/${planRoot}/${sessionId}`)
  const loaded = await storage.load()
  if (loaded === undefined || loaded.phase !== 'scheduled') return
  // 终态改写：删除 scheduledAt 键、phase 置 aborted，其余字段（plan/stepReports 等）保留供查看
  const { scheduledAt: _scheduledAt, ...withoutScheduleAt } = loaded
  await storage.save({ ...withoutScheduleAt, phase: 'aborted' })
}
