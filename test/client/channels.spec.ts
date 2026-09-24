import { describe, expect, it, vi } from 'vitest'
import { createChannelsWriter, type ChannelsSettingsRemote } from '../../src/client/channels.ts'

/** 序列化 schema 信封（Schemastery toJSON 形状）：某节点 dict 含给定字段。 */
function schemaWith(fields: readonly string[]): unknown {
  return {
    uid: 'root',
    refs: {
      root: {
        uid: 'root',
        dict: Object.fromEntries(fields.map((field) => [field, { uid: field }])),
      },
    },
  }
}

/** settings 远端假件：describe 固定返回给定条目，update 记调用。 */
function fakeRemote(
  namespaces: ReadonlyArray<{ ns: string; schema: unknown }>,
): ChannelsSettingsRemote & {
  update: ReturnType<typeof vi.fn>
  describe: ReturnType<typeof vi.fn>
} {
  return {
    describe: vi.fn(async () => ({ ok: true as const, value: { namespaces } })),
    update: vi.fn(async () => ({ ok: true })),
  } as ChannelsSettingsRemote & {
    update: ReturnType<typeof vi.fn>
    describe: ReturnType<typeof vi.fn>
  }
}

describe('createChannelsWriter', () => {
  it('按通道字段名在 describe 中定位插件条目，并写稀疏 patch', async () => {
    const remote = fakeRemote([
      { ns: 'llm-deepseek', schema: schemaWith(['apiKeyEnv']) },
      { ns: 'dsh-plan-and-execute-dev', schema: schemaWith(['planDir', 'paeStepModels']) },
    ])
    const writer = createChannelsWriter(remote)
    await writer.writeStepModels('sess-1', { 2: { provider: 'p', model: 'm' } })
    expect(remote.update).toHaveBeenCalledWith(
      'dsh-plan-and-execute-dev',
      { paeStepModels: { 'sess-1': { 2: { provider: 'p', model: 'm' } } } },
      undefined,
    )
  })

  it('脉冲写入形态：sessionId → {t}', async () => {
    const remote = fakeRemote([{ ns: 'pae', schema: schemaWith(['paeSessionPings']) }])
    const writer = createChannelsWriter(remote)
    await writer.writePing('sess-9', 1_750_000_000_000)
    expect(remote.update).toHaveBeenCalledWith(
      'pae',
      { paeSessionPings: { 'sess-9': { t: 1_750_000_000_000 } } },
      undefined,
    )
  })

  it('条目 id 只发现一次（后续写入复用缓存）', async () => {
    const remote = fakeRemote([{ ns: 'pae', schema: schemaWith(['paeStepModels']) }])
    const writer = createChannelsWriter(remote)
    await writer.writePing('s1', 1)
    await writer.writePing('s2', 2)
    expect(remote.describe).toHaveBeenCalledTimes(1)
    expect(remote.update).toHaveBeenCalledTimes(2)
  })

  it('describe 失败 / 找不到条目 → 写入 reject（且不缓存失败，下次重试）', async () => {
    const failing = fakeRemote([])
    failing.describe.mockResolvedValueOnce({ ok: false, error: 'no provider' })
    const writer = createChannelsWriter(failing)
    await expect(writer.writePing('s1', 1)).rejects.toThrow('settings 不可用')
    // 失败不缓存：下一次重新 describe（本次返回空条目 → 另一条错误）
    await expect(writer.writePing('s1', 2)).rejects.toThrow('找不到本插件的配置条目')
    expect(failing.describe).toHaveBeenCalledTimes(2)
  })

  it('schema 无通道字段 → 视为找不到条目（不误写他插件条目）', async () => {
    const remote = fakeRemote([{ ns: 'other', schema: schemaWith(['apiKeyEnv']) }])
    const writer = createChannelsWriter(remote)
    await expect(writer.writeStepModels('s1', {})).rejects.toThrow('找不到本插件的配置条目')
    expect(remote.update).not.toHaveBeenCalled()
  })
})
