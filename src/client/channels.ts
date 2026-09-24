/**
 * 客户端静默通道：按 volatile 字段名定位本插件的 profile 条目并写入通道字段。
 *
 * 宿主 settings 只提供「写 active profile 条目的 volatile Config 字段」这一条静默写路径
 * （ctx.remote.settings.update），而条目 id 由装配决定（dev overlay 与 dsh plugin add
 * 各用一个 id），故按字段名在 describe() 的序列化 schema 中定位条目，发现结果缓存复用。
 * 载荷是稀疏合并（宿主 mergeLayers 递归合并普通对象），不影响其他会话/字段。
 * @module dsh-plan-and-execute/client/channels
 */
import { PAE_PINGS_FIELD, PAE_STEP_MODELS_FIELD, type PaeStepModel } from '../state.ts'

/**
 * JSON 值（settings 通道载荷类型）。宿主侧定义于 dsh-util-values，
 * 该包运行时由 dsh 进程提供、不随本插件安装，故在此本地复刻，语义与宿主一致。
 */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** 宿主 settings 远端面（本模块用到的两个方法；失败以 RemoteResult 的 {ok:false} 返回）。 */
export interface ChannelsSettingsRemote {
  /** 读全部可配置条目的表单描述（含序列化 schema 与条目 id）。 */
  describe(): Promise<
    | {
        readonly ok: true
        readonly value: {
          readonly namespaces: readonly { readonly ns: string; readonly schema: unknown }[]
        }
      }
    | { readonly ok: false; readonly error: unknown }
  >
  /** 稀疏合并写入某条目的 volatile 字段。 */
  update(
    ns: string,
    patch: Record<string, JsonValue>,
    expectedRevision: number | undefined,
  ): Promise<unknown>
}

/** 静默通道写入面（宿主 half 读这两个字段派发到编排器）。 */
export interface ChannelsWriter {
  /**
   * 写每步模型选择（按 sessionId 稀疏合并，其余会话/步骤保留）。
   * @param sessionId - 会话标识（与宿主 agent.id 同源）。
   * @param models - 步骤号（1-based）→ 模型。
   * @returns 宿主远端应答（调用方按需静默或提示）。
   */
  writeStepModels(sessionId: string, models: Record<number, PaeStepModel>): Promise<unknown>
  /**
   * 写一次会话查看脉冲（scheduled 等待期重弹回显卡的信号）。
   * @param sessionId - 会话标识。
   * @param at - 脉冲时刻（epoch ms）。
   * @returns 宿主远端应答（调用方按需静默或提示）。
   */
  writePing(sessionId: string, at: number): Promise<unknown>
}

/** 序列化 schema 信封（Schemastery toJSON：uid + refs 表）中是否声明了某字段。 */
function declaresField(schema: unknown, field: string): boolean {
  const refs = (schema as { refs?: unknown } | null | undefined)?.refs
  if (typeof refs !== 'object' || refs === null) return false
  for (const node of Object.values(refs as Record<string, unknown>)) {
    const dict = (node as { dict?: unknown } | null)?.dict
    if (typeof dict === 'object' && dict !== null && Object.hasOwn(dict, field)) return true
  }
  return false
}

/**
 * 建通道写入器。
 * @param remote - ctx.remote.settings（宿主 settings 远端面）。
 * @returns 写入器；describe 未找到本插件条目 / 连接失败时各写入以 rejection 呈现，
 *   由调用方决定静默（脉冲）或卡片内提示（模型选择）。
 */
export function createChannelsWriter(remote: ChannelsSettingsRemote): ChannelsWriter {
  /** 惰性发现的本插件 profile 条目 id（一次成功即缓存；失败不缓存，下次重试）。 */
  let discovered: Promise<string> | undefined
  const entryId = (): Promise<string> =>
    (discovered ??= (async () => {
      const described = await remote.describe()
      if (!described.ok) throw new Error('settings 不可用（describe 失败）')
      const found = described.value.namespaces.find(
        (view) =>
          declaresField(view.schema, PAE_STEP_MODELS_FIELD) ||
          declaresField(view.schema, PAE_PINGS_FIELD),
      )
      if (found === undefined)
        throw new Error('settings 中找不到本插件的配置条目（静默通道不可用）')
      return found.ns
    })().catch((error: unknown) => {
      // 发现失败不缓存：装配/连接恢复后下一次写入可重试
      discovered = undefined
      throw error
    }))
  const write = async (
    field: string,
    sessionId: string,
    payload: Record<string, JsonValue>,
  ): Promise<unknown> => {
    const ns = await entryId()
    return remote.update(ns, { [field]: { [sessionId]: payload } }, undefined)
  }
  return {
    writeStepModels: (sessionId, models) =>
      write(
        PAE_STEP_MODELS_FIELD,
        sessionId,
        Object.fromEntries(
          Object.entries(models).map(([step, model]) => [
            step,
            { provider: model.provider, model: model.model },
          ]),
        ),
      ),
    writePing: (sessionId, at) => write(PAE_PINGS_FIELD, sessionId, { t: at }),
  }
}
