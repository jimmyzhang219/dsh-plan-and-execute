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
  // schedule-commit/schedule-now/schedule-calendar）。
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
    fireEvent.click(
      screen.getByRole('button', { name: at === undefined ? /^立即执行$/ : previewOf(at) }),
    )
    return update
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

  it('打开（无排期）：单页时间设置——无两态分段，日历 + 时/分直接同现；日期未选中 → 确定禁用；零 settings 写', () => {
    const update = openPanel()
    const panel = pickerEl()
    // 分段已删：浮层内无 role=group 组、无 schedule-mode-* 分段按钮
    expect(within(panel).queryByRole('group')).toBeNull()
    expect(within(panel).queryByTestId('schedule-mode-now')).toBeNull()
    expect(within(panel).queryByTestId('schedule-mode-at')).toBeNull()
    // 单页：日历与时/分 select 开面板即同现（无需先切「指定时间」态）
    expect(within(panel).getByTestId('schedule-calendar')).toBeTruthy()
    expect(panel.querySelector('.pae-rdp-table')).toBeTruthy()
    expect(captionOf()).toMatch(/^\d{4}年\d{1,2}月$/) // 中文 caption（当前展示月）
    const hour = within(panel).getByLabelText('scheduleHour') as HTMLSelectElement
    const minute = within(panel).getByLabelText('scheduleMinute') as HTMLSelectElement
    expect(hour.options).toHaveLength(24)
    expect(minute.options).toHaveLength(60)
    // 无排期：日期初始不选中 → 无完整时刻 → 弱提示 + 确定禁用（防随手确定误排期）
    expect(statusText()).toBe(zh.scheduleHint)
    expect(commitBtn().disabled).toBe(true)
    expect(update).not.toHaveBeenCalled()
  })

  it('点选日历日 → 绿预览 + 确定可用；把时/分改回过去 → 红字 schedulePast + 禁用（role=status 保留）', async () => {
    const update = openPanel()
    const now = new Date()
    // 未来安全日：下月 15 日（当前展示月=当月，先翻页；15 日必在展示月内、任意时/分都 > now）
    fireEvent.click(screen.getByRole('button', { name: '下一月' }))
    const future = new Date(now.getFullYear(), now.getMonth() + 1, 15, 0, 0)
    clickDay(future)
    // 时/分默认=下一整点（必晚于当前）→ 组合完整且未来 → 绿预览 + 确定可用
    await waitFor(() => {
      expect(statusText()).toMatch(new RegExp(`^计划于 ${isoDay(future)} .+ 执行$`))
      expect(commitBtn().disabled).toBe(false)
    })
    // 回当月点选今天、再把时/分改 00:00 → 过去时刻（含「选完今天但时分已过」）→ 红字 + 禁用
    fireEvent.click(screen.getByRole('button', { name: '上一月' }))
    clickDay(now)
    fireEvent.change(screen.getByLabelText('scheduleHour'), { target: { value: '0' } })
    fireEvent.change(screen.getByLabelText('scheduleMinute'), { target: { value: '0' } })
    await waitFor(() => expect(statusText()).toBe('执行时间需晚于当前时刻'))
    expect(commitBtn().disabled).toBe(true)
    // 浮层状态行 role=status 可被辅助技术感知（日历 caption 覆盖已剥离重复 role）
    expect(within(pickerEl()).getByRole('status').textContent).toBe('执行时间需晚于当前时刻')
    expect(update).not.toHaveBeenCalled()
  })

  it('首卡：左下「立即执行」→ 关面板、when 维持 null；批准载荷无 custom', async () => {
    const update = openPanel()
    fireEvent.click(screen.getByTestId('schedule-now'))
    await waitFor(() => expect(screen.queryByTestId('schedule-picker')).toBeNull())
    // 未排期首卡点「立即执行」= 空收口：chip 仍为立即执行
    expect(screen.getByRole('button', { name: /^立即执行$/ })).toBeTruthy()
    expect(update).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '批准' }))
    await waitFor(() => {
      expect(base.pending.answer).toHaveBeenLastCalledWith({
        answers: [{ id: 'pae-approve', selected: ['批准'] }],
      })
    })
    expect(update).not.toHaveBeenCalled()
  })

  it('回显卡：左下「立即执行」清排期 → 关面板、chip 回立即执行；批准携带 paeSchedule:now', async () => {
    const at = Date.now() + 7 * 86_400_000
    const update = openPanel(at)
    // 回显卡打开即预填原时刻 → 状态行合法预览（此时尚未点选任何内容）
    expect(statusText()).toBe(previewOf(at))
    fireEvent.click(screen.getByTestId('schedule-now'))
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

  it('选日 + 改时/分 → 右下「确定」提交草稿收口；批准携带 paeSchedule:at:<草稿>（精确逐字）', async () => {
    const update = openPanel()
    const now = new Date()
    // 下月 15 日 14:30（必为未来）；日/时/分逐字确定 → 编码可精确断言
    fireEvent.click(screen.getByRole('button', { name: '下一月' }))
    const target = new Date(now.getFullYear(), now.getMonth() + 1, 15, 14, 30, 0, 0)
    clickDay(target)
    fireEvent.change(screen.getByLabelText('scheduleHour'), { target: { value: '14' } })
    fireEvent.change(screen.getByLabelText('scheduleMinute'), { target: { value: '30' } })
    await waitFor(() => expect(commitBtn().disabled).toBe(false))
    fireEvent.click(commitBtn())
    await waitFor(() => expect(screen.queryByTestId('schedule-picker')).toBeNull())
    // 草稿时刻确定 → chip 回显（与状态行预览同模板）
    expect(screen.getByRole('button', { name: previewOf(target.getTime()) })).toBeTruthy()
    expect(update).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '批准' }))
    await waitFor(() => {
      const answerMock = base.pending.answer as ReturnType<typeof vi.fn>
      const calls = answerMock.mock.calls
      const payload = calls.at(-1)![0] as { answers: Array<{ custom?: string }> }
      expect(payload.answers[0]!.custom).toBe(`paeSchedule:at:${target.getTime()}`)
    })
    expect(update).not.toHaveBeenCalled()
  })

  it('回显卡打开：日历选中排期日、时/分与状态行预填原排期；直接「确定」提交同值 → 批准保持（custom 缺省）', async () => {
    // 秒/毫秒归零：对齐 detail 解析精度（parseScheduleAt 到分钟），提交同值 → encode 不携带
    const when = new Date(Date.now() + 7 * 86_400_000)
    when.setSeconds(0, 0)
    const at = when.getTime()
    const update = vi.fn(async () => undefined)
    render(<PaeReviewCard {...scheduledArgs(at)} settings={{ update }} />)
    expect(screen.getByRole('button', { name: previewOf(at) })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: previewOf(at) })) // 点 chip 展开
    const panel = pickerEl()
    // 展示月 = 排期所在月，日历选中排期日
    expect(captionOf()).toBe(`${when.getFullYear()}年${when.getMonth() + 1}月`)
    const selected = panel.querySelector('.pae-rdp-day_selected')
    expect(selected?.getAttribute('data-day')).toBe(isoDay(when))
    // select 的 option value 为数字（文本补零展示），按数值比较
    expect(Number((within(panel).getByLabelText('scheduleHour') as HTMLSelectElement).value)).toBe(
      when.getHours(),
    )
    expect(
      Number((within(panel).getByLabelText('scheduleMinute') as HTMLSelectElement).value),
    ).toBe(when.getMinutes())
    expect(statusText()).toBe(previewOf(at)) // 原时刻未过期 → 预览即合法
    expect(commitBtn().disabled).toBe(false)
    expect(update).not.toHaveBeenCalled()
    // 直接「确定」→ when 保持原值（encode：同值 → custom 缺省）→ chip 不变
    fireEvent.click(commitBtn())
    await waitFor(() => expect(screen.queryByTestId('schedule-picker')).toBeNull())
    expect(screen.getByRole('button', { name: previewOf(at) })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '批准' }))
    await waitFor(() => {
      expect(base.pending.answer).toHaveBeenLastCalledWith({
        answers: [{ id: 'pae-approve', selected: ['批准'] }],
      })
    })
    expect(update).not.toHaveBeenCalled()
  })

  it('回显卡 chip 旁 × → 仅本地清 when=null（无 settings 写），chip 回立即执行', () => {
    const at = Date.now() + 7 * 86_400_000
    const update = vi.fn(async () => undefined)
    render(<PaeReviewCard {...scheduledArgs(at)} settings={{ update }} />)
    // × 的可访问名为 scheduleClear
    fireEvent.click(screen.getByRole('button', { name: /清除排期/ }))
    expect(screen.getByRole('button', { name: /^立即执行$/ })).toBeTruthy()
    expect(update).not.toHaveBeenCalled()
  })

  it('打开浮层不操作再点 chip 关闭 → 草稿丢弃、无任何 settings.update 调用', () => {
    const update = openPanel()
    // 浮层展开后「立即执行」出现两处（chip 与面板左下操作钮）；chip 在 DOM 中居前
    fireEvent.click(screen.getAllByRole('button', { name: /^立即执行$/ })[0]!)
    expect(screen.queryByTestId('schedule-picker')).toBeNull()
    expect(update).not.toHaveBeenCalled()
  })

  it('浮层经 portal 渲染到 document.body（脱离 .pae-card overflow:hidden 裁剪范围）', () => {
    openPanel()
    const picker = pickerEl()
    expect(picker.parentElement).toBe(document.body)
    // 样式类与面板内部 DOM 结构保持既有约定（单页操作行两钮 + 日历）
    expect(picker.className).toContain('pae-schedule-picker')
    expect(within(picker).getByTestId('schedule-calendar')).toBeTruthy()
    expect(within(picker).getByTestId('schedule-now')).toBeTruthy()
    expect(within(picker).getByTestId('schedule-commit')).toBeTruthy()
  })

  it('pointerdown 在面板/chip 外（document.body）→ 浮层失焦关闭，零 settings 写', () => {
    const update = openPanel()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByTestId('schedule-picker')).toBeNull()
    expect(update).not.toHaveBeenCalled()
  })

  it('pointerdown 在 chip 外的卡内其他区域（摘要文本）→ 浮层同样关闭', () => {
    const update = openPanel()
    fireEvent.pointerDown(screen.getByText('测试计划'))
    expect(screen.queryByTestId('schedule-picker')).toBeNull()
    expect(update).not.toHaveBeenCalled()
  })

  it('pointerdown 落在面板或 chip 内 → 不关闭（真实点击序列先 pointerdown 后 click）', () => {
    openPanel()
    fireEvent.pointerDown(pickerEl())
    expect(screen.queryByTestId('schedule-picker')).not.toBeNull()
    // chip 上的 pointerdown 不触发失焦（收起由 chip 再点完成）
    const chip = screen.getAllByRole('button', { name: /^立即执行$/ })[0]!
    fireEvent.pointerDown(chip)
    expect(screen.queryByTestId('schedule-picker')).not.toBeNull()
    fireEvent.click(chip)
    expect(screen.queryByTestId('schedule-picker')).toBeNull()
  })

  it('窗口 resize 或任意元素 scroll（capture）→ 浮层关闭（防锚点错位）', () => {
    openPanel()
    fireEvent.resize(window)
    expect(screen.queryByTestId('schedule-picker')).toBeNull()
    // 重新打开后再验证 scroll 收口（capture 监听挂 window，捕获任意滚动）
    fireEvent.click(screen.getByRole('button', { name: /^立即执行$/ }))
    expect(screen.queryByTestId('schedule-picker')).not.toBeNull()
    fireEvent.scroll(document.body)
    expect(screen.queryByTestId('schedule-picker')).toBeNull()
  })

  it('Esc 关闭浮层：面板卸载、chip aria-expanded 复位、零 settings 写', () => {
    const update = openPanel()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByTestId('schedule-picker')).toBeNull()
    expect(screen.getByRole('button', { name: /^立即执行$/ }).getAttribute('aria-expanded')).toBe(
      'false',
    )
    expect(update).not.toHaveBeenCalled()
  })

  it('打开聚焦「时」select（单页首个时间控件）；Esc 关闭后焦点归还 chip（Tab 序连续）', () => {
    openPanel() // 无排期 → 单页直开（无两态分段）
    expect(document.activeElement).toBe(screen.getByLabelText('scheduleHour'))
    fireEvent.keyDown(document.body, { key: 'Escape' })
    const chip = screen.getByRole('button', { name: /^立即执行$/ })
    expect(screen.queryByTestId('schedule-picker')).toBeNull()
    expect(document.activeElement).toBe(chip)
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
