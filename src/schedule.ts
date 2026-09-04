/**
 * 进程内定时注册表：为「已批准待定时执行」的编排提供单槽到点触发。
 * 宿主没有可被第三方插件使用的持久定时服务（dsh-schedule 为可选 overlay、
 * 事件白名单拒收插件变体），因此定时仅存活于宿主进程内；宿主进程退出后
 * 排期丢失，由 revive()（agent/created）按 orchestrator.json 的 scheduledAt
 * 重建（due 补执行 / future 重 arm）——与宿主 schedule 的 overdue 语义对齐。
 * setTimeout 单次上限约 24.8 天，超长延时以「到点前再排」链式逼近。
 * @module dsh-plan-and-execute/schedule
 */

/** setTimeout 单次延时上限（2^31-1 ms ≈ 24.8 天；超限会立即触发）。 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/** 注入式计时能力（生产用全局 setTimeout/Date.now；测试注入假件）。 */
export interface ClockLike {
  /** 当前时刻（epoch ms）。 */
  now(): number
  /** 注册 ms 后执行 fn；返回取消函数（幂等）。 */
  setTimer(fn: () => void, ms: number): () => void
}

/** 单会话排期槽。 */
interface Slot {
  /** 会话 id（注册表键；兼作归属 token，回调触发时校验，陈旧槽据此作废）。 */
  id: string
  /** 排期的执行时刻（epoch ms）。 */
  at: number
  /** 到点回调。 */
  fire: () => void
  /** 当前链式定时段的取消函数（未排定时 undefined）。 */
  timer?: () => void
}

/**
 * 会话级定时注册表（按 sessionId 单槽；arm 替换旧槽、触发/取消即清；
 * 到点回调先校验槽归属，cancel/替换后迟到的陈旧回调静默作废）。
 * @param clock - 注入的时钟与定时器（生产默认全局 setTimeout/Date.now）。
 */
export class ScheduleRegistry {
  private readonly slots = new Map<string, Slot>()

  constructor(
    private readonly clock: ClockLike = {
      now: () => Date.now(),
      setTimer: (fn, ms) => {
        const handle = setTimeout(fn, ms)
        return () => clearTimeout(handle)
      },
    },
  ) {}

  /** 注册/替换某会话的到点触发（同 id 旧排期自动作废）。 */
  arm(sessionId: string, at: number, fire: () => void): void {
    this.cancel(sessionId)
    const slot: Slot = { id: sessionId, at, fire }
    this.slots.set(sessionId, slot)
    this.step(slot)
  }

  /** 撤销某会话的排期（开始执行/取消排期时调用；幂等）。 */
  cancel(sessionId: string): void {
    const slot = this.slots.get(sessionId)
    if (slot === undefined) return
    slot.timer?.()
    this.slots.delete(sessionId)
  }

  /** 释放全部排期（插件卸载时调用）。 */
  dispose(): void {
    for (const id of [...this.slots.keys()]) this.cancel(id)
  }

  /** 排一段：距 at 若超过单次上限则拆段，否则到期即 fire 并清槽。 */
  private step(slot: Slot): void {
    // token 校验：clearTimeout 挡不住已入队回调，槽被 cancel/替换后其陈旧回调在此静默作废
    if (this.slots.get(slot.id) !== slot) return
    const remain = slot.at - this.clock.now()
    if (remain <= 0) {
      slot.timer = undefined
      this.slots.delete(slot.id) // fire 前先清槽，保证单次触发
      slot.fire()
      return
    }
    const delay = remain > MAX_TIMER_DELAY_MS ? MAX_TIMER_DELAY_MS : remain
    slot.timer = this.clock.setTimer(() => {
      slot.timer = undefined
      this.step(slot)
    }, delay)
  }
}
