import { describe, expect, it } from 'vitest'
import {
  buildSettingsPatch,
  encodeApprovalSchedule,
  isPlanReviewPending,
  parsePlanDetail,
  parseScheduleAt,
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

describe('parsePlanDetail 排期行', () => {
  it('detail 含「执行排期」行 → scheduledAt（本地时刻 epoch）', () => {
    const when = new Date(2026, 8, 5, 9, 30).getTime()
    const detail = `计划目录：/tmp/x\n执行排期：2026-09-05 09:30\n1. A — a.md`
    expect(parsePlanDetail(detail)?.scheduledAt).toBe(when)
  })
  it('无排期行 → scheduledAt 缺省（立即执行）', () => {
    expect(parsePlanDetail('计划目录：/tmp/x\n1. A — a.md')?.scheduledAt).toBeUndefined()
  })
  it('畸形排期行不打断解析（跳过该行，其余步骤照常）', () => {
    const detail = `计划目录：/tmp/x\n执行排期：昨天\n1. A — a.md`
    expect(parsePlanDetail(detail)).toEqual({
      planDir: '/tmp/x',
      steps: [{ file: 'a.md', title: 'A' }],
    })
  })
})

describe('parseScheduleAt', () => {
  it('本地 YYYY-MM-DD HH:mm → epoch', () => {
    expect(parseScheduleAt('2026-09-05 09:30')).toBe(new Date(2026, 8, 5, 9, 30).getTime())
  })
  it('非法 → undefined', () => {
    expect(parseScheduleAt('x')).toBeUndefined()
    expect(parseScheduleAt('2026-09-05')).toBeUndefined()
    expect(parseScheduleAt('2026-13-05 09:30')).toBeUndefined()
  })
})

describe('encodeApprovalSchedule', () => {
  it('首卡（无原排期）未指定时间 → undefined（不携带排期编码）', () => {
    expect(encodeApprovalSchedule(null, undefined)).toBeUndefined()
  })
  it('首卡指定时刻 → at 编码', () => {
    expect(encodeApprovalSchedule(1_750_000_000_000, undefined)).toBe(
      'paeSchedule:at:1750000000000',
    )
  })
  it('回显卡清为立即（when===null）→ now 编码', () => {
    expect(encodeApprovalSchedule(null, 1_750_000_000_000)).toBe('paeSchedule:now')
  })
  it('回显卡保持原排期（when===hadScheduledAt）→ undefined', () => {
    expect(encodeApprovalSchedule(1_750_000_000_000, 1_750_000_000_000)).toBeUndefined()
  })
  it('回显卡改新时刻 → at 编码', () => {
    expect(encodeApprovalSchedule(1_750_000_060_000, 1_750_000_000_000)).toBe(
      'paeSchedule:at:1750000060000',
    )
  })
})
