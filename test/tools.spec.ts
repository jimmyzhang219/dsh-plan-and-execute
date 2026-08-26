import { describe, expect, it } from 'vitest'
import { createReportStepTool, createSubmitPlanTool } from '../src/tools.ts'
import { answer, makeOrchestrator } from './helpers.ts'

const run = (tool: { execute: (args: unknown, exec: never) => Promise<unknown> }, args: unknown) =>
  tool.execute(args, { agent: { session: {} } } as never)

describe('submit_plan 工具', () => {
  it('会话无编排 → 抛错', async () => {
    const tool = createSubmitPlanTool(() => undefined)
    await expect(run(tool, { steps: [{ file: 'a.md', title: 'A' }] })).rejects.toThrow(
      '没有进行中的 plan-and-execute 编排',
    )
  })
  it('批准 → 返回 { approved: true }', async () => {
    const tool = createSubmitPlanTool(
      () => ({ submitPlan: async () => ({ approved: true }) }) as never,
    )
    await expect(run(tool, { steps: [{ file: 'a.md', title: 'A' }] })).resolves.toEqual({
      approved: true,
    })
  })
  it('驳回 → 抛出反馈文本（模型看到反馈）', async () => {
    const tool = createSubmitPlanTool(
      () => ({ submitPlan: async () => ({ approved: false, error: '用户反馈：X' }) }) as never,
    )
    await expect(run(tool, { steps: [{ file: 'a.md', title: 'A' }] })).rejects.toThrow(
      '用户反馈：X',
    )
  })
})

describe('report_step 工具', () => {
  it('正常汇报 → 编排器收到当前步汇报并返回确认', async () => {
    const calls: Array<[string, string]> = []
    const tool = createReportStepTool(
      () =>
        ({
          reportStepForCurrent: (outcome: string, summary: string) => {
            calls.push([outcome, summary])
          },
        }) as never,
    )
    await expect(run(tool, { outcome: 'done', summary: '完成' })).resolves.toEqual({
      received: true,
    })
    expect(calls).toEqual([['done', '完成']])
  })
  it('outcome 非法 → 抛错', async () => {
    const tool = createReportStepTool(() => ({}) as never)
    await expect(run(tool, { outcome: 'oops', summary: 'x' })).rejects.toThrow(
      "outcome 必须是 'done' 或 'blocked'",
    )
  })
})

describe('reportStepForCurrent', () => {
  it('非执行期（批准后无当前步）→ 抛错', async () => {
    const { orchestrator } = await makeOrchestrator(
      [{ file: 'a.md', title: 'A' }],
      [answer('pae-approve', '批准')],
    )
    expect(() => orchestrator.reportStepForCurrent('done', '太早')).toThrow(
      'report_step 仅在执行阶段的当前步骤内可用',
    )
  })
})
