// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  PaeReviewCard,
  PaeReviewCardView,
  type PaeReviewCardProps,
} from '../../src/client/PaeReviewCard.tsx'
import { PAE_MODELS_NS } from '../../src/state.ts'

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
