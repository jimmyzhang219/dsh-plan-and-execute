import { describe, expect, it } from 'vitest'
import {
  buildSettingsPatch,
  encodeApprovalSchedule,
  isPlanReviewPending,
  parsePlanDetail,
  parseScheduleAt,
  placeSchedulePicker,
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

// 视口/面板/锚点均用纯数值；仅验证 placeSchedulePicker 输出（不依赖 jsdom 几何）。
const VIEWPORT = { width: 1024, height: 768 }

describe('placeSchedulePicker', () => {
  it('下方空间够 → 锚点下方 anchor.bottom + gap', () => {
    const anchor = { left: 100, top: 220, bottom: 300, width: 200 }
    expect(placeSchedulePicker(anchor, { width: 340, height: 220 }, VIEWPORT)).toEqual({
      left: 100,
      top: 304, // 300 + 4；304+220=524 <= 768-4 不触发上翻
    })
  })
  it('下方不够、上方够 → 上翻到 anchor.top - gap - height', () => {
    const anchor = { left: 100, top: 520, bottom: 600, width: 200 }
    expect(placeSchedulePicker(anchor, { width: 340, height: 220 }, VIEWPORT)).toEqual({
      left: 100,
      top: 296, // 上翻后 296+220=516 <= 764 且顶距 4
    })
  })
  it('下方上方都不够 → 贴底兜底 max(4, height - panel.height - 4)', () => {
    const anchor = { left: 100, top: 200, bottom: 280, width: 200 }
    const viewport = { width: 1024, height: 400 }
    expect(placeSchedulePicker(anchor, { width: 340, height: 220 }, viewport)).toEqual({
      left: 100,
      top: 176, // 400-220-4=176（上翻条件 200-4-220<4 不成立）
    })
  })
  it('右缘溢出 → left 左收进视口（clamp 上限）', () => {
    const anchor = { left: 900, top: 220, bottom: 300, width: 200 }
    expect(placeSchedulePicker(anchor, { width: 340, height: 220 }, VIEWPORT)).toEqual({
      left: 680, // 1024-340-4=680
      top: 304,
    })
  })
  it('clamp 下界：left 小于 4 → 4', () => {
    const anchor = { left: -50, top: 220, bottom: 300, width: 200 }
    expect(placeSchedulePicker(anchor, { width: 340, height: 220 }, VIEWPORT)).toEqual({
      left: 4,
      top: 304,
    })
  })
  it('clamp 边界恰好容纳 → left 不动', () => {
    const anchor = { left: 680, top: 220, bottom: 300, width: 200 }
    expect(placeSchedulePicker(anchor, { width: 340, height: 220 }, VIEWPORT)).toEqual({
      left: 680,
      top: 304,
    })
  })
  it('结果四舍五入取整（小数锚点坐标）', () => {
    const anchor = { left: 10.4, top: 0.2, bottom: 10.6, width: 100 }
    expect(placeSchedulePicker(anchor, { width: 340, height: 50 }, VIEWPORT)).toEqual({
      left: 10, // round(10.4)
      top: 15, // round(10.6+4)
    })
  })
  it('自定义 gap 生效', () => {
    const anchor = { left: 50, top: 220, bottom: 300, width: 200 }
    expect(placeSchedulePicker(anchor, { width: 340, height: 100 }, VIEWPORT, 10)).toEqual({
      left: 50,
      top: 310,
    })
  })
})
