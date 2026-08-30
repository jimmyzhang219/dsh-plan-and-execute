import { describe, expect, it } from 'vitest'
import {
  buildSettingsPatch,
  isPlanReviewPending,
  parsePlanDetail,
  questionView,
} from '../../src/client/review-card.ts'

const pending = {
  kind: 'plan-review',
  key: 'k1',
  questions: [
    {
      id: 'pae-approve',
      question: '批准此计划（共 2 步）并开始执行？',
      options: [
        { label: '批准', description: '离开规划阶段' },
        { label: '继续修改', description: '留在规划阶段' },
      ],
    },
  ],
  answer: async () => undefined,
  cancel: async () => undefined,
}

describe('isPlanReviewPending', () => {
  it('plan-review 结构命中', () => {
    expect(isPlanReviewPending(pending)).toBe(true)
  })
  it('其他结构放行（question kind / 缺 answer / 非对象）', () => {
    expect(isPlanReviewPending({ ...pending, kind: 'question' })).toBe(false)
    expect(isPlanReviewPending({ ...pending, answer: undefined })).toBe(false)
    expect(isPlanReviewPending(null)).toBe(false)
    expect(isPlanReviewPending('x')).toBe(false)
  })
})

describe('questionView', () => {
  it('提取 id/question/options', () => {
    expect(questionView(pending.questions)).toEqual({
      id: 'pae-approve',
      question: '批准此计划（共 2 步）并开始执行？',
      options: [
        { label: '批准', description: '离开规划阶段' },
        { label: '继续修改', description: '留在规划阶段' },
      ],
    })
  })
  it('形状不符返回 undefined', () => {
    expect(questionView([])).toBeUndefined()
    expect(questionView([{ id: 'x' }])).toBeUndefined()
  })
})

describe('buildSettingsPatch', () => {
  it('sessionId 键 + serializeStepModels 结果', () => {
    expect(buildSettingsPatch('sess-1', { 1: 'a|m1' })).toEqual({
      'sess-1': { 1: { provider: 'a', model: 'm1' } },
    })
  })
})

describe('parsePlanDetail', () => {
  it('解析 planReviewDetail 格式（计划目录行 + N. title — file 行）', () => {
    const detail = '计划目录：/tmp/x\n1. 计算 1+1 — step-01.md\n2. 计算 2+2 — step-02.md ⚠ 确认点'
    expect(parsePlanDetail(detail)).toEqual({
      planDir: '/tmp/x',
      steps: [
        { file: 'step-01.md', title: '计算 1+1' },
        { file: 'step-02.md', title: '计算 2+2', requiresConfirmation: true },
      ],
    })
  })
  it('标题含 " — " 时以最后一个分隔符解析', () => {
    const detail = '计划目录：/tmp/x\n1. 拆分 — 合并 — step-01.md'
    expect(parsePlanDetail(detail)).toEqual({
      planDir: '/tmp/x',
      steps: [{ file: 'step-01.md', title: '拆分 — 合并' }],
    })
  })
  it('缺计划目录行 / 空 detail → undefined', () => {
    expect(parsePlanDetail('')).toBeUndefined()
    expect(parsePlanDetail('1. a — b.md')).toBeUndefined()
  })
  it('非标准步骤行跳过（容错）', () => {
    const detail = '计划目录：/tmp/x\n垃圾行\n1. a — b.md'
    expect(parsePlanDetail(detail)).toEqual({
      planDir: '/tmp/x',
      steps: [{ file: 'b.md', title: 'a' }],
    })
  })
})
