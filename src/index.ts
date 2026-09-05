/**
 * dsh-plan-and-execute：dsh 插件入口（组合根）。
 * 开发装载：scripts/dev.mjs → `pnpm dsh web --patch .overlay.dev.yml`；
 * 正式安装：`dsh plugin --profile <name> add <本工程目录>`（读 dsh.bundle.patch）。
 * @module dsh-plan-and-execute
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
// 值导入：当前宿主（dsh-v0.1.2+）把 surface 区间与 sourceEventSeqs 品牌化为
// SessionSeq（运行时为校验+同值返回的 number），append 边界需经构造器承认。
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
// Type-only：激活各宿主包的 Context 合并（ctx.commands/tools/systemPrompt/sessionTitle/事件类型）。
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-session-title'
// Type-only：ctx.settings 服务与 settings/updated 事件的 Context 合并。
import type {} from '@deepseek-ai/dsh-settings'
// Type-only：todo/write 事件的 SessionEventMap 合并声明由 dsh-tool-todo 拥有。
import type {} from '@deepseek-ai/dsh-tool-todo'
import { Orchestrator, type DriveAgent, type DriveSession } from './orchestrator.ts'
import { fileStorage } from './persist.ts'
import { ScheduleRegistry } from './schedule.ts'
import {
  PAE_MODELS_NS,
  PAE_MODELS_SCHEMA,
  parsePaeModels,
  PAE_PING_NS,
  PAE_PING_SCHEMA,
  parsePaePing,
} from './settings.ts'
import { EXECUTING_SECTION_BODY, PLANNING_SECTION_BODY } from './prompts.ts'
import { isPlanModeActive } from './state.ts'
import { createReportStepTool, createSubmitPlanTool } from './tools.ts'

/** 插件名（dsh 插件注册名；斜杠命令见下方命令注册）。 */
export const name = 'dsh-plan-and-execute'
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

/** 真 Agent → 窄结构接口的唯一适配点（todo/write 与 surface replace 均为宿主公开 API）。 */
function toDriveAgent(agent: Agent): DriveAgent {
  const session = agent.session
  const drive: DriveSession = {
    // 宿主 Session 无 .events 属性，以 snapshotEvents() 提供全量日志只读快照。
    events: session.snapshotEvents(),
    surface: session.surface,
    writeTodos: (todos) => {
      session.append('todo/write', { todos: [...todos] })
    },
    // 以 replace surfaceOp 追加 user/message，遮蔽 [start..end] surface 节点区间
    // （仅裁剪模型投影 deriveMessages；事件日志与 UI 轨迹保留，restore 时重放）。
    // 区间与来源 seq 为宿主品牌类型 SessionSeq，须经构造器承认。
    replaceSurface: (message, start, end, sourceEventSeqs) => {
      // 必须以方法形式调用宿主 Session.append（保留 this 绑定）：Session.append
      // 内部读 this.log，抽出为裸函数调用会丢 this 抛 “Cannot read properties of undefined”。
      const event = session.append('user/message', message, {
        surfaceOp: { op: 'replace', start: SessionSeq(start), end: SessionSeq(end) },
        sourceEventSeqs: [...sourceEventSeqs].map((seq) => SessionSeq(seq)),
      })
      return event.seq
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
  console.log('[dsh-plan-and-execute] plugin loaded')
  /** 进程内定时注册表（schedule 阶段排期；随插件卸载释放）。 */
  const scheduleRegistry = new ScheduleRegistry()
  ctx.effect(() => () => scheduleRegistry.dispose(), 'dsh-plan-and-execute: schedule registry')
  /** 每 session 一个编排器；key 是 session 对象本身。 */
  const orchestrators = new WeakMap<object, Orchestrator>()
  /** sessionId → 编排器（settings/updated 桥接按载荷中的 sessionId 定位）。 */
  const bySessionId = new Map<string, Orchestrator>()

  /** 会话计划目录：<会话 cwd>/<planDir>/<sessionId>。 */
  const planDirOf = (agent: Agent): string => {
    const cwd = agent.session.header.cwd ?? process.cwd()
    return `${cwd}/${config.planDir}/${String(agent.id)}`
  }

  /** 用户交互通道包装（部署无 userQuestions 时抛错）。 */
  const askFor =
    (agent: Agent) =>
    (
      questions: AskUserQuestionItem[],
      options?: { signal?: AbortSignal },
    ): Promise<AskUserQuestionAnswer> => {
      const service = ctx.get('userQuestions')
      if (service === undefined) throw new Error('no user-questions channel available')
      // signal 原样透传给宿主服务（编排器到点触发前的撤销句柄，宿主据此拒绝 ASK_ABORTED）；
      // 未提供时保持既有调用形状（宿主 ask 请求的 signal 字段可选）
      return service.ask(
        options?.signal === undefined
          ? { questions, agent }
          : { questions, agent, signal: options.signal },
      )
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
    // bySessionId 键（注册表槽、settings 桥接定位）与 effects 共用 String(agent.id)
    const sessionId = String(agent.id)
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
      // 排期到点由注册表触发 fireScheduledSession（编排器在场直接执行；
      // 冷会话 resume 补执行——见 fireScheduledSession 注释）
      scheduler: {
        arm: (at) => {
          scheduleRegistry.arm(sessionId, at, () => void fireScheduledSession(sessionId))
        },
        cancel: () => scheduleRegistry.cancel(sessionId),
      },
      hooks: {
        onActivate: mask.activate,
        onRestore: mask.restore,
      },
    })
    orchestrators.set(agent.session as object, orchestrator)
    bySessionId.set(sessionId, orchestrator)
    ctx.effect(
      () => () => {
        orchestrator.dispose()
        bySessionId.delete(sessionId)
      },
      'dsh-plan-and-execute: dispose orchestrators',
    )
    /**
     * 每步模型切换：agent/request waterfall 按当前步覆盖 LlmCallConfig。
     * 与宿主 installModelSelection 同一机制（后注册者最后覆盖）；无映射时透传。
     */
    const disposeStepModel = agent.ctx.on(
      'agent/request',
      async (_payload: unknown, next: () => Promise<LlmCallConfig>): Promise<LlmCallConfig> => {
        const resolved = await next()
        const stepIndex = orchestrator.snapshot().stepIndex ?? 0
        const selected = orchestrator.stepModelFor(stepIndex)
        if (selected === undefined) return resolved
        // 与宿主 installModelSelection 同一语义：先剥离 seed 继承的 reasoningEffort，
        // 避免不支持的 effort 组合泄漏到映射模型（prepareCall 抛 UNSUPPORTED_REASONING_EFFORT）。
        const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = resolved
        return {
          ...withoutInheritedEffort,
          provider: selected.provider,
          model: selected.model,
        }
      },
    )
    ctx.effect(() => () => disposeStepModel(), 'dsh-plan-and-execute: step model waterfall')
    /** todo 面板补写：宿主 todos 投影在 turn/start 清空，回合内经 agent/request 通道补发（细节见下）。 */
    /**
     * 宿主 todos 投影在 turn/start 清空（假定模型每回合重写清单），
     * 插件驱动的 todo 写在 steer 之前会被清掉 → 回合内面板消失。经 agent/request
     * 通道（已被模型切换 waterfall 验证可用）在新回合第一个请求时补发 todo/write。
     * （session/event 在 agent.ctx 收不到、宿主 ctx 也未触发——实测无效，弃用。）
     */
    let lastTurn = -1
    const disposeTodosRefresh = agent.ctx.on(
      'agent/request',
      async (
        payload: { turn?: unknown },
        next: () => Promise<LlmCallConfig>,
      ): Promise<LlmCallConfig> => {
        const turn = typeof payload?.turn === 'number' ? payload.turn : -1
        if (turn !== lastTurn) {
          lastTurn = turn
          orchestrator.refreshTodos()
        }
        return next()
      },
    )
    ctx.effect(() => () => disposeTodosRefresh(), 'dsh-plan-and-execute: todos refresh on new turn')
    return orchestrator
  }

  /**
   * 排期到点：编排器在场则直接触发执行；不在场（冷会话）经 ctx.get('agents')?.resume
   * 恢复会话 → agent/created → revive() 的 scheduled 分支自动补执行。
   * resume 依赖部署具备 agents/sessionPersistence 服务；失败仅记日志，
   * 等会话被打开时按 overdue 补执行（与宿主 schedule 同语义）。
   */
  const fireScheduledSession = (sessionId: string): void => {
    const orchestrator = bySessionId.get(sessionId)
    if (orchestrator !== undefined) {
      void orchestrator.fireScheduledRun()
      return
    }
    void (async () => {
      const agents = ctx.get('agents') as
        { resume(options: { resumeSessionId: string }): Promise<unknown> } | undefined
      if (agents === undefined) {
        ctx.logger.warn(
          `dsh-plan-and-execute: 排期到点但会话 ${sessionId} 未打开且无 agents 服务，等待打开时补执行`,
        )
        return
      }
      try {
        // resume() 返回的 AgentHandle 不 dispose 是有意为之：恢复出的 live agent
        // 由宿主/Web 收养、随应用生命周期存续（销毁会话属宿主职责，非本插件持有）
        await agents.resume({ resumeSessionId: sessionId })
      } catch (error) {
        ctx.logger.warn(
          `dsh-plan-and-execute: 排期到点恢复会话 ${sessionId} 失败（等待打开时补执行）：${String(error)}`,
        )
      }
    })()
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
        if (isPlanModeActive(agent.session.snapshotEvents())) {
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
            ctx.logger.warn(`dsh-plan-and-execute: 会话标题写入失败：${String(error)}`)
          }
        }
        await orchestrator.begin(task)
        return {
          kind: 'success',
          text: 'Plan-and-Execute 已启动：进入规划阶段，等待模型提交计划。',
        }
      },
    })
  })

  // —— 模型侧工具 ——
  ctx.tools.register(createSubmitPlanTool(lookup))
  ctx.tools.register(createReportStepTool(lookup))

  // —— settings 命名空间：模型下拉静默写（pae-step-models）+ 会话查看脉冲
  //（pae-ping）——两个注册各自独立 try/catch：任一失败（如部署已有同名命名空间）
  // 只降级对应功能，不互相牵连；两通道均不可用时桥接一并跳过（写通道不可用不影响
  // 插件其余功能）。载荷按 sessionId 分键定位编排器，无对应编排器的会话静默跳过（幂等容错）。
  // settings 为可选服务：cordis 严格属性访问下未 inject 的服务直读会抛
  // "cannot get property without inject"，须经 ctx.get 取用（与 userQuestions/agents 同款）。
  // 命名空间注册各自独立 try/catch：任一失败只降级对应功能；服务缺失则桥接整体跳过。
  const settingsService = ctx.get('settings') as
    | { register(ns: string, schema: unknown): unknown }
    | undefined
  let modelsNsRegistered = false
  let pingNsRegistered = false
  if (settingsService !== undefined) {
    try {
      settingsService.register(PAE_MODELS_NS, PAE_MODELS_SCHEMA)
      modelsNsRegistered = true
    } catch (error) {
      ctx.logger.warn(
        `dsh-plan-and-execute: settings 命名空间注册失败：${PAE_MODELS_NS}（审批卡模型下拉不可用）：${String(error)}`,
      )
    }
    try {
      settingsService.register(PAE_PING_NS, PAE_PING_SCHEMA)
      pingNsRegistered = true
    } catch (error) {
      ctx.logger.warn(
        `dsh-plan-and-execute: settings 命名空间注册失败：${PAE_PING_NS}（会话打开重弹不可用）：${String(error)}`,
      )
    }
  }
  if (modelsNsRegistered || pingNsRegistered) {
    ctx.on('settings/updated', (ns: string, next: unknown) => {
      if (ns === PAE_MODELS_NS) {
        // —— 模型分支：先 resolveCallConfig 校验可用性，全部失败视为瞬态跳过 ——
        // 返回 IIFE 的 Promise：宿主监听器容器会接住 rejection 记 warn；
        // 若 void 吞掉返回值，落盘失败会变成 unhandled rejection（Node≥15 终止进程）。
        return (async () => {
          for (const [sessionId, section] of Object.entries(
            (next ?? {}) as Record<string, unknown>,
          )) {
            const orchestrator = bySessionId.get(sessionId)
            if (orchestrator === undefined) continue
            const parsed = parsePaeModels(section)
            const llm = ctx.get('llm') as
              | { resolveCallConfig(c: { provider: string; model: string }): Promise<{ provider: string; model: string }> }
              | undefined
            const resolved: Record<number, { provider: string; model: string }> = {}
            for (const [stepKey, model] of Object.entries(parsed)) {
              try {
                // llm 服务缺失（可选）时不校验、原样应用（applyStepModels 只做结构校验）
                const ok =
                  llm === undefined
                    ? { provider: model.provider, model: model.model }
                    : await llm.resolveCallConfig({ provider: model.provider, model: model.model })
                resolved[Number(stepKey)] = { provider: ok.provider, model: ok.model }
              } catch (error) {
                ctx.logger.warn(
                  `dsh-plan-and-execute: 步骤 ${stepKey} 模型 ${model.provider}/${model.model} 不可用，跳过：${
                    error instanceof Error ? error.message : String(error)
                  }`,
                )
              }
            }
            // 解析出步骤但全部 resolve 失败：视为瞬态不可用，跳过本次应用
            //（applyStepModels 整体替换语义下空映射会清空既有选择）。
            const parsedEntries = Object.keys(parsed).length
            const resolvedEntries = Object.keys(resolved).length
            if (parsedEntries > 0 && resolvedEntries === 0) {
              ctx.logger.warn(
                'dsh-plan-and-execute: 该会话全部步骤模型不可用，跳过本次应用（保留既有选择）',
              )
              continue
            }
            const result = await orchestrator.applyStepModels(resolved)
            if (!result.ok) {
              ctx.logger.warn(`dsh-plan-and-execute: 应用步骤模型失败：${result.error}`)
            }
          }
        })()
      }
      if (ns === PAE_PING_NS) {
        // —— 会话查看脉冲分支：合法脉冲即对 scheduled 等待期会话重弹回显卡。
        // reviewScheduledAgain 内部 fire-and-forget（不 await、不阻塞本次监听）；
        // 其 rejection 在此接住记 warn，避免 unhandled rejection。 ——
        return (async () => {
          for (const [sessionId, section] of Object.entries(
            (next ?? {}) as Record<string, unknown>,
          )) {
            const orchestrator = bySessionId.get(sessionId)
            if (orchestrator === undefined) {
              continue
            }
            if (!parsePaePing(section)) continue
            // fire-and-forget：内部收尾（save/run）rejection 在此接住记 warn；
            // 'asked'/'ignored' 结果不消费（只表达「已发起」）
            void orchestrator
              .reviewScheduledAgain()
              .then(() => undefined)
              .catch((error) => {
                ctx.logger.warn(
                  `dsh-plan-and-execute: 会话打开重弹失败（session ${sessionId}）：${
                    error instanceof Error ? error.message : String(error)
                  }`,
                )
              })
          }
        })()
      }
      return undefined
    })
  }

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
