/**
 * plan-and-execute：dsh 插件入口（组合根）。
 * 开发装载：scripts/dev.mjs → `pnpm dsh web --patch .overlay.dev.yml`；
 * 正式安装：`dsh plugin --profile <name> add <本工程目录>`（读 dsh.bundle.patch）。
 * @module plan-and-execute
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
// Type-only：激活各宿主包的 Context 合并（ctx.commands/tools/systemPrompt/事件类型）。
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-questions'
import { Orchestrator, type DriveAgent, type DriveSession } from './orchestrator.ts'
import { EXECUTING_SECTION_BODY, PLANNING_SECTION_BODY } from './prompts.ts'
import { foldPae, isPlanModeActive } from './state.ts'
import { createReportStepTool, createSubmitPlanTool } from './tools.ts'

export const name = 'plan-and-execute'
export const inject = ['tools', 'systemPrompt']

export interface Config {
  /** 步骤级失败策略：默认暂停问人。 */
  onStepFailure: 'pause' | 'auto-recover'
  /** auto-recover 模式下单步自愈次数上限。 */
  maxAutoRecoveries: number
  /** 计划根目录（相对会话 cwd）；实际目录 = <planDir>/<sessionId>/<runToken>。 */
  planDir: string
}

export const Config: Schema<Config> = Schema.object({
  onStepFailure: Schema.union(['pause', 'auto-recover'])
    .description('步骤失败策略')
    .default('pause'),
  maxAutoRecoveries: Schema.number().description('单步自愈次数上限（仅 auto-recover）').default(2),
  planDir: Schema.string().description('计划文件根目录（相对会话 cwd）').default('.pae'),
})

/** 真 Agent → 窄结构接口的唯一适配点（append 的条件重载在这里一次性断言）。 */
function toDriveAgent(agent: Agent): DriveAgent {
  const session = agent.session
  const drive: DriveSession = {
    events: session.events,
    append: (eventType, data) => {
      ;(session.append as unknown as (t: string, d: object) => void)(eventType, data)
    },
  }
  return {
    session: drive,
    steer: (message) => agent.steer(message),
    whenIdle: () => agent.whenIdle(),
  }
}

export function apply(ctx: Context, config: Config): void {
  console.log('[plan-and-execute] plugin loaded')
  /** 每 session 一个编排器；key 是 session 对象本身。 */
  const orchestrators = new WeakMap<object, Orchestrator>()

  const askFor = (agent: Agent) => (questions: AskUserQuestionItem[]) => {
    const service = ctx.get('userQuestions')
    if (service === undefined) throw new Error('no user-questions channel available')
    return service.ask({ questions, agent })
  }

  const ensure = (agent: Agent): Orchestrator => {
    const existing = orchestrators.get(agent.session as object)
    if (existing !== undefined) return existing
    const cwd = agent.session.header.cwd ?? process.cwd()
    const runToken = new Date()
      .toISOString()
      .replaceAll(/[-:TZ.]/g, '')
      .slice(0, 14)
    const planDir = `${cwd}/${config.planDir}/${String(agent.id)}/${runToken}`
    const orchestrator = new Orchestrator({
      agent: toDriveAgent(agent),
      ask: askFor(agent),
      config: {
        onStepFailure: config.onStepFailure,
        maxAutoRecoveries: config.maxAutoRecoveries,
        planRoot: config.planDir,
      },
      planDir,
    })
    orchestrators.set(agent.session as object, orchestrator)
    ctx.effect(() => () => orchestrator.dispose(), 'plan-and-execute: dispose orchestrators')
    return orchestrator
  }

  // —— 命令入口（命令注册表为可选服务：headless 部署无 commands 时插件仍可加载）——
  ctx.inject(['commands'], (commandCtx) =>
    commandCtx.commands.register({
      name: 'plan-and-execute',
      description: 'Plan-and-Execute：规划 → 审批 → 逐步执行（支持确认点与失败暂停）',
      input: { hint: '<任务描述>' },
      handler: ({ agent, rawInput }) => {
        const task = rawInput.trim()
        if (task === '') {
          return { kind: 'error', text: '请提供任务描述：/plan-and-execute <任务>' }
        }
        if (ctx.get('userQuestions') === undefined) {
          return { kind: 'error', text: '当前部署没有用户交互通道（userQuestions），无法审批计划' }
        }
        if (agent.status !== 'idle') {
          return { kind: 'error', text: `agent 正忙（${agent.status}），请等当前回合结束后再启动` }
        }
        if (isPlanModeActive(agent.session.events)) {
          return { kind: 'error', text: 'plan-mode 处于激活状态，请先 /plan off（两者互斥）' }
        }
        const folded = foldPae(agent.session.events)
        if (folded.phase === 'planning' || folded.phase === 'executing') {
          return {
            kind: 'error',
            text: '本会话已有进行中的 plan-and-execute 编排（暂停态可再次输入 /plan-and-execute 重新弹出选项）',
          }
        }
        const orchestrator = ensure(agent)
        if (folded.phase === 'paused') {
          void orchestrator.revive()
          return { kind: 'success', text: '已重新弹出暂停选项。' }
        }
        orchestrator.begin(task)
        return {
          kind: 'success',
          text: 'Plan-and-Execute 已启动：进入规划阶段，等待模型提交计划。',
        }
      },
    }),
  )

  // —— 模型侧工具 ——
  const lookup = (session: object): Orchestrator | undefined => orchestrators.get(session)
  ctx.tools.register(createSubmitPlanTool(lookup))
  ctx.tools.register(createReportStepTool(lookup))

  // —— 阶段 prompt sections ——
  ctx.systemPrompt.section({
    name: 'pae:planning',
    order: 50,
    text: (context) => {
      const agent = context.agent
      if (agent === undefined) return ''
      const folded = foldPae(agent.session.events)
      return folded.phase === 'planning' ? PLANNING_SECTION_BODY(folded.planDir ?? '') : ''
    },
  })
  ctx.systemPrompt.section({
    name: 'pae:executing',
    order: 51,
    text: (context) => {
      const agent = context.agent
      if (agent === undefined) return ''
      const folded = foldPae(agent.session.events)
      return folded.phase === 'executing' || folded.phase === 'paused'
        ? EXECUTING_SECTION_BODY()
        : ''
    },
  })

  // —— 重启/重建恢复：agent/created 时折叠状态，中断态弹恢复交互 ——
  ctx.on('agent/created', ({ agent }: { agent: Agent }) => {
    const folded = foldPae(agent.session.events)
    if (folded.phase === 'none' || folded.phase === 'completed' || folded.phase === 'aborted')
      return
    const orchestrator = ensure(agent)
    void orchestrator.revive()
  })
}
