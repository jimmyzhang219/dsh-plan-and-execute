import { describe, expect, it } from 'vitest'
import { flattenCatalog, serializeStepModels } from '../../src/client/plan-card.ts'

const catalog = {
  default: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  routableProviders: ['deepseek-official'],
  groups: [
    {
      id: 'deepseek-official',
      name: 'DeepSeek Official',
      models: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }],
    },
  ],
  failures: [],
}

describe('flattenCatalog', () => {
  it('groups × models → 下拉选项', () => {
    expect(flattenCatalog(catalog)).toEqual([
      {
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        label: 'deepseek-official · deepseek-v4-flash',
      },
      {
        provider: 'deepseek-official',
        model: 'deepseek-v4-pro',
        label: 'deepseek-official · deepseek-v4-pro',
      },
    ])
  })
  it('空 groups → 空数组', () => {
    expect(flattenCatalog({ ...catalog, groups: [] })).toEqual([])
  })
})

describe('serializeStepModels', () => {
  it('"provider|model" 值 → {provider, model} 载荷', () => {
    expect(serializeStepModels({ 1: 'a|m' })).toEqual({ 1: { provider: 'a', model: 'm' } })
  })
})
