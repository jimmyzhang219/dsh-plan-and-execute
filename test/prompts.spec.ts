import { describe, expect, it } from 'vitest'
import {
  completionDetail,
  EXECUTING_SECTION_BODY,
  kickoffInstruction,
  nudgeInstruction,
  planReviewDetail,
  recoverInstruction,
  replanInstruction,
  resumePlanningInstruction,
  stepInstruction,
  PLANNING_SECTION_BODY,
} from '../src/prompts.ts'

describe('section 正文', () => {
  it('planning 正文含 planDir、submit_plan 与文件命名要求', () => {
    const text = PLANNING_SECTION_BODY('/ws/.pae/s/20260826')
    expect(text).toContain('/ws/.pae/s/20260826')
    expect(text).toContain('submit_plan')
    expect(text).toContain('step-NN')
    expect(text).toContain('requiresConfirmation')
  })
  it('executing 正文含 report_step 与 todo 纪律', () => {
    const text = EXECUTING_SECTION_BODY()
    expect(text).toContain('report_step')
    expect(text).toContain('todo_write')
  })
})

describe('注入消息', () => {
  it('kickoff 含任务原文与 planDir，source 标记为 plugin instruction', () => {
    const message = kickoffInstruction('重构登录模块', '/p')
    expect(message.role).toBe('user')
    expect(message.content[0]).toMatchObject({ type: 'text' })
    const text = (message.content[0] as { text: string }).text
    expect(text).toContain('重构登录模块')
    expect(text).toContain('/p')
    expect(message.source).toMatchObject({
      kind: 'plugin',
      plugin: 'plan-and-execute',
      form: 'instructions',
    })
  })
  it('stepInstruction 含序号、标题、文件路径与 report_step 要求', () => {
    const message = stepInstruction(2, 5, { file: 'step-02-x.md', title: '写测试' }, '/p')
    const text = (message.content[0] as { text: string }).text
    expect(text).toContain('2/5')
    expect(text).toContain('写测试')
    expect(text).toContain('/p/step-02-x.md')
    expect(text).toContain('report_step')
  })
  it('nudge/recover/replan/resume 均为非空 instruction', () => {
    for (const m of [
      nudgeInstruction(),
      recoverInstruction('turn 以 error 结束'),
      replanInstruction('上一版计划被用户驳回：粒度太粗', 3),
      resumePlanningInstruction(),
    ]) {
      expect(m.source).toMatchObject({ kind: 'plugin', form: 'instructions' })
      expect((m.content[0] as { text: string }).text.length).toBeGreaterThan(0)
    }
  })
})

describe('详情渲染', () => {
  it('planReviewDetail 列出步骤与确认点标记', () => {
    const detail = planReviewDetail(
      [
        { file: 'step-01-a.md', title: 'A' },
        { file: 'step-02-b.md', title: 'B', requiresConfirmation: true },
      ],
      '/p',
    )
    expect(detail).toContain('1. A — step-01-a.md')
    expect(detail).toContain('2. B — step-02-b.md ⚠ 确认点')
  })
  it('completionDetail 汇总各步结局，跳过步标注', () => {
    const detail = completionDetail(
      [
        { file: 'a.md', title: 'A' },
        { file: 'b.md', title: 'B' },
      ],
      new Map([[1, { stepIndex: 1, outcome: 'done' as const, summary: '完成 A' }]]),
      new Set([2]),
    )
    expect(detail).toContain('1. A — done：完成 A')
    expect(detail).toContain('2. B — skipped')
  })
})
