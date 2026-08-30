/**
 * 模型侧工具：submit_plan / report_step。编排器查表按 session 对象定位。
 * @module plan-and-execute/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Orchestrator } from './orchestrator.ts'

/** 按会话对象定位编排器的查表函数（无编排返回 undefined）。 */
type OrchestratorLookup = (session: object) => Orchestrator | undefined

/**
 * 构造 submit_plan 工具：规划阶段提交步骤清单供用户审批。
 * @param lookup - 会话 → 编排器查表（定位当前会话的编排器）。
 * @returns dsh 工具定义（已注册名称 submit_plan）。
 */
export function createSubmitPlanTool(lookup: OrchestratorLookup) {
  return defineTool({
    name: 'submit_plan',
    description:
      'Plan-and-Execute 规划阶段专用：提交步骤清单供用户审批。' +
      'steps[].file 是相对计划目录的步骤 Markdown 文件名（先写好文件再提交）。' +
      '用户驳回/搁置时返回 approved:false 且 feedback 字段携带用户反馈，按反馈修改后重新提交。',
    parameters: {
      planDir: {
        type: 'string',
        required: true,
        description: '计划目录（指令中给出的目录，原样传回）',
      },
      steps: {
        type: 'array',
        required: true,
        description: '步骤清单（顺序即执行顺序）',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            file: {
              type: 'string',
              required: true,
              description: '步骤 Markdown 文件名，相对计划目录',
            },
            title: { type: 'string', required: true, description: '步骤短标题' },
            requiresConfirmation: {
              type: 'boolean',
              description: '执行前需用户确认（风险步骤标记）',
            },
          },
        },
      },
      summary: { type: 'string', description: '计划一句话概述' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          approved: { type: 'boolean', required: true },
          feedback: { type: 'string', description: '未批准原因（用户驳回反馈或搁置说明）' },
        },
      } as const,
      // 结果文本：批准提示进入逐步执行；未批准附 feedback（驳回/搁置是正常流程，不抛错）。
      render: (_args, value) => [
        {
          type: 'text',
          text: value.approved
            ? '计划已批准。编排器将逐步注入步骤指令；请结束当前回合，等待第一步指令。'
            : `计划未获批准。${value.feedback === undefined ? '' : `\n${value.feedback}`}`,
        },
      ],
    },
    // 执行：按会话查编排器；无编排/无 agent 时抛错。
    execute: async (args, exec) => {
      if (exec.agent === undefined) throw new Error('submit_plan 需要调用 agent（无会话可切换）')
      const orchestrator = lookup(exec.agent.session as object)
      if (orchestrator === undefined) {
        throw new Error('当前会话没有进行中的 plan-and-execute 编排')
      }
      const verdict = await orchestrator.submitPlan(args.planDir, args.steps, args.summary)
      // 驳回/搁置是正常流程：以 approved:false + feedback 返回（不抛错，避免消息流红色 Error）
      if (!verdict.approved) return { approved: false, feedback: verdict.error }
      return { approved: true }
    },
    // 调用侧卡片：计划目录 + 步骤清单（确认点标记 ⚠）。
    presentCall: (args) => ({
      card: 'generic',
      title: `计划提交（${args.steps.length} 步）`,
      kind: 'other',
      content: [
        { type: 'text' as const, text: `计划目录：${args.planDir}` },
        ...args.steps.map(
          (
            step: { title: string; file: string; requiresConfirmation?: boolean },
            index: number,
          ) => ({
            type: 'text' as const,
            text: `${index + 1}. ${step.title} — ${step.file}${step.requiresConfirmation === true ? ' ⚠ 确认点' : ''}`,
          }),
        ),
      ],
    }),
  })
}

/**
 * 构造 report_step 工具：执行阶段汇报当前步骤结局。
 * @param lookup - 会话 → 编排器查表（定位当前会话的编排器）。
 * @returns dsh 工具定义（已注册名称 report_step）。
 */
export function createReportStepTool(lookup: OrchestratorLookup) {
  return defineTool({
    name: 'report_step',
    description:
      'Plan-and-Execute 执行阶段专用：汇报当前步骤结局。done=已完成本步全部工作；' +
      'blocked=本步无法完成（summary 写原因）。每步结束前必须调用。',
    parameters: {
      outcome: { type: 'string', required: true, description: "'done' 或 'blocked'" },
      summary: { type: 'string', required: true, description: '一两句结果/原因（改动要点、产出）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { received: { type: 'boolean', required: true } },
      } as const,
      // 结果文本：收到即已记录。
      render: (_args, value) => [{ type: 'text', text: value.received ? '已记录。' : '未记录。' }],
    },
    // 执行：outcome 校验 + 步号由编排器判定（reportStepForCurrent，防伪造）；无编排时抛错。
    execute: async (args, exec) => {
      if (exec.agent === undefined) throw new Error('report_step 需要调用 agent')
      const orchestrator = lookup(exec.agent.session as object)
      if (orchestrator === undefined) {
        throw new Error('当前会话没有进行中的 plan-and-execute 编排')
      }
      if (args.outcome !== 'done' && args.outcome !== 'blocked') {
        throw new Error(`outcome 必须是 'done' 或 'blocked'（收到：${args.outcome}）`)
      }
      orchestrator.reportStepForCurrent(args.outcome, args.summary)
      return { received: true }
    },
    // 调用侧卡片：结局标签 + 汇报摘要。
    presentCall: (args) => ({
      card: 'generic',
      title: `步骤汇报：${args.outcome}`,
      kind: 'other',
      content: [{ type: 'text', text: args.summary }],
    }),
  })
}
