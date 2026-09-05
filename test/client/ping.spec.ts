import { afterEach, describe, expect, it } from 'vitest'
import { PING_INTERVAL_MS, allowSessionPing, resetPingCache } from '../../src/client/ping.ts'

// 限频表为模块态（页面生命周期内存）：用例间清理保持确定性；now 全注入不依赖真实时钟。
afterEach(() => {
  resetPingCache()
})

describe('allowSessionPing（pae-ping 会话打开信号限频）', () => {
  it('空串会话标识 → 不放行', () => {
    expect(allowSessionPing('', 1_700_000_000_000)).toBe(false)
  })

  it('首见会话 → 放行', () => {
    expect(allowSessionPing('sess-1', 1_700_000_000_000)).toBe(true)
  })

  it('限频窗口内同会话再次请求 → 不放行', () => {
    const t0 = 1_700_000_000_000
    expect(allowSessionPing('sess-1', t0)).toBe(true)
    expect(allowSessionPing('sess-1', t0 + PING_INTERVAL_MS - 1)).toBe(false)
  })

  it('异会话限频相互独立 → 各自放行', () => {
    const t0 = 1_700_000_000_000
    expect(allowSessionPing('sess-1', t0)).toBe(true)
    expect(allowSessionPing('sess-2', t0)).toBe(true)
  })

  it('拨过限频窗口（+10s）→ 同会话再次放行', () => {
    const t0 = 1_700_000_000_000
    expect(allowSessionPing('sess-1', t0)).toBe(true)
    expect(allowSessionPing('sess-1', t0 + PING_INTERVAL_MS)).toBe(true)
  })

  it('resetPingCache 清空后同会话可立即再次放行', () => {
    const t0 = 1_700_000_000_000
    expect(allowSessionPing('sess-1', t0)).toBe(true)
    resetPingCache()
    expect(allowSessionPing('sess-1', t0)).toBe(true)
  })
})
