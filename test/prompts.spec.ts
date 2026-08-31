import { describe, expect, it } from 'vitest'
import {
  EXECUTING_SECTION_BODY,
  kickoffInstruction,
  nudgeInstruction,
  planReviewDetail,
  recoverInstruction,
  replanInstruction,
  resumePlanningInstruction,
  stepInstruction,
  userTaskMessage,
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
  it('planning 正文不再提及 exit_plan_mode（工具层 deny 已覆盖），保留正向审批规则', () => {
    const text = PLANNING_SECTION_BODY('/ws/.pae/s/20260826')
    expect(text).not.toContain('exit_plan_mode')
    expect(text).toContain('计划审批只通过 submit_plan 完成')
  })
  it('executing 正文含 report_step 与 todo 纪律，并禁用 submit_plan、不提及 exit_plan_mode', () => {
    const text = EXECUTING_SECTION_BODY()
    expect(text).toContain('report_step')
    expect(text).toContain('todo_write')
    expect(text).toContain('submit_plan')
    expect(text).not.toContain('exit_plan_mode')
  })
  it('executing 正文要求以步骤文件内容为唯一执行依据', () => {
    const text = EXECUTING_SECTION_BODY()
    expect(text).toContain('唯一执行依据')
  })
  it('executing 正文规定文件与标题/任务不一致时以文件为准，不按标题猜测执行', () => {
    const text = EXECUTING_SECTION_BODY()
    expect(text).toContain('以文件')
    expect(text).toContain('不一致')
  })
  it('executing 正文规定文件自相矛盾时 blocked 上报，而非自行裁决', () => {
    const text = EXECUTING_SECTION_BODY()
    expect(text).toContain('自相矛盾')
    expect(text).toContain('blocked')
    expect(text).not.toContain('完成当前步能完成的部分')
  })
})

describe('注入消息', () => {
  it('userTaskMessage 携带用户原文，source 标记为用户消息（与 /plan 同语义）', () => {
    const message = userTaskMessage('先计算1+1，得出结果后再加3')
    expect(message.role).toBe('user')
    const text = (message.content[0] as { text: string }).text
    expect(text).toBe('先计算1+1，得出结果后再加3')
    expect(message.source).toEqual({ kind: 'user' })
  })
  it('kickoff 含任务原文与 planDir，source 标记为 plugin instruction', () => {
    const message = kickoffInstruction('重构登录模块', '/p')
    expect(message.role).toBe('user')
    expect(message.content[0]).toMatchObject({ type: 'text' })
    const text = (message.content[0] as { text: string }).text
    expect(text).toContain('重构登录模块')
    expect(text).toContain('/p')
    expect(message.source).toMatchObject({
      kind: 'plugin',
      plugin: 'dsh-plan-and-execute',
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
})
