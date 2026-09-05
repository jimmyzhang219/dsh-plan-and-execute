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
  // 因此注入混合 t：时/分 select 按键名 scheduleHour/scheduleMinute 作稳定标签定位
  // （getByLabelText 键名查询，同组件 model-N aria-label 约定），其余键取 locale zh 文案。
  const zhT = (key: string): string =>
    key === 'scheduleHour' || key === 'scheduleMinute'
      ? key
      : ((zh as Record<string, string>)[key] ?? key)
  // 回显走顶层 scheduledAt prop（简报组件契约：View 把 args.scheduledAt 透传为 prop；
  // parsePlanDetail 的 CardArgs.scheduledAt 属协议层，不经 args 直接驱动卡片状态）。
  const scheduledArgs = (at?: number) => ({
    ...base,
    t: zhT,
    ...(at === undefined ? {} : { scheduledAt: at }),
  })
  // 本组断言用 data-testid 定位浮层内元素（schedule-picker/schedule-status/
  // schedule-commit/schedule-mode-*/schedule-calendar）。
  const pad = (v: number) => String(v).padStart(2, '0')
  const pickerEl = () => screen.getByTestId('schedule-picker')
  const statusText = () => screen.getByTestId('schedule-status').textContent ?? ''
  const commitBtn = () => screen.getByTestId('schedule-commit') as HTMLButtonElement
  /** 排期预览/回显文案（chip 与浮层状态行共用模板）。 */
  const previewOf = (at: number): string => {
    const d = new Date(at)
    return `计划于 ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} 执行`
  }
  /** 本地日期 YYYY-MM-DD（日历 td[data-day] 查询用）。 */
  const isoDay = (d: Date): string =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  /** 渲染卡片（可选回显 scheduledAt）并点 chip 展开浮层；返回独立 settings.update spy。 */
  const openPanel = (at?: number, update = vi.fn(async () => undefined)) => {
    render(<PaeReviewCard {...scheduledArgs(at)} settings={{ update }} />)
    const chipName = at === undefined ? /^立即执行$/ : new RegExp(`^计划于 .+ 执行$`)
    fireEvent.click(screen.getByRole('button', { name: chipName }))
    return update
  }
  /** 切换两态分段。 */
  const switchMode = (mode: 'now' | 'at'): void => {
    fireEvent.click(screen.getByTestId(mode === 'now' ? 'schedule-mode-now' : 'schedule-mode-at'))
  }
  /** 点击日历中指定本地日的单元格按钮（td[data-day] 定位；该日须在当前展示月内）。 */
  const clickDay = (d: Date): void => {
    const cell = pickerEl().querySelector(`td[data-day="${isoDay(d)}"]`) as HTMLElement | null
    expect(cell, `日历应含 ${isoDay(d)} 单元格`).not.toBeNull()
    fireEvent.click(cell!.querySelector('button') as HTMLButtonElement)
  }
  /** 当前展示月 caption（zh 格式：2026年9月）。 */
  const captionOf = (): string =>
    pickerEl().querySelector('.pae-rdp-caption_label')?.textContent ?? ''
  /** 翻页到目标年月所在展示月（解析 zh caption；至多 3 步防死循环）。 */
  const goToMonth = (year: number, month: number): void => {
    for (let step = 0; step < 3; step++) {
      const match = /^(\d{4})年(\d{1,2})月$/.exec(captionOf())
      if (match !== null && Number(match[1]) === year && Number(match[2]) === month) return
      fireEvent.click(screen.getByRole('button', { name: '上一月' }))
    }
  }

  it('默认 chip 显示「立即执行」；点开面板两态分段在（立即执行/指定时间），零 settings 写', () => {
    const update = openPanel()
    // 「立即执行」两处：chip（DOM 居前）+ 两态分段按钮
    expect(screen.getAllByRole('button', { name: /^立即执行$/ })).toHaveLength(2)
    const panel = pickerEl()
    expect(within(panel).getByTestId('schedule-mode-now').textContent).toBe('立即执行')
    expect(within(panel).getByTestId('schedule-mode-at').textContent).toBe('指定时间')
    expect(within(panel).getByTestId('schedule-mode-now').getAttribute('aria-pressed')).toBe('true')
    expect(update).not.toHaveBeenCalled()
  })

  it('切「指定时间」→ 日历（中文 caption）+ 时/分 select；默认草稿=now+1h 即合法可确定', async () => {
    const update = openPanel()
    switchMode('at')
    const panel = pickerEl()
    expect(within(panel).getByTestId('schedule-calendar')).toBeTruthy()
    expect(panel.querySelector('.pae-rdp-table')).toBeTruthy() // 日历表格已渲染
    expect(captionOf()).toMatch(/^\d{4}年\d{1,2}月$/) // 中文 caption（不经 locale/date-fns）
    const hour = within(panel).getByLabelText('scheduleHour') as HTMLSelectElement
    const minute = within(panel).getByLabelText('scheduleMinute') as HTMLSelectElement
    expect(hour.options).toHaveLength(24)
    expect(minute.options).toHaveLength(60)
    // 默认草稿 = now+1h：完整且晚于当前 → 状态行绿色预览、「确定」可用
    await waitFor(() => expect(statusText()).toMatch(/计划于 \d{4}-\d{2}-\d{2} \d{2}:\d{2} 执行/))
    expect(commitBtn().disabled).toBe(false)
    expect(update).not.toHaveBeenCalled()
  })

  it('改时/分后点「确定」→ 本地 when 生效、chip 变「计划于 …」；点「批准」→ answer 携带 at 编码', async () => {
    const update = openPanel()
    switchMode('at')
    fireEvent.change(screen.getByLabelText('scheduleHour'), { target: { value: '15' } })
    fireEvent.change(screen.getByLabelText('scheduleMinute'), { target: { value: '30' } })
    await waitFor(() => expect(commitBtn().disabled).toBe(false))
    fireEvent.click(commitBtn())
    await waitFor(() => expect(screen.queryByTestId('schedule-picker')).toBeNull())
    // 草稿日 = now+1h 的日期部分；时/分取 select 值（分钟逐字断言）
    expect(
      screen.getByRole('button', { name: /^计划于 \d{4}-\d{2}-\d{2} 15:30 执行$/ }),
    ).toBeTruthy()
    expect(update).not.toHaveBeenCalled() // 排期选择全过程零后端调用
    fireEvent.click(screen.getByRole('button', { name: '批准' }))
    await waitFor(() => {
      const answerMock = base.pending.answer as ReturnType<typeof vi.fn>
      const calls = answerMock.mock.calls
      const payload = calls.at(-1)![0] as { answers: Array<{ custom?: string }> }
      const custom = payload.answers[0]!.custom
      expect(custom).toMatch(/^paeSchedule:at:\d+$/)
      const at = Number(custom!.slice('paeSchedule:at:'.length))
      expect(at).toBeGreaterThan(Date.now()) // 数字落在合理未来区间（草稿 now+1h 附近）
      expect(at).toBeLessThan(Date.now() + 2 * 86_400_000)
    })
    expect(update).not.toHaveBeenCalled()
  })

  it('回显卡：chip 显示原排期；点开面板 at 态预填（状态行预览原时刻、日历选中、时/分对齐）', () => {
    const when = new Date(Date.now() + 7 * 86_400_000) // 未来 7 天（跨月安全）
    const at = when.getTime()
    const update = vi.fn(async () => undefined)
    render(<PaeReviewCard {...scheduledArgs(at)} settings={{ update }} />)
    expect(screen.getByRole('button', { name: previewOf(at) })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: previewOf(at) })) // 点 chip 展开
    const panel = pickerEl()
    // 有排期 → 展开默认进入「指定时间」且预填原时刻
    expect(within(panel).getByTestId('schedule-mode-at').getAttribute('aria-pressed')).toBe('true')
    expect(statusText()).toBe(previewOf(at)) // 原时刻未过期 → 预览即合法
    // select 的 option value 为数字（文本补零展示），按数值比较
    expect(Number((within(panel).getByLabelText('scheduleHour') as HTMLSelectElement).value)).toBe(
      when.getHours(),
    )
    expect(
      Number((within(panel).getByLabelText('scheduleMinute') as HTMLSelectElement).value),
    ).toBe(when.getMinutes())
    const selected = panel.querySelector('.pae-rdp-day_selected')
    expect(selected?.getAttribute('data-day')).toBe(isoDay(when))
    expect(commitBtn().disabled).toBe(false)
    expect(update).not.toHaveBeenCalled()
  })

  it('回显卡切「立即执行」→ 确定收口 = 本地清排期；点「批准」→ answer 携带 now 编码', async () => {
    const at = Date.now() + 7 * 86_400_000
    const update = openPanel(at)
    switchMode('now')
    // 立即态状态行即时提示；确定收口（= 清排期）关闭面板
    expect(statusText()).toBe('批准后将立即开始执行')
    fireEvent.click(commitBtn())
    await waitFor(() => expect(screen.queryByTestId('schedule-picker')).toBeNull())
    expect(screen.getByRole('button', { name: /^立即执行$/ })).toBeTruthy()
    expect(update).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '批准' }))
    await waitFor(() => {
      expect(base.pending.answer).toHaveBeenLastCalledWith({
        answers: [{ id: 'pae-approve', selected: ['批准'], custom: 'paeSchedule:now' }],
      })
    })
    expect(update).not.toHaveBeenCalled()
  })

  it('回显卡 chip 旁 × → 仅本地清 when=null（无 settings 写），chip 回立即执行', () => {
    const at = Date.now() + 7 * 86_400_000
    const update = vi.fn(async () => undefined)
    render(<PaeReviewCard {...scheduledArgs(at)} settings={{ update }} />)
    // × 的可访问名为 scheduleClear（与两态分段按钮区分）
    fireEvent.click(screen.getByRole('button', { name: /清除排期/ }))
    expect(screen.getByRole('button', { name: /^立即执行$/ })).toBeTruthy()
    expect(update).not.toHaveBeenCalled()
  })

  it('过去时刻（今天 00:00）→ 状态行 schedulePast 红字（role=status）+ 确定禁用；改未来后恢复可用', async () => {
    const update = openPanel()
    switchMode('at')
    const now = new Date()
    // 先把草稿时/分锁定 00:00。默认草稿=now+1h 可能正是今天（点今天会反选成未选），
    // 因此先经「下一月 15 日」把选中移开，再回到今天所在月点选今天 → 组合出「过去时刻」
    fireEvent.change(screen.getByLabelText('scheduleHour'), { target: { value: '0' } })
    fireEvent.change(screen.getByLabelText('scheduleMinute'), { target: { value: '0' } })
    goToMonth(now.getFullYear(), now.getMonth() + 1) // 回到今天所在月（默认草稿至多晚一天）
    fireEvent.click(screen.getByRole('button', { name: '下一月' }))
    clickDay(new Date(now.getFullYear(), now.getMonth() + 1, 15, 0, 0))
    fireEvent.click(screen.getByRole('button', { name: '上一月' }))
    clickDay(now)
    await waitFor(() => expect(statusText()).toBe('执行时间需晚于当前时刻'))
    expect(commitBtn().disabled).toBe(true)
    // 浮层状态行 role=status 可被辅助技术感知（日历 caption 覆盖已剥离重复 role）
    expect(within(pickerEl()).getByRole('status').textContent).toBe('执行时间需晚于当前时刻')
    expect(update).not.toHaveBeenCalled()
    // 改下月 15 日 12:00（必为未来）→ 错误转预览、「确定」从禁用变可用
    fireEvent.click(screen.getByRole('button', { name: '下一月' }))
    const future = new Date(now.getFullYear(), now.getMonth() + 1, 15, 12, 0)
    clickDay(future)
    fireEvent.change(screen.getByLabelText('scheduleHour'), { target: { value: '12' } })
    await waitFor(() => expect(statusText()).toBe(previewOf(future.getTime())))
    expect(commitBtn().disabled).toBe(false)
    expect(update).not.toHaveBeenCalled()
  })

  it('打开浮层不操作再点 chip 关闭 → 草稿丢弃、无任何 settings.update 调用', () => {
    const update = openPanel()
    // 浮层展开后「立即执行」出现两处（chip 与两态分段）；chip 在 DOM 中居前
    fireEvent.click(screen.getAllByRole('button', { name: /^立即执行$/ })[0]!)
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
