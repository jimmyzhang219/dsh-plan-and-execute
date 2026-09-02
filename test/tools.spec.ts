import { describe, expect, it } from 'vitest'
import { createReportStepTool, createSubmitPlanTool } from '../src/tools.ts'
import { answer, makeOrchestrator } from './helpers.ts'

const run = (tool: { execute: (args: unknown, exec: never) => Promise<unknown> }, args: unknown) =>
  tool.execute(args, { agent: { session: {} } } as never)

describe('submit_plan 工具', () => {
  it('参数 schema 声明 planDir 必填', () => {
    const tool = createSubmitPlanTool(() => undefined)
    expect(tool.parameters.required).toContain('planDir')
  })
  it('会话无编排 → 抛错', async () => {
    const tool = createSubmitPlanTool(() => undefined)
    await expect(
      run(tool, { planDir: '<测试目录>', steps: [{ file: 'a.md', title: 'A' }] }),
    ).rejects.toThrow('没有进行中的 plan-and-execute 编排')
  })
  it('批准 → 返回 { approved: true }', async () => {
    const tool = createSubmitPlanTool(
      () => ({ submitPlan: async () => ({ approved: true }) }) as never,
    )
    await expect(
      run(tool, { planDir: '<测试目录>', steps: [{ file: 'a.md', title: 'A' }] }),
    ).resolves.toEqual({ approved: true })
  })
  it('驳回/搁置 → 正常返回 { approved: false, feedback }（不抛错，消息流不显示红色 Error）', async () => {
    const tool = createSubmitPlanTool(
      () => ({ submitPlan: async () => ({ approved: false, error: '用户反馈：X' }) }) as never,
    )
    await expect(
      run(tool, { planDir: '<测试目录>', steps: [{ file: 'a.md', title: 'A' }] }),
    ).resolves.toEqual({ approved: false, feedback: '用户反馈：X' })
  })
})

describe('report_step 工具', () => {
  it('正常汇报 → 编排器收到当前步汇报并返回确认', async () => {
    const calls: Array<{
      status: string
      artifacts: string[]
      summary: string
      exitCode?: number
    }> = []
    const tool = createReportStepTool(
      () =>
        ({
          reportStepForCurrent: (
            status: string,
            artifacts: string[],
            summary: string,
            exitCode?: number,
          ) => {
            calls.push({ status, artifacts, summary, exitCode })
          },
        }) as never,
    )
    await expect(
      run(tool, { status: 'success', artifacts: ['a.md'], summary: '完成', exit_code: 0 }),
    ).resolves.toEqual({ received: true })
    expect(calls).toEqual([
      { status: 'success', artifacts: ['a.md'], summary: '完成', exitCode: 0 },
    ])
  })
  it('status 非法 → 抛错', async () => {
    const tool = createReportStepTool(() => ({}) as never)
    await expect(run(tool, { status: 'oops', artifacts: [], summary: 'x' })).rejects.toThrow(
      "status 必须是 'success' 或 'failed'",
    )
  })
  it('summary 超长 → 不抛错（长度仅软约束）', async () => {
    const calls: Array<{
      status: string
      artifacts: string[]
      summary: string
      exitCode?: number
    }> = []
    const tool = createReportStepTool(
      () =>
        ({
          reportStepForCurrent: (
            status: string,
            artifacts: string[],
            summary: string,
            exitCode?: number,
          ) => {
            calls.push({ status, artifacts, summary, exitCode })
          },
        }) as never,
    )
    await expect(
      run(tool, { status: 'success', artifacts: [], summary: '超'.repeat(200), exit_code: 0 }),
    ).resolves.toEqual({ received: true })
    expect(calls).toEqual([
      { status: 'success', artifacts: [], summary: '超'.repeat(200), exitCode: 0 },
    ])
  })
  it('exit_code 与 status 矛盾 → 抛错', async () => {
    const tool = createReportStepTool(() => ({}) as never)
    await expect(
      run(tool, { status: 'success', artifacts: [], summary: 'x', exit_code: 1 }),
    ).rejects.toThrow('status=success 时 exit_code 必须为 0')
    await expect(
      run(tool, { status: 'failed', artifacts: [], summary: 'x', exit_code: 0 }),
    ).rejects.toThrow('status=failed 时 exit_code 不能为 0')
  })
  it('artifacts 超限（>20 项 / 超长项）→ 抛错', async () => {
    const tool = createReportStepTool(() => ({}) as never)
    await expect(
      run(tool, { status: 'success', artifacts: Array(21).fill('f'), summary: 'x' }),
    ).rejects.toThrow('artifacts 必须是数组且不超过 20 项')
    await expect(
      run(tool, { status: 'success', artifacts: ['超'.repeat(121)], summary: 'x' }),
    ).rejects.toThrow('artifacts 每项必须是非空字符串且不超过 120 字')
  })
})

describe('reportStepForCurrent', () => {
  it('非执行期（批准后无当前步）→ 抛错', async () => {
    const { orchestrator } = await makeOrchestrator(
      [{ file: 'a.md', title: 'A' }],
      [answer('pae-approve', '批准')],
    )
    await expect(orchestrator.reportStepForCurrent('success', [], '太早')).rejects.toThrow(
      'report_step 仅在执行阶段的当前步骤内可用',
    )
  })
})
