// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  PaeReviewCard,
  PaeReviewCardView,
  type PaeReviewCardProps,
} from '../../src/client/PaeReviewCard.tsx'
import { PAE_MODELS_NS } from '../../src/state.ts'
import { zh } from '../../src/client/locale.ts'

// vitest 未开 globals：显式 cleanup 避免跨用例 DOM 累积（与 plan-card-render.spec.tsx 一致）。
afterEach(cleanup)

const base: PaeReviewCardProps = {
  sessionId: 'sess-1',
  pending: {
    kind: 'plan-review',
    key: 'k1',
    questions: [
      {
        id: 'pae-approve',
        question: '批准此计划？',
        options: [
          { label: '批准', description: 'a' },
          { label: '继续修改', description: 'b' },
        ],
      },
    ],
    answer: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
  },
  args: {
    planDir: '.pae/sess-1',
    summary: '测试计划',
    steps: [
      { file: 'a.md', title: '步骤 A' },
      { file: 'b.md', title: '步骤 B', requiresConfirmation: true },
    ],
  },
  canOpen: true,
  options: [
    {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      label: 'deepseek-official · deepseek-v4-flash',
    },
    {
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      label: 'deepseek-official · deepseek-v4-pro',
    },
  ],
  current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  openPath: vi.fn(),
  settings: { update: vi.fn(async () => undefined) },
  t: (key: string) => key,
}

describe('PaeReviewCard', () => {
  it('渲染步骤行（标题/文件/⚠）与模型下拉，默认 = 当前会话模型', () => {
    render(<PaeReviewCard {...base} />)
    // 行内标题为可点击按钮（打开步骤文件），文件名不再展示
    expect(screen.getByRole('button', { name: 'openStep 2. 步骤 B' })).toBeTruthy()
    expect(screen.queryByText('b.md')).toBeNull()
    const selects = screen.getAllByRole('combobox')
    expect(selects).toHaveLength(2)
    expect((selects[1] as HTMLSelectElement).value).toBe('deepseek-official|deepseek-v4-flash')
  })

  it('下拉 onChange → 静默 settings.update（完整映射，无按钮）', async () => {
    render(<PaeReviewCard {...base} />)
    fireEvent.change(screen.getAllByRole('combobox')[0]!, {
      target: { value: 'deepseek-official|deepseek-v4-pro' },
    })
    await waitFor(() => {
      expect(base.settings.update).toHaveBeenCalledWith(
        PAE_MODELS_NS,
        { 'sess-1': { 1: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } } },
        undefined,
      )
    })
  })

  it("点「批准」→ pending.answer({answers:[{id, selected:['批准']}]})", async () => {
    render(<PaeReviewCard {...base} />)
    fireEvent.click(screen.getByRole('button', { name: 'approve' }))
    await waitFor(() => {
      expect(base.pending.answer).toHaveBeenCalledWith({
        answers: [{ id: 'pae-approve', selected: ['批准'] }],
      })
    })
  })

  it('反馈框填写后点「继续修改」→ answer 携带 custom', async () => {
    render(<PaeReviewCard {...base} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '步骤 2 拆开' } })
    fireEvent.click(screen.getByRole('button', { name: 'keep' }))
    await waitFor(() => {
      expect(base.pending.answer).toHaveBeenCalledWith({
        answers: [{ id: 'pae-approve', selected: ['继续修改'], custom: '步骤 2 拆开' }],
      })
    })
  })

  it('点「讨论」→ pending.cancel()', async () => {
    render(<PaeReviewCard {...base} />)
    // t 为恒等函数，按钮文本即键名 'discuss'
    fireEvent.click(screen.getByRole('button', { name: 'discuss' }))
    await waitFor(() => expect(base.pending.cancel).toHaveBeenCalled())
  })

  it('canOpen 时「打开计划目录」→ openPath(planDir)；点击步骤标题 → openPath(planDir/file)', () => {
    render(<PaeReviewCard {...base} />)
    fireEvent.click(screen.getByRole('button', { name: 'openDir' }))
    expect(base.openPath).toHaveBeenCalledWith('.pae/sess-1')
    fireEvent.click(screen.getByRole('button', { name: 'openStep 2. 步骤 B' }))
    expect(base.openPath).toHaveBeenCalledWith('.pae/sess-1/b.md')
  })

  it('settings.update 拒绝 → 行内错误显示，不崩溃', async () => {
    const failing = {
      update: vi.fn(async () => {
        throw new Error('denied')
      }),
    }
    render(<PaeReviewCard {...base} settings={failing} />)
    fireEvent.change(screen.getAllByRole('combobox')[0]!, {
      target: { value: 'deepseek-official|deepseek-v4-pro' },
    })
    await waitFor(() => expect(screen.getByText(/应用失败|denied/)).toBeTruthy())
  })
})

describe('执行时间控件', () => {
  // base.t 是恒等函数（既有用例按键名断言）；本组用例断言真实中文文案（简报样本逐字），
  // 因此注入混合 t：date/time 输入按键名 scheduleDate/scheduleTime 作稳定标签定位
  // （getByLabelText 键名查询，同组件 model-N aria-label 约定），其余键取 locale zh 文案。
  const zhT = (key: string): string =>
    key === 'scheduleDate' || key === 'scheduleTime'
      ? key
      : ((zh as Record<string, string>)[key] ?? key)
  // 回显走顶层 scheduledAt prop（简报组件契约：View 把 args.scheduledAt 透传为 prop；
  // parsePlanDetail 的 CardArgs.scheduledAt 属协议层，不经 args 直接驱动卡片状态）。
  const scheduledArgs = (at?: number) => ({
    ...base,
    t: zhT,
    ...(at === undefined ? {} : { scheduledAt: at }),
  })
  // 本组断言一律用 data-testid 定位浮层内元素（schedule-picker/schedule-status/
  // schedule-commit/schedule-now），避免与卡底 .pae-error 的 role=status 混淆。
  const statusText = () => screen.getByTestId('schedule-status').textContent ?? ''
  const commitBtn = () => screen.getByTestId('schedule-commit') as HTMLButtonElement
  /** 渲染无排期卡片并点 chip 展开浮层；返回独立的 settings.update spy。 */
  const openPicker = (update = vi.fn(async () => undefined)) => {
    render(<PaeReviewCard {...scheduledArgs()} settings={{ update }} />)
    fireEvent.click(screen.getByRole('button', { name: /立即执行/ }))
    return update
  }
  /** 按本地时区部分串填写 date/time 两个原生 input。 */
  const fillParts = (at: Date): void => {
    const pad = (v: number) => String(v).padStart(2, '0')
    fireEvent.change(screen.getByLabelText('scheduleDate') as HTMLInputElement, {
      target: {
        value: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`,
      },
    })
    fireEvent.change(screen.getByLabelText('scheduleTime') as HTMLInputElement, {
      target: { value: `${pad(at.getHours())}:${pad(at.getMinutes())}` },
    })
  }
  /** 排期预览文案（chip 与浮层状态行共用格式）。 */
  const previewOf = (at: Date): string => {
    const pad = (v: number) => String(v).padStart(2, '0')
    return `计划于 ${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())} 执行`
  }

  it('默认（无排期）显示「立即执行」chip；打开浮层选完整时间 → 浮层内即时预览且零 settings 写；点「确定」→ 本地 when 生效、chip 转计划态', async () => {
    const update = openPicker()
    const when = new Date(Date.now() + 86_400_000) // 明天同时刻
    fillParts(when)
    // 草稿只驱动浮层状态行（schedulePreview 绿色预览），不触发自动提交
    await waitFor(() => expect(statusText()).toContain(previewOf(when)))
    expect(update).not.toHaveBeenCalled()
    // 显式「确定」→ 仅本地提交（无 settings 写），浮层关闭，chip 显示「计划于 … 执行」
    fireEvent.click(commitBtn())
    await waitFor(() => expect(screen.queryByTestId('schedule-picker')).toBeNull())
    expect(screen.getByRole('button', { name: previewOf(when) })).toBeTruthy()
    expect(update).not.toHaveBeenCalled()
  })

  it('确定设置时间后点「批准」→ answer 携带 at 编码（排期意图随批准载荷传达）', async () => {
    const update = openPicker()
    const when = new Date(Date.now() + 86_400_000)
    fillParts(when)
    fireEvent.click(commitBtn())
    await waitFor(() => expect(screen.queryByTestId('schedule-picker')).toBeNull())
    // 期望 epoch 由输入的各部分推导（输入不含秒/毫秒，不能直接用 when.getTime()）
    const expected = new Date(
      when.getFullYear(),
      when.getMonth(),
      when.getDate(),
      when.getHours(),
      when.getMinutes(),
    ).getTime()
    fireEvent.click(screen.getByRole('button', { name: '批准' }))
    await waitFor(() => {
      expect(base.pending.answer).toHaveBeenLastCalledWith({
        answers: [{ id: 'pae-approve', selected: ['批准'], custom: `paeSchedule:at:${expected}` }],
      })
    })
    expect(update).not.toHaveBeenCalled() // 排期全程无 settings 写
  })

  it('回显卡：scheduledAt 存在 → 默认显示计划时间 chip（不显示立即执行）', () => {
    const at = new Date(2026, 8, 6, 10, 0).getTime()
    render(<PaeReviewCard {...scheduledArgs(at)} />)
    expect(screen.getByText(/计划于 2026-09-06 10:00 执行/)).toBeTruthy()
  })

  it('回显卡点「清除排期」× → 仅本地清 when=null（无 settings 写）；点「批准」→ answer 携带 now 编码', async () => {
    const update = vi.fn(async () => undefined)
    const at = Date.now() + 86_400_000
    render(<PaeReviewCard {...scheduledArgs(at)} settings={{ update }} />)
    // 排期态 chip 旁的 ×（aria-label=清除排期）与浮层内「立即执行」按钮同属 clearSchedule，
    // 但可访问名不同（× 用 scheduleClear，避免与浮层按钮重名）
    fireEvent.click(screen.getByRole('button', { name: /清除排期/ }))
    expect(update).not.toHaveBeenCalled()
    // chip 回「立即执行」态（面板未展开，唯一匹配）
    expect(screen.getByRole('button', { name: /立即执行/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '批准' }))
    await waitFor(() => {
      expect(base.pending.answer).toHaveBeenLastCalledWith({
        answers: [{ id: 'pae-approve', selected: ['批准'], custom: 'paeSchedule:now' }],
      })
    })
  })

  it('已过去的时间（完整输入但 < now）→ 浮层内错误文案、「确定」禁用、不写 settings 也不进卡底错误', async () => {
    const update = openPicker()
    fillParts(new Date(Date.now() - 60_000))
    await waitFor(() => expect(statusText()).toMatch(/晚于当前/))
    expect(commitBtn().disabled).toBe(true)
    expect(update).not.toHaveBeenCalled()
    // 校验反馈只在浮层状态行（role=status 播报 past 文案）；卡底 .pae-error 保持空串（无双写）。
    // DOM 顺序：header 内浮层状态行在前，卡底 .pae-error 在后。
    expect(screen.getAllByRole('status').map((el) => el.textContent)).toEqual([
      '执行时间需晚于当前时刻',
      '',
    ])
  })

  it('过去时间输入后浮层状态行以 role=status 可被辅助技术感知（aria-live 播报入口）', async () => {
    openPicker()
    fillParts(new Date(Date.now() - 60_000))
    // within(picker) 定位，避免与卡底 .pae-error 的 role=status 混淆
    await waitFor(() =>
      expect(within(screen.getByTestId('schedule-picker')).getByRole('status').textContent).toMatch(
        /晚于当前/,
      ),
    )
  })

  it('浮层点「立即执行」→ 仅本地清为立即（无 settings 写）并关闭浮层', async () => {
    const update = openPicker()
    fireEvent.click(screen.getByTestId('schedule-now'))
    expect(update).not.toHaveBeenCalled()
    expect(screen.queryByTestId('schedule-picker')).toBeNull()
  })

  it('草稿不完整（只填日期）→ 浮层显示 scheduleHint 文案且「确定」禁用、不写 settings', async () => {
    const update = openPicker()
    const future = new Date(Date.now() + 86_400_000)
    fireEvent.change(screen.getByLabelText('scheduleDate') as HTMLInputElement, {
      target: {
        value: `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, '0')}-${String(future.getDate()).padStart(2, '0')}`,
      },
    })
    await waitFor(() => expect(statusText()).toContain('选择完整日期与时间后生效'))
    expect(commitBtn().disabled).toBe(true)
    expect(update).not.toHaveBeenCalled()
  })

  it('浮层内先输入过去时间、再改未来 → 错误转预览、「确定」从禁用变可用', async () => {
    const update = openPicker()
    fillParts(new Date(Date.now() - 60_000))
    await waitFor(() => expect(statusText()).toMatch(/晚于当前/))
    expect(commitBtn().disabled).toBe(true)
    const future = new Date(Date.now() + 86_400_000)
    fireEvent.change(screen.getByLabelText('scheduleDate') as HTMLInputElement, {
      target: {
        value: `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, '0')}-${String(future.getDate()).padStart(2, '0')}`,
      },
    })
    // 时间部分沿用刚才的过去输入；日期改到明天后整体必然晚于当前 → 预览（时间分钟不逐字断言，
    // 避免用例执行跨分钟边界导致期望值与草稿保留值差 1 分钟的偶发）
    await waitFor(() => expect(statusText()).toMatch(/计划于 \d{4}-\d{2}-\d{2} \d{2}:\d{2} 执行/))
    expect(commitBtn().disabled).toBe(false)
    expect(update).not.toHaveBeenCalled()
  })

  it('打开浮层不操作再点 chip 关闭 → 草稿丢弃、无任何 settings.update 调用', () => {
    const update = openPicker()
    // 浮层展开后「立即执行」文案出现两处（chip 与浮层内按钮）；chip 在 DOM 中居前
    fireEvent.click(screen.getAllByRole('button', { name: /立即执行/ })[0]!)
    expect(screen.queryByTestId('schedule-picker')).toBeNull()
    expect(update).not.toHaveBeenCalled()
  })
})

describe('PaeReviewCardView', () => {
  // 视图不依赖任何 chat/投影钩子（composer 座位崩溃修复后）：步骤来自审批问题 detail。
  const viewPending = {
    kind: 'plan-review',
    key: 'k1',
    sessionId: 'sess-pending',
    questions: [
      {
        id: 'pae-approve',
        question: '批准此计划？',
        detail: '计划目录：.pae/sess-1\n1. 计算 1+1 — a.md\n2. 计算 2+2 — b.md ⚠ 确认点',
        options: [
          { label: '批准', description: 'a' },
          { label: '继续修改', description: 'b' },
        ],
      },
    ],
    answer: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
  }
  // 显式返回类型标注：宿主 RemoteResult 是 ok: true 判别联合，vi.fn 推断的
  // {ok: boolean} 无法赋值（strict 判别）。
  const viewInject = {
    sessionRemote: {
      modelCatalog: vi.fn(
        async (): Promise<{
          ok: true
          value: {
            default: { provider: string; model: string }
            routableProviders: string[]
            groups: { id: string; name: string; models: { id: string; name: string }[] }[]
            failures: never[]
          }
        }> => ({
          ok: true,
          value: {
            default: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
            routableProviders: ['deepseek-official'],
            groups: [
              {
                id: 'deepseek-official',
                name: 'DeepSeek',
                models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }],
              },
            ],
            failures: [],
          },
        }),
      ),
      canOpenWorkspacePath: vi.fn(async (): Promise<{ ok: true; value: boolean }> => ({
        ok: true,
        value: true,
      })),
      openWorkspacePath: vi.fn(
        async (): Promise<{ ok: true; value: { opened: true; path: string } }> => ({
          ok: true,
          value: { opened: true, path: '' },
        }),
      ),
    },
    settingsRemote: {
      // 宿主 update 返回 RemoteResult<SettingsNamespaceView>（ok: true 判别联合，视图不消费结果值；
      // SettingsNamespaceView 必填字段多（ns/schema/value/applies/secrets/revision），mock 用
      // as never 占位，避免为未使用的形状追完整类型）。
      update: vi.fn(async (): Promise<{ ok: true; value: never }> => ({
        ok: true,
        value: {} as never,
      })),
    },
    connection: { isLoopback: true },
  }

  it('无 chat/投影钩子也能渲染：步骤来自 detail，决策按钮可用', async () => {
    render(
      <PaeReviewCardView
        sessionId="sess-1"
        pendingInteraction={viewPending}
        t={(key: string) => key}
        {...viewInject}
      />,
    )
    await waitFor(() => expect(screen.getByRole('button', { name: 'approve' })).toBeTruthy())
    expect(screen.getByRole('button', { name: 'openStep 2. 计算 2+2' })).toBeTruthy()
  })

  it('sessionId undefined 时回退 pending.sessionId（settings 写键正确，不空白）', async () => {
    render(
      <PaeReviewCardView
        sessionId={undefined}
        pendingInteraction={viewPending}
        t={(key: string) => key}
        {...viewInject}
      />,
    )
    await waitFor(() => {
      fireEvent.change(screen.getAllByRole('combobox')[0]!, {
        target: { value: 'deepseek-official|deepseek-v4-flash' },
      })
      expect(viewInject.settingsRemote.update).toHaveBeenCalledWith(
        PAE_MODELS_NS,
        { 'sess-pending': { 1: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } } },
        undefined,
      )
    })
  })

  it('detail 缺失 → 仅决策按钮（不空白、不崩溃）', async () => {
    const noDetail = {
      ...viewPending,
      questions: [{ ...viewPending.questions[0]!, detail: undefined }],
    }
    render(
      <PaeReviewCardView
        sessionId="sess-1"
        pendingInteraction={noDetail}
        t={(key: string) => key}
        {...viewInject}
      />,
    )
    await waitFor(() => expect(screen.getByRole('button', { name: 'approve' })).toBeTruthy())
    expect(screen.queryByRole('button', { name: /openStep/ })).toBeNull()
  })
})
