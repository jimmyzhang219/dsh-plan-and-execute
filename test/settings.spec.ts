import { describe, expect, it } from 'vitest'
import { PAE_SCHEDULE_NS, parsePaeSchedule } from '../src/settings.ts'
import { parsePaeModels, PAE_MODELS_NS } from '../src/settings.ts'

describe('parsePaeModels', () => {
  it('合法载荷解析为 {步骤号: {provider, model}}', () => {
    expect(
      parsePaeModels({ 1: { provider: 'a', model: 'm1' }, 2: { provider: 'b', model: 'm2' } }),
    ).toEqual({
      1: { provider: 'a', model: 'm1' },
      2: { provider: 'b', model: 'm2' },
    })
  })
  it('非法条目丢弃（非整数键/缺字段/非字符串），不抛', () => {
    expect(
      parsePaeModels({
        '1.5': { provider: 'a', model: 'm' },
        0: { provider: 'a', model: 'm' },
        3: { provider: 'a' },
        4: 'x',
        5: { provider: 'a', model: 42 },
      }),
    ).toEqual({})
    expect(parsePaeModels(null)).toEqual({})
    expect(parsePaeModels('x')).toEqual({})
  })
  it('命名空间常量', () => {
    expect(PAE_MODELS_NS).toBe('pae-step-models')
  })
})

describe('parsePaeSchedule', () => {
  it('合法载荷解析 {at: number|null}', () => {
    expect(parsePaeSchedule({ at: 1_750_000_000_000 })).toBe(1_750_000_000_000)
    expect(parsePaeSchedule({ at: null })).toBeNull()
  })
  it('非法载荷返回 undefined（不抛）', () => {
    expect(parsePaeSchedule({ at: 'x' })).toBeUndefined()
    expect(parsePaeSchedule({ at: 1.5 })).toBeUndefined()
    expect(parsePaeSchedule({ at: -1 })).toBeUndefined()
    expect(parsePaeSchedule(null)).toBeUndefined()
    expect(parsePaeSchedule('x')).toBeUndefined()
  })
  it('命名空间常量', () => {
    expect(PAE_SCHEDULE_NS).toBe('pae-schedule')
  })
})
