import { describe, expect, it, vi } from 'vitest'
import { ScheduleRegistry, MAX_TIMER_DELAY_MS } from '../src/schedule.ts'

/** 注入式假定时器：捕获每个 setTimeout 回调与延时；now 可手动推进。 */
function fakeTimers() {
  let nowMs = 1_000_000
  const queue: Array<{ id: number; at: number; fn: () => void }> = []
  const scheduledMs: number[] = [] // 历次 setTimer 的延时（供拆段断言）
  let nextId = 1
  return {
    now: () => nowMs,
    /** 在队定时项（未取消/未触发）；测试可先取用 fn 模拟「已入队」的陈旧回调。 */
    queue,
    /** setTimer 延时记录。 */
    scheduledMs,
    advance: (ms: number) => {
      nowMs += ms
      // 依序执行到期的回调（先进先出；单槽场景足矣）
      for (const item of [...queue]) {
        if (item.at <= nowMs) {
          queue.splice(queue.indexOf(item), 1)
          item.fn()
        }
      }
    },
    install: () => {
      const registry = new ScheduleRegistry({
        now: () => nowMs,
        setTimer: (fn, ms) => {
          scheduledMs.push(ms)
          const item = { id: nextId++, at: nowMs + ms, fn }
          queue.push(item)
          return () => {
            const idx = queue.indexOf(item)
            if (idx !== -1) queue.splice(idx, 1)
          }
        },
      })
      return registry
    },
  }
}

describe('ScheduleRegistry', () => {
  it('arm 到点触发一次后自动取消（不再触发）', () => {
    const f = fakeTimers()
    const registry = f.install()
    const fire = vi.fn()
    registry.arm('s1', f.now() + 5_000, fire)
    f.advance(4_999)
    expect(fire).not.toHaveBeenCalled()
    f.advance(1)
    expect(fire).toHaveBeenCalledTimes(1)
    f.advance(60_000)
    expect(fire).toHaveBeenCalledTimes(1) // 触发即清槽
  })

  it('同 id 重复 arm 替换旧定时（旧 fire 不再触发）', () => {
    const f = fakeTimers()
    const registry = f.install()
    const oldFire = vi.fn()
    const newFire = vi.fn()
    registry.arm('s1', f.now() + 5_000, oldFire)
    registry.arm('s1', f.now() + 10_000, newFire)
    f.advance(6_000)
    expect(oldFire).not.toHaveBeenCalled()
    f.advance(4_000)
    expect(newFire).toHaveBeenCalledTimes(1)
  })

  it('cancel 撤销定时', () => {
    const f = fakeTimers()
    const registry = f.install()
    const fire = vi.fn()
    registry.arm('s1', f.now() + 5_000, fire)
    registry.cancel('s1')
    f.advance(60_000)
    expect(fire).not.toHaveBeenCalled()
  })

  it('cancel 后已入队的陈旧回调触发时静默作废（不 fire 亦不抛错）', () => {
    const f = fakeTimers()
    const registry = f.install()
    const fire = vi.fn()
    registry.arm('s1', f.now() + 5_000, fire)
    // 模拟回调已被事件循环取出：clearTimeout 无法阻止其执行，手动调用之
    const stale = f.queue[0]!.fn
    registry.cancel('s1')
    expect(() => stale()).not.toThrow()
    expect(fire).not.toHaveBeenCalled()
    f.advance(60_000)
    expect(fire).not.toHaveBeenCalled() // 且不残留重新排期
  })

  it('超过单次 setTimeout 上限（~24.8 天）的延时被链式拆段', () => {
    const f = fakeTimers()
    const registry = f.install()
    const fire = vi.fn()
    registry.arm('s1', f.now() + MAX_TIMER_DELAY_MS + 1_000, fire)
    f.advance(MAX_TIMER_DELAY_MS) // 第一段到点：应「到点前再排」而非提前触发
    expect(fire).not.toHaveBeenCalled()
    expect(f.scheduledMs.length).toBeGreaterThan(1) // 拆段而非单次超长定时
    for (const ms of f.scheduledMs) {
      expect(ms).toBeLessThanOrEqual(MAX_TIMER_DELAY_MS)
    }
    f.advance(1_000) // 末段到期：到点触发
    expect(fire).toHaveBeenCalledTimes(1)
  })
})
