/**
 * plan-and-execute：dsh 插件入口（组合根）。
 * 开发装载：scripts/dev.mjs → `pnpm dsh web --patch .overlay.dev.yml`；
 * 正式安装：`dsh plugin --profile <name> add <本工程目录>`（读 dsh.bundle.patch）。
 * @module plan-and-execute
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
// Type-only：激活各宿主包的 Context 合并（ctx.commands/tools/systemPrompt/sessionTitle/事件类型）。
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-session-title'
// Type-only：todo/write 事件的 SessionEventMap 合并声明由 dsh-tool-todo 拥有。
import type {} from '@deepseek-ai/dsh-tool-todo'
import { Orchestrator, type DriveAgent, type DriveSession } from './orchestrator.ts'
import { fileStorage } from './persist.ts'
import { EXECUTING_SECTION_BODY, PLANNING_SECTION_BODY } from './prompts.ts'
import { isPlanModeActive, type PaeStepModel } from './state.ts'
import { createReportStepTool, createSubmitPlanTool } from './tools.ts'

/** 插件名（命令名、编排目录命名空间）。 */
export const name = 'plan-and-execute'
/** 必需服务注入：工具注册表与 system-prompt 段落表。 */
export const inject = ['tools', 'systemPrompt']

/** 插件配置：失败策略、自愈上限、计划目录根。 */
export interface Config {
  /** 步骤级失败策略：默认暂停问人。 */
  onStepFailure: 'pause' | 'auto-recover'
  /** auto-recover 模式下单步自愈次数上限。 */
  maxAutoRecoveries: number
  /** 计划根目录（相对会话 cwd）；实际目录 = <planDir>/<sessionId>。 */
  planDir: string
}

/** 配置 schema（dsh 装配层据此读取配置并生成表单）。 */
export const Config: Schema<Config> = Schema.object({
  onStepFailure: Schema.union(['pause', 'auto-recover'])
    .description('步骤失败策略')
    .default('pause'),
  maxAutoRecoveries: Schema.number().description('单步自愈次数上限（仅 auto-recover）').default(2),
  planDir: Schema.string().description('计划文件根目录（相对会话 cwd）').default('.pae'),
})

/** 真 Agent → 窄结构接口的唯一适配点（todo/write 是宿主白名单事件）。 */
function toDriveAgent(agent: Agent): DriveAgent {
  const session = agent.session
  const drive: DriveSession = {
    events: session.events,
    writeTodos: (todos) => {
      session.append('todo/write', { todos: [...todos] })
    },
  }
  return {
    session: drive,
    steer: (message) => agent.steer(message),
    whenIdle: () => agent.whenIdle(),
  }
}

/**
 * 插件组合根：注册命令、模型侧工具、阶段 prompt 段落与恢复监听。
 * @param ctx - dsh 上下文（commands/tools/systemPrompt/sessionTitle 等为可选服务）。
 * @param config - 插件配置。
 */
export function apply(ctx: Context, config: Config): void {
  console.log('[plan-and-execute] plugin loaded')
  /** 每 session 一个编排器；key 是 session 对象本身。 */
  const orchestrators = new WeakMap<object, Orchestrator>()

  /** 会话计划目录：<会话 cwd>/<planDir>/<sessionId>。 */
  const planDirOf = (agent: Agent): string => {
    const cwd = agent.session.header.cwd ?? process.cwd()
    return `${cwd}/${config.planDir}/${String(agent.id)}`
  }

  /** 用户交互通道包装（部署无 userQuestions 时抛错）。 */
  const askFor = (agent: Agent) => (questions: AskUserQuestionItem[]) => {
    const service = ctx.get('userQuestions')
    if (service === undefined) throw new Error('no user-questions channel available')
    return service.ask({ questions, agent })
  }

  /**
   * 编排激活时对当前 agent 排除 plan-mode 的 exit_plan_mode 工具（agent-scoped
   * restrict，不影响其他 agent/会话）。部署未组合 plan-mode 时该工具不在
   * 全局工具表，restrict 会抛错——此时无需排除，忽略即可。
   * activate 幂等（restore 后置空，可再次激活）。
   */
  const createToolMask = (agent: Agent): { activate: () => void; restore: () => void } => {
    let dispose: (() => void) | undefined
    return {
      activate: () => {
        if (dispose !== undefined) return
        try {
          dispose = agent.ctx.tools.restrict({ deny: ['exit_plan_mode'] })
        } catch {
          // 部署无 plan-mode：无可排除的工具，保持现状
        }
      },
      restore: () => {
        dispose?.()
        dispose = undefined
      },
    }
  }

  /** 取或建本会话的编排器（首次创建时注册释放钩子）。 */
  const ensure = (agent: Agent): Orchestrator => {
    const existing = orchestrators.get(agent.session as object)
    if (existing !== undefined) return existing
    const planDir = planDirOf(agent)
    const mask = createToolMask(agent)
    const orchestrator = new Orchestrator({
      agent: toDriveAgent(agent),
      ask: askFor(agent),
      config: {
        onStepFailure: config.onStepFailure,
        maxAutoRecoveries: config.maxAutoRecoveries,
        planRoot: config.planDir,
      },
      planDir,
      storage: fileStorage(planDir),
      hooks: {
        onActivate: mask.activate,
        onRestore: mask.restore,
      },
    })
    orchestrators.set(agent.session as object, orchestrator)
    ctx.effect(() => () => orchestrator.dispose(), 'plan-and-execute: dispose orchestrators')
    // 每步模型切换：agent/request waterfall 按当前步覆盖 LlmCallConfig。
    // 与宿主 installModelSelection 同一机制（后注册者最后覆盖）；无映射时透传。
    const disposeStepModel = agent.ctx.on(
      'agent/request',
      async (_payload: unknown, next: () => Promise<LlmCallConfig>): Promise<LlmCallConfig> => {
        const resolved = await next()
        const stepIndex = orchestrator.snapshot().stepIndex ?? 0
        const selected = orchestrator.stepModelFor(stepIndex)
        if (selected === undefined) return resolved
        // 与宿主 installModelSelection 同一语义：先剥离 seed 继承的 reasoningEffort，
        // 再按选择重加（否则会话模型带 effort 而映射模型不带时，effort 泄漏到映射模型，
        // 不支持的组合会在 prepareCall 抛 UNSUPPORTED_REASONING_EFFORT）。
        const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = resolved
        return {
          ...withoutInheritedEffort,
          provider: selected.provider,
          model: selected.model,
          // PaeStepModel.reasoningEffort 为普通 string；LlmCallConfig 为品牌类型，
          // 断言进品牌槽（可用性由适配器在实际调用时校验）。
          ...(selected.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: selected.reasoningEffort as LlmCallConfig['reasoningEffort'] }),
        }
      },
    )
    ctx.effect(() => () => disposeStepModel(), 'plan-and-execute: step model waterfall')
    return orchestrator
  }

  // —— 命令入口（命令注册表为可选服务：headless 部署无 commands 时插件仍可加载）——
  /** 会话 → 编排器查表（两个命令与模型侧工具定位当前会话的编排器）。 */
  const lookup = (session: object): Orchestrator | undefined => orchestrators.get(session)
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'plan-and-execute',
      description: 'Plan-and-Execute：规划 → 审批 → 逐步执行（支持确认点与失败暂停）',
      input: { hint: '<任务描述>' },
      handler: async ({ agent, rawInput }) => {
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
        const loaded = await fileStorage(planDirOf(agent)).load()
        const phase = loaded?.phase ?? 'none'
        if (phase === 'planning' || phase === 'executing') {
          return {
            kind: 'error',
            text: '本会话已有进行中的 plan-and-execute 编排（暂停态可再次输入 /plan-and-execute 重新弹出选项）',
          }
        }
        const orchestrator = ensure(agent)
        if (phase === 'paused') {
          void orchestrator.revive()
          return { kind: 'success', text: '已重新弹出暂停选项。' }
        }
        // 新编排用任务文本钉住会话标题：无标题会话的显示回退链会退到 cwd
        // basename（如 "deepseek-harness"）。已有标题（用户改过名/有过对话）
        // 不覆盖；session-title 为可选服务（headless 未组合时跳过）。
        const titles = ctx.get('sessionTitle')
        if (titles !== undefined && titles.get(agent.session) === undefined) {
          try {
            titles.rename(agent.session, task)
          } catch (error: unknown) {
            ctx.logger.warn(`plan-and-execute: 会话标题写入失败：${String(error)}`)
          }
        }
        await orchestrator.begin(task)
        return {
          kind: 'success',
          text: 'Plan-and-Execute 已启动：进入规划阶段，等待模型提交计划。',
        }
      },
    })
    commandCtx.commands.register({
      name: 'plan-and-execute-set-models',
      description:
        'Plan-and-Execute：设置各步骤执行模型（Web UI 步骤卡片调用）。' +
        '载荷为 JSON：{"1":{"provider":"...","model":"..."}}（步骤号 1-based）。',
      input: { hint: '<json>' },
      handler: async ({ agent, rawInput }) => {
        const orchestrator = lookup(agent.session as object)
        if (orchestrator === undefined) {
          return { kind: 'error', text: '当前会话没有 plan-and-execute 编排' }
        }
        // ctx.get 的泛型重载约束为 Context 服务名，外部服务名须用 as 断言形状
        const llm = ctx.get('llm') as
          | {
              resolveCallConfig: (c: {
                provider: string
                model: string
              }) => Promise<{ provider: string; model: string; reasoningEffort?: string }>
            }
          | undefined
        if (llm === undefined) return { kind: 'error', text: '当前部署没有 llm 服务，无法校验模型' }
        let parsed: unknown
        try {
          parsed = JSON.parse(rawInput.trim())
        } catch {
          return { kind: 'error', text: '载荷不是合法 JSON' }
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          return { kind: 'error', text: '载荷必须是 {步骤号: {provider, model}} 对象' }
        }
        const models: Record<number, PaeStepModel> = {}
        for (const [key, value] of Object.entries(parsed)) {
          const index = Number(key)
          const v = value as { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
          if (
            !Number.isInteger(index) ||
            typeof v?.provider !== 'string' ||
            typeof v?.model !== 'string'
          ) {
            return { kind: 'error', text: `第 ${key} 项缺少 provider/model 字符串字段` }
          }
          let resolved: { provider: string; model: string; reasoningEffort?: string }
          try {
            resolved = await llm.resolveCallConfig({ provider: v.provider, model: v.model })
          } catch (error) {
            return {
              kind: 'error',
              text: `模型 ${v.provider}/${v.model} 不可用：${
                error instanceof Error ? error.message : String(error)
              }`,
            }
          }
          models[index] = {
            provider: resolved.provider,
            model: resolved.model,
            ...(resolved.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: resolved.reasoningEffort }),
            ...(typeof v.reasoningEffort === 'string' ? { reasoningEffort: v.reasoningEffort } : {}),
          }
        }
        const result = await orchestrator.applyStepModels(models)
        return result.ok
          ? { kind: 'success', text: `已设置 ${Object.keys(models).length} 个步骤的模型` }
          : { kind: 'error', text: result.error }
      },
    })
  })

  // —— 模型侧工具 ——
  ctx.tools.register(createSubmitPlanTool(lookup))
  ctx.tools.register(createReportStepTool(lookup))

  // —— 阶段 prompt sections（读编排器内存态；未加载时渲染空）——
  ctx.systemPrompt.section({
    name: 'pae:planning',
    order: 50,
    text: (context) => {
      const agent = context.agent
      if (agent === undefined) return ''
      const orchestrator = orchestrators.get(agent.session as object)
      const snapshot = orchestrator?.snapshot()
      return snapshot?.phase === 'planning' ? PLANNING_SECTION_BODY(snapshot.planDir ?? '') : ''
    },
  })
  ctx.systemPrompt.section({
    name: 'pae:executing',
    order: 51,
    text: (context) => {
      const agent = context.agent
      if (agent === undefined) return ''
      const orchestrator = orchestrators.get(agent.session as object)
      const snapshot = orchestrator?.snapshot()
      return snapshot !== undefined &&
        (snapshot.phase === 'executing' || snapshot.phase === 'paused')
        ? EXECUTING_SECTION_BODY()
        : ''
    },
  })

  // —— 重启/重建恢复：agent/created 时读持久化状态，中断态弹恢复交互 ——
  ctx.on('agent/created', ({ agent }: { agent: Agent }) => {
    void (async () => {
      const loaded = await fileStorage(planDirOf(agent)).load()
      if (loaded === undefined || loaded.phase === 'completed' || loaded.phase === 'aborted') return
      const orchestrator = ensure(agent)
      void orchestrator.revive()
    })()
  })
}
