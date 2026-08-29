/**
 * 两阶段 system-prompt 正文与全部注入消息构造。纯函数。
 * @module plan-and-execute/prompts
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import {
  PAE_PLUGIN,
  type PaePlanPayload,
  type PaeStepReportPayload,
  type PlanStep,
} from './state.ts'

/** 构造插件注入消息：source.kind='plugin'（不参与 dsh 用户消息语义，如自动标题派生）。 */
function instruction(text: string, summary: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: PAE_PLUGIN, form: 'instructions', summary },
  })
}

/** 规划阶段 system-prompt 段落正文（步骤文件规范 + submit_plan 纪律）。 */
export function PLANNING_SECTION_BODY(planDir: string): string {
  return [
    '## Plan-and-Execute：规划阶段',
    '你在 plan-and-execute 编排的规划阶段。先用只读工具充分调研，再制定分步计划。',
    `- 每一步写一个 Markdown 文件到 ${planDir}/：命名 step-NN-<短横线小写标识>.md，`,
    '  内容包含：目标、涉及文件、做法、验收标准。',
    '- 步骤要可独立执行、可验证、粒度适中；单步计划也合法。',
    '- 不可逆、外部影响、大范围写操作的步骤标记 requiresConfirmation: true。',
    '- 本阶段不做变更性操作：写文件仅限上述计划目录。',
    '- 全部步骤文件写完后，调用 submit_plan 提交步骤清单（file 相对计划目录）。',
    '  用户会审批；被驳回时按反馈修改文件后重新提交。',
    '- 不要调用 exit_plan_mode——它属于 dsh 的 plan-mode 功能，本编排不使用；',
    '  计划审批只通过 submit_plan 完成。',
    '调用 submit_plan 时，planDir 参数必须原样传回上面的目录（不要改写或省略）。',
  ].join('\n')
}

/** 执行阶段 system-prompt 段落正文（每步一指令 + report_step 纪律）。 */
export function EXECUTING_SECTION_BODY(): string {
  return [
    '## Plan-and-Execute：执行阶段',
    '你在 plan-and-execute 编排的执行阶段，每次只处理"当前这一步"：',
    '- 只做当前步骤要求的事，不做后续步骤（除非当前步骤文件明确要求）。',
    '- 开始前先读取当前步骤的 Markdown 文件。',
    '- 本步结束前必须调用 report_step 汇报：完成用 outcome=done，受阻用 outcome=blocked，如实汇报，不谎报。',
    '- 发现计划有误时：完成当前步能完成的部分并在 summary 说明，或 report_step(blocked) 说明原因；不要自行跳步或改做其他步骤。',
    '- todo 清单由插件维护：不要调用 todo_write（整表替换会覆盖插件写入的进度）。',
    '- 不要调用 submit_plan（仅规划阶段可用）或 exit_plan_mode（dsh plan-mode 的工具）——本阶段的汇报工具只有 report_step。',
  ].join('\n')
}

/** 编排启动注入消息（规划阶段 kickoff，含任务文本）。 */
export function kickoffInstruction(task: string, planDir: string): UserMessage {
  return instruction(
    [
      `Plan-and-Execute 编排开始。任务：${task}`,
      `请进入规划阶段：调研后把每一步写成 Markdown 文件到 ${planDir}/，然后调用 submit_plan 提交清单供审批。`,
      '调用 submit_plan 时，planDir 参数必须原样传回上面的目录（不要改写或省略）。',
    ].join('\n'),
    `plan-and-execute：开始规划（${task}）`,
  )
}

/** 执行某步的注入消息（先读步骤文件再动手 + 强制 report_step）。 */
export function stepInstruction(
  index: number,
  total: number,
  step: PlanStep,
  planDir: string,
): UserMessage {
  return instruction(
    [
      `执行计划第 ${index}/${total} 步：${step.title}`,
      `完整内容见 ${planDir}/${step.file}，先读取该文件再动手。`,
      '完成或受阻都必须调用 report_step 汇报（done/blocked + summary），不要处理其他步骤。',
    ].join('\n'),
    `plan-and-execute：执行第 ${index}/${total} 步（${step.title}）`,
  )
}

/** 缺报提示注入消息（要求立即 report_step）。 */
export function nudgeInstruction(): UserMessage {
  return instruction(
    '本步尚未汇报结果。请立即调用 report_step（outcome=done 或 blocked，summary 必填）汇报当前步骤的结局。',
    'plan-and-execute：要求补交 report_step',
  )
}

/** 自愈重试注入消息（按诊断调整做法重试当前步）。 */
export function recoverInstruction(diagnostic: string): UserMessage {
  return instruction(
    [
      `上一步执行未成功（${diagnostic}）。请自行调整做法重试当前步骤，或修正后续步骤文件后继续；`,
      '确无法完成则调用 report_step(outcome=blocked, summary=原因)。完成后仍须 report_step 汇报。',
    ].join('\n'),
    'plan-and-execute：自愈重试当前步骤',
  )
}

/** 回到规划阶段的注入消息（携带用户驳回反馈）。 */
export function replanInstruction(feedback: string, previousSteps: number): UserMessage {
  return instruction(
    [
      `用户要求回到规划阶段（原有 ${previousSteps} 步的计划未通过/被中止）。反馈：${feedback || '（无文字反馈）'}`,
      '请按反馈修改步骤 Markdown 文件（可增删改步骤），然后重新调用 submit_plan 提交审批。',
    ].join('\n'),
    'plan-and-execute：回到规划阶段',
  )
}

/** 恢复规划阶段的注入消息（续写步骤文件并重新提交）。 */
export function resumePlanningInstruction(): UserMessage {
  return instruction(
    '编排恢复：继续完成规划阶段的调研与步骤文件编写，完成后调用 submit_plan 提交审批。',
    'plan-and-execute：恢复规划',
  )
}

/** 审批弹窗的计划清单详情文本（步骤号 + 标题 + 文件 + 确认点标记）。 */
export function planReviewDetail(steps: readonly PlanStep[], planDir: string): string {
  const lines = steps.map((step, index) => {
    const mark = step.requiresConfirmation === true ? ' ⚠ 确认点' : ''
    return `${index + 1}. ${step.title} — ${step.file}${mark}`
  })
  return [`计划目录：${planDir}`, ...lines].join('\n')
}

/** 完成通知的逐步结局详情文本（done/blocked/skipped + 汇报摘要）。 */
export function completionDetail(
  steps: readonly PlanStep[],
  reports: ReadonlyMap<number, PaeStepReportPayload>,
  skipped: ReadonlySet<number>,
): string {
  const lines = steps.map((step, index) => {
    const i = index + 1
    if (skipped.has(i)) return `${i}. ${step.title} — skipped`
    const report = reports.get(i)
    return `${i}. ${step.title} — ${report?.outcome ?? 'done'}：${report?.summary ?? ''}`
  })
  return lines.join('\n')
}

/** 计划的一句话摘要（缺省时退化为"共 N 步"）。 */
export function planSummaryLine(plan: PaePlanPayload): string {
  return plan.summary ?? `共 ${plan.steps.length} 步`
}
