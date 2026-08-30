import { describe, expect, it } from 'vitest'
import {
  degradedCardArgs,
  flattenCatalog,
  parseCardArgs,
  serializeStepModels,
} from '../../src/client/plan-card.ts'

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

describe('parseCardArgs', () => {
  it('合法载荷解析 planDir/summary/steps', () => {
    expect(parseCardArgs({ planDir: '.pae/s1', steps: [{ file: 'a.md', title: 'A' }] })).toEqual({
      planDir: '.pae/s1',
      steps: [{ file: 'a.md', title: 'A' }],
    })
  })
  it('缺 planDir / steps 非数组 / 步骤缺 file → undefined', () => {
    expect(parseCardArgs({ steps: [] })).toBeUndefined()
    expect(parseCardArgs({ planDir: '.pae/s1' })).toBeUndefined()
    expect(parseCardArgs({ planDir: '.pae/s1', steps: [{ title: 'A' }] })).toBeUndefined()
    expect(parseCardArgs(null)).toBeUndefined()
  })
})

describe('degradedCardArgs', () => {
  it('缺 planDir 但 steps 合法 → 降级解析（planDir 空串 + 步骤保留）', () => {
    expect(
      degradedCardArgs({
        summary: '旧计划',
        steps: [
          { file: 'a.md', title: 'A' },
          { file: 'b.md', title: 'B', requiresConfirmation: true },
        ],
      }),
    ).toEqual({
      planDir: '',
      summary: '旧计划',
      steps: [
        { file: 'a.md', title: 'A' },
        { file: 'b.md', title: 'B', requiresConfirmation: true },
      ],
    })
  })
  it('steps 缺失 / 空数组 / 步骤缺 file / 非对象 → undefined', () => {
    expect(degradedCardArgs({})).toBeUndefined()
    expect(degradedCardArgs({ steps: [] })).toBeUndefined()
    expect(degradedCardArgs({ steps: [{ title: 'A' }] })).toBeUndefined()
    expect(degradedCardArgs(null)).toBeUndefined()
  })
})

describe('serializeStepModels', () => {
  it('"provider|model" 值 → {provider, model} 载荷', () => {
    expect(serializeStepModels({ 1: 'a|m' })).toEqual({ 1: { provider: 'a', model: 'm' } })
  })
})
