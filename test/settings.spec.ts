import { describe, expect, it } from 'vitest'
import { PAE_PING_NS, parsePaeModels, parsePaePing, PAE_MODELS_NS } from '../src/settings.ts'

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

describe('parsePaePing', () => {
  it('对象且 t 为有限数 → true（脉冲存在性语义）', () => {
    expect(parsePaePing({ t: 1_750_000_000_000 })).toBe(true)
    expect(parsePaePing({ t: 0 })).toBe(true)
  })
  it('非对象 / t 缺失 / t 非有限数 → false（不抛）', () => {
    expect(parsePaePing(null)).toBe(false)
    expect(parsePaePing('x')).toBe(false)
    expect(parsePaePing({})).toBe(false)
    expect(parsePaePing({ t: 'x' })).toBe(false)
    expect(parsePaePing({ t: Number.NaN })).toBe(false)
    expect(parsePaePing({ t: Number.POSITIVE_INFINITY })).toBe(false)
  })
  it('命名空间常量', () => {
    expect(PAE_PING_NS).toBe('pae-ping')
  })
})
