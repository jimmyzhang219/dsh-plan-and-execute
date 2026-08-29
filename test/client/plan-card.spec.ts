import { describe, expect, it } from 'vitest'
import {
  buildSetModelsPrompt,
  flattenCatalog,
  parseCardArgs,
  resolveCurrentModel,
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
      { provider: 'deepseek-official', model: 'deepseek-v4-flash', label: 'deepseek-official · deepseek-v4-flash' },
      { provider: 'deepseek-official', model: 'deepseek-v4-pro', label: 'deepseek-official · deepseek-v4-pro' },
    ])
  })
  it('空 groups → 空数组', () => {
    expect(flattenCatalog({ ...catalog, groups: [] })).toEqual([])
  })
})

describe('resolveCurrentModel', () => {
  it('next 优先，其次 lastUsed，最后 catalog.default', () => {
    expect(resolveCurrentModel(catalog, { next: { provider: 'n', model: 'm' }, lastUsed: { provider: 'l', model: 'u' } }))
      .toEqual({ provider: 'n', model: 'm' })
    expect(resolveCurrentModel(catalog, { lastUsed: { provider: 'l', model: 'u' } }))
      .toEqual({ provider: 'l', model: 'u' })
    expect(resolveCurrentModel(catalog, undefined)).toEqual(catalog.default)
  })
  it('宿主投影为 null 时回退 lastUsed / catalog.default', () => {
    expect(resolveCurrentModel(catalog, { next: null, lastUsed: { provider: 'l', model: 'u' } }))
      .toEqual({ provider: 'l', model: 'u' })
    expect(resolveCurrentModel(catalog, { next: null, lastUsed: null })).toEqual(catalog.default)
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

describe('serializeStepModels', () => {
  it('"provider|model" 值 → {provider, model} 载荷', () => {
    expect(serializeStepModels({ 1: 'a|m' })).toEqual({ 1: { provider: 'a', model: 'm' } })
  })
})

describe('buildSetModelsPrompt', () => {
  it('生成命令文本（JSON.stringify 序列化）', () => {
    expect(buildSetModelsPrompt({ 1: { provider: 'a', model: 'm' } })).toBe(
      '/plan-and-execute-set-models {"1":{"provider":"a","model":"m"}}',
    )
  })
})
