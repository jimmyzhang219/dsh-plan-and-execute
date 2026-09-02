import { describe, expect, it } from 'vitest'
import {
  EXECUTING_SECTION_BODY,
  kickoffInstruction,
  nudgeInstruction,
  planReviewDetail,
  planSummaryContextMessage,
  recoverInstruction,
  replanContextMessage,
  replanInstruction,
  resumePlanningInstruction,
  stepInstruction,
  stepReportContextMessage,
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
  it('planning 正文要求能拆则拆：鼓励多步、单步必须自证，不再宣称单步计划无条件合法', () => {
    const text = PLANNING_SECTION_BODY('/ws/.pae/s/20260826')
    expect(text).toContain('能拆则拆')
    expect(text).toContain('单步计划')
    expect(text).toContain('自证')
    expect(text).not.toContain('单步计划也合法')
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
  it('executing 正文要求以步骤文件内容（已内嵌）为唯一执行依据', () => {
    const text = EXECUTING_SECTION_BODY()
    expect(text).toContain('唯一执行依据')
    expect(text).toContain('已内嵌')
  })
  it('executing 正文规定文件与标题/任务不一致时以文件为准，不按标题猜测执行', () => {
    const text = EXECUTING_SECTION_BODY()
    expect(text).toContain('以文件')
    expect(text).toContain('不一致')
  })
  it('executing 正文规定文件自相矛盾时 status=failed 上报，而非自行裁决；上下文只有上一步结果', () => {
    const text = EXECUTING_SECTION_BODY()
    expect(text).toContain('自相矛盾')
    expect(text).toContain('status=failed')
    expect(text).toContain('上一步')
    expect(text).not.toContain('完成当前步能完成的部分')
  })
  it('executing 正文规定 report_step 新协议字段（status/artifacts/summary/exit_code）', () => {
    const text = EXECUTING_SECTION_BODY()
    expect(text).toContain('status=success')
    expect(text).toContain('artifacts')
    expect(text).toContain('exit_code')
    expect(text).toContain('200')
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
  it('kickoff 不含任务原文（任务在锚定的 userTaskMessage 中），含 planDir，source 标记为 plugin instruction', () => {
    const message = kickoffInstruction('重构登录模块', '/p')
    expect(message.role).toBe('user')
    expect(message.content[0]).toMatchObject({ type: 'text' })
    const text = (message.content[0] as { text: string }).text
    expect(text).not.toContain('重构登录模块')
    expect(text).toContain('/p')
    expect(message.source).toMatchObject({
      kind: 'plugin',
      plugin: 'dsh-plan-and-execute',
      form: 'instructions',
    })
  })
  it('stepInstruction 内嵌步骤文件内容，含序号、标题、路径与 report_step 要求', () => {
    const message = stepInstruction(
      2,
      5,
      { file: 'step-02-x.md', title: '写测试' },
      '/p',
      '# 目标\n写测试',
    )
    const text = (message.content[0] as { text: string }).text
    expect(text).toContain('2/5')
    expect(text).toContain('写测试')
    expect(text).toContain('/p/step-02-x.md')
    expect(text).toContain('# 目标\n写测试')
    expect(text).toContain('已内嵌')
    expect(text).toContain('report_step')
  })
  it('nudge/recover/replan/resume 均为非空 instruction', () => {
    for (const m of [
      nudgeInstruction(),
      recoverInstruction('turn 以 error 结束'),
      replanInstruction(3),
      resumePlanningInstruction(),
    ]) {
      expect(m.source).toMatchObject({ kind: 'plugin', form: 'instructions' })
      expect((m.content[0] as { text: string }).text.length).toBeGreaterThan(0)
    }
  })
  it('planSummaryContextMessage 含计划概述与步骤清单', () => {
    const message = planSummaryContextMessage({
      planDir: '/p',
      summary: '三步重构',
      steps: [
        { file: 'step-01-a.md', title: 'A' },
        { file: 'step-02-b.md', title: 'B' },
      ],
    })
    const text = (message.content[0] as { text: string }).text
    expect(text).toContain('计划摘要')
    expect(text).toContain('三步重构')
    expect(text).toContain('1. A（step-01-a.md）')
    expect(text).toContain('2. B（step-02-b.md）')
  })
  it('stepReportContextMessage 含上一步状态/产物/摘要/退出码', () => {
    const message = stepReportContextMessage(1, 3, '写测试', {
      stepIndex: 1,
      status: 'success',
      artifacts: ['src/util.py', 'outputs/data.json'],
      summary: '完成工具函数',
      exit_code: 0,
    })
    const text = (message.content[0] as { text: string }).text
    expect(text).toContain('上一步结果：第 1/3 步（写测试）')
    expect(text).toContain('成功')
    expect(text).toContain('src/util.py')
    expect(text).toContain('完成工具函数')
    expect(text).toContain('0')
  })
  it('replanContextMessage 含用户反馈与原计划清单', () => {
    const message = replanContextMessage('粒度太粗', {
      planDir: '/p',
      steps: [{ file: 'step-01-a.md', title: 'A' }],
    })
    const text = (message.content[0] as { text: string }).text
    expect(text).toContain('粒度太粗')
    expect(text).toContain('1. A（step-01-a.md）')
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
