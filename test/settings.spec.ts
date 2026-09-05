import { describe, expect, it } from 'vitest'
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
