/**
 * 两阶段 system-prompt 正文与全部注入消息构造。纯函数。
 * @module dsh-plan-and-execute/prompts
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

/**
 * 构造用户任务原文消息：source.kind='user'，与 dsh 内置 /plan 命令同语义
 * （用户输入以用户身份进入轨迹「用户」行、参与标题派生）。
 */
export function userTaskMessage(task: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: task }],
    source: { kind: 'user' },
  })
}

/** 规划阶段 system-prompt 段落正文（步骤文件规范 + submit_plan 纪律）。 */
export function PLANNING_SECTION_BODY(planDir: string): string {
  return [
    '## Plan-and-Execute：规划阶段',
    '你在 plan-and-execute 编排的规划阶段。先用只读工具充分调研，再制定分步计划。',
    `- 每一步写一个 Markdown 文件到 ${planDir}/：命名 step-NN-<短横线小写标识>.md，`,
    '  内容包含：目标、涉及文件、做法、验收标准。',
    '- 步骤要可独立执行、可验证、粒度适中；能拆则拆：尽量拆成多个可独立验证的步骤，',
    '  避免一个大步骤里塞多个事项。',
    '- 仅当任务确实原子、无法合理拆分时才允许单步计划，且必须在步骤文件开头或计划 summary 中',
    '  说明为何无法拆分（自证）。',
    '- 多个独立任务/独立事项 = 多个步骤文件，不要合并进同一个步骤。',
    '- 不可逆、外部影响、大范围写操作的步骤标记 requiresConfirmation: true。',
    '- 本阶段不做变更性操作：写文件仅限上述计划目录。',
    '- 全部步骤文件写完后，调用 submit_plan 提交步骤清单（file 相对计划目录）。',
    '  用户会审批；被驳回时按反馈修改文件后重新提交。',
    '  修订纪律：先用只读工具重新读取（read）要修改的步骤文件确认最新内容，再修改；',
    '  反馈中新增的独立任务/事项必须新建独立步骤文件（step-NN-*.md），不要并入现有步骤。',
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
    '- 当前步骤 Markdown 文件内容已内嵌在步骤指令中，是本步的唯一执行依据；需要确认最新状态时可重新读取该文件。',
    '- 文件内容与指令标题或任务文本不一致时，以文件内容为准，不要按标题或任务猜测执行。',
    '- 文件内容自相矛盾、无法确定本步该做什么时，调用 report_step(status=failed) 说明矛盾点，等待处理；不要自行挑选一种解释执行。',
    '- 上下文里只有上一步的简短结果；不要臆测更早步骤的细节，必要时用只读工具查看文件确认。',
    '- 本步结束前必须调用 report_step 汇报：完成用 status=success，受阻/失败用 status=failed；字段为 status、artifacts（本步产出/涉及的文件路径数组，可为空）、summary（尽量不超过 200 字的抽象描述）、exit_code（最后命令退出码，无命令可省略）。如实汇报，不谎报。',
    '- todo 清单由插件维护：不要调用 todo_write（整表替换会覆盖插件写入的进度）。',
    '- 不要调用 submit_plan（仅规划阶段可用）——本阶段的汇报工具只有 report_step。',
  ].join('\n')
}

/** 编排启动注入消息（规划阶段 kickoff；任务文本在锚定的 userTaskMessage 中，正文不重复）。 */
export function kickoffInstruction(task: string, planDir: string): UserMessage {
  return instruction(
    [
      'Plan-and-Execute 编排开始（任务文本见上方用户消息）。',
      `请进入规划阶段：调研后把每一步写成 Markdown 文件到 ${planDir}/，然后调用 submit_plan 提交清单供审批。`,
      '调用 submit_plan 时，planDir 参数必须原样传回上面的目录（不要改写或省略）。',
    ].join('\n'),
    `plan-and-execute：开始规划（${task}）`,
  )
}

/** 执行某步的注入消息（步骤 md 内容已内嵌 + 强制 report_step）。 */
export function stepInstruction(
  index: number,
  total: number,
  step: PlanStep,
  planDir: string,
  content: string,
): UserMessage {
  return instruction(
    [
      `执行计划第 ${index}/${total} 步：${step.title}`,
      `步骤文件（${planDir}/${step.file}）内容已内嵌，按此执行：`,
      '----',
      content,
      '----',
      '本步结束前必须调用 report_step 汇报（status、artifacts、summary尽量≤200字、exit_code），不要处理其他步骤。',
    ].join('\n'),
    `plan-and-execute：执行第 ${index}/${total} 步（${step.title}）`,
  )
}

/** 首步上下文消息：计划摘要（submit_plan 的 summary + 步骤清单）。 */
export function planSummaryContextMessage(plan: PaePlanPayload): UserMessage {
  return instruction(
    [
      '[plan-and-execute 计划摘要]',
      `概述：${plan.summary ?? '（无）'}`,
      `步骤（共 ${plan.steps.length} 步）：`,
      ...plan.steps.map((step, index) => `${index + 1}. ${step.title}（${step.file}）`),
    ].join('\n'),
    'plan-and-execute：计划摘要',
  )
}

/** 上一步上下文消息：上一步的 StepReport（report 已归一化，含合成的 skip/next 报告）。 */
export function stepReportContextMessage(
  index: number,
  total: number,
  stepTitle: string,
  report: PaeStepReportPayload,
): UserMessage {
  const statusText = report.status === 'success' ? '成功' : '失败'
  const artifactsText = report.artifacts.length === 0 ? '（无）' : report.artifacts.join('、')
  const exitText = report.exit_code === undefined ? '（无）' : String(report.exit_code)
  return instruction(
    [
      `[plan-and-execute 上一步结果：第 ${index}/${total} 步（${stepTitle}）]`,
      `状态：${statusText}`,
      `产物：${artifactsText}`,
      `摘要：${report.summary}`,
      `退出码：${exitText}`,
    ].join('\n'),
    `plan-and-execute：第 ${index}/${total} 步结果`,
  )
}

/** replan 上下文消息：用户反馈 + 原计划清单（replan 指令正文不再重复）。 */
export function replanContextMessage(feedback: string, plan: PaePlanPayload): UserMessage {
  return instruction(
    [
      '[plan-and-execute 计划修订]',
      `用户反馈：${feedback || '（无文字反馈）'}`,
      `原计划（共 ${plan.steps.length} 步）：`,
      ...plan.steps.map((step, index) => `${index + 1}. ${step.title}（${step.file}）`),
    ].join('\n'),
    'plan-and-execute：计划修订反馈',
  )
}

/** 缺报提示注入消息（要求立即 report_step）。 */
export function nudgeInstruction(): UserMessage {
  return instruction(
    '本步尚未汇报结果。请立即调用 report_step（status=success 或 failed，artifacts、summary尽量≤200字、exit_code 按实填写）汇报当前步骤的结局。',
    'plan-and-execute：要求补交 report_step',
  )
}

/** 自愈重试注入消息（按诊断调整做法重试当前步）。 */
export function recoverInstruction(diagnostic: string): UserMessage {
  return instruction(
    [
      `上一步执行未成功（${diagnostic}）。请自行调整做法重试当前步骤，或修正后续步骤文件后继续；`,
      '确无法完成则调用 report_step(status=failed, summary=原因)。完成后仍须 report_step 汇报。',
    ].join('\n'),
    'plan-and-execute：自愈重试当前步骤',
  )
}

/** 回到规划阶段的注入消息（反馈文本在 replanContextMessage 中，正文不重复）。 */
export function replanInstruction(previousSteps: number): UserMessage {
  return instruction(
    [
      `用户要求回到规划阶段（原有 ${previousSteps} 步的计划未通过/被中止；反馈见上方消息）。`,
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
