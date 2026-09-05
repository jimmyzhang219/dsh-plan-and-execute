/**
 * 会话查看脉冲（pae-ping）限频工具。
 *
 * client half 靠 pae-ping 时间戳脉冲告知宿主「会话正被查看」，宿主 settings 桥接
 * 据此在 scheduled 等待期重弹回显卡。脉冲发送点位于 conversation.composer 注册的
 * select 内（每次链求值都执行——含无 pending 返回 null 的刷新/重开场景），本模块
 * 只负责「同一会话在窗口内至多放行一次」的限频判定：纯内存态、不依赖任何 DOM 或
 * 宿主运行时，页面生命周期内生效（刷新即空——恰好让刷新后的首次链求值重发脉冲）。
 * @module dsh-plan-and-execute/client/ping
 */

/** pae-ping 限频窗口（同一会话两次打开信号的最小间隔，毫秒）。 */
export const PING_INTERVAL_MS = 10_000

/** 最近一次放行会话 → 放行时刻（module 级去重限频；页面生命周期内存，刷新即空）。 */
const lastAllowedAt = new Map<string, number>()

/**
 * 会话打开信号限频：同一 sessionId 在窗口内只放行一次。
 * @param sessionId - 会话标识（空串不放行）。
 * @param now - 当前时刻（毫秒；测试注入，生产传 Date.now()）。
 * @returns 是否放行——true 表示应发一次 ping，且本次放行时刻被记录。
 */
export function allowSessionPing(sessionId: string, now: number): boolean {
  if (sessionId === '') return false
  const last = lastAllowedAt.get(sessionId) ?? 0
  if (now - last < PING_INTERVAL_MS) return false
  lastAllowedAt.set(sessionId, now)
  return true
}

/**
 * 清空限频缓存（仅供测试：用例间隔离模块态；生产无调用方）。
 */
export function resetPingCache(): void {
  lastAllowedAt.clear()
}
