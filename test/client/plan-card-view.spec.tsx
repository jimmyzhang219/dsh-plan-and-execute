// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  SubmitPlanCardView,
  type SessionRemoteLike,
  type SubmitPlanCardViewProps,
} from '../../src/client/PlanCard.tsx'
import { buildSetModelsPrompt } from '../../src/client/plan-card.ts'

// vitest 未开 globals：显式 cleanup 避免跨用例 DOM 累积（与 plan-card-render.spec.tsx 一致）。
afterEach(cleanup)

const planArgs = {
  planDir: '.pae/sess-9',
  summary: '冒烟计划',
  steps: [
    { file: 'a.md', title: '步骤 A' },
    { file: 'b.md', title: '步骤 B' },
  ],
}

const catalog: ModelCatalog = {
  default: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  routableProviders: ['deepseek-official'],
  groups: [
    {
      id: 'deepseek-official',
      name: 'DeepSeek Official',
      models: [
        { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash' },
        { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro' },
      ],
    },
  ],
  failures: [],
}

type Block = SubmitPlanCardViewProps['block']

/** running 形态：无 kind，argsRaw 在顶层。 */
function runningBlock(args: unknown): Block {
  return {
    callId: 'call-1',
    name: 'submit_plan',
    argsRaw: JSON.stringify(args),
    turn: 1,
    step: 1,
    time: 1,
    subCalls: [],
  }
}

/** settled 形态：kind: 'tool-result'，argsRaw 在 call 头内。 */
function settledBlock(args: unknown): Block {
  return {
    kind: 'tool-result',
    seq: 1,
    time: 1,
    callId: 'call-1',
    call: { name: 'submit_plan', argsRaw: JSON.stringify(args) },
    callTime: 1,
    content: [{ type: 'text', text: 'ok' }],
    isError: false,
    subCalls: [],
  }
}

/** 最小 session 远端面 mock（SessionRemoteLike 契约，无需 as 绕过）。 */
function makeSessionRemote(): SessionRemoteLike {
  return {
    modelCatalog: vi.fn(async () => ({ ok: true as const, value: catalog })),
    canOpenWorkspacePath: vi.fn(async () => ({ ok: true as const, value: true })),
    prompt: vi.fn(async () => ({ ok: true as const, value: { accepted: true as const } })),
  }
}

function makeProps(overrides: Partial<SubmitPlanCardViewProps> = {}): SubmitPlanCardViewProps {
  return {
    callId: 'call-1',
    toolName: 'submit_plan',
    block: runningBlock(planArgs),
    openFile: vi.fn(),
    useSession: vi.fn(),
    sessionId: 'sess-1' as SessionId,
    useProjection: vi.fn(() => undefined),
    useWorkspaces: vi.fn(),
    useSessions: vi.fn(),
    useSessionPendingInteraction: vi.fn(),
    useConversation: vi.fn(),
    useChat: vi.fn(),
    useInput: vi.fn(),
    inputActions: {
      setDraft: vi.fn(),
      addImages: vi.fn(),
      removeImage: vi.fn(),
      pruneImages: vi.fn(),
      submit: vi.fn(),
    },
    t: (key: string) => key,
    sessionRemote: makeSessionRemote(),
    connection: { isLoopback: true },
    ...overrides,
  }
}

describe('SubmitPlanCardView', () => {
  it('running block（顶层 argsRaw）→ 卡片渲染，默认模型 = catalog.default，打开目录走 owner openFile', async () => {
    const openFile = vi.fn()
    const sessionRemote = makeSessionRemote()
    render(<SubmitPlanCardView {...makeProps({ openFile, sessionRemote })} />)
    await screen.findByText(/步骤 A/)
    expect(screen.getByText(/步骤 B/)).toBeTruthy()
    expect(screen.getByText('a.md')).toBeTruthy()
    expect((screen.getAllByRole('combobox')[0] as HTMLSelectElement).value).toBe(
      'deepseek-official|deepseek-v4-flash',
    )
    fireEvent.click(screen.getByRole('button', { name: 'openDir' }))
    expect(openFile).toHaveBeenCalledWith('.pae/sess-9')
    expect(sessionRemote.canOpenWorkspacePath).toHaveBeenCalled()
  })

  it('settled block（call.argsRaw）→ 卡片渲染', async () => {
    render(<SubmitPlanCardView {...makeProps({ block: settledBlock(planArgs) })} />)
    await screen.findByText(/步骤 A/)
    expect(screen.getByText(/步骤 B/)).toBeTruthy()
  })

  it('modelCatalog 失败 → modelUnavailable 降级渲染（不白屏）', async () => {
    const sessionRemote = makeSessionRemote()
    sessionRemote.modelCatalog = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'catalog-boom', message: 'catalog down', details: {} },
    }))
    render(<SubmitPlanCardView {...makeProps({ sessionRemote })} />)
    await screen.findByText('modelUnavailable')
    expect(screen.getByText('.pae/sess-9')).toBeTruthy()
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('点「应用模型」→ sessionRemote.prompt 收到 set-models 命令载荷（queue/text）', async () => {
    const sessionRemote = makeSessionRemote()
    render(<SubmitPlanCardView {...makeProps({ sessionRemote })} />)
    await screen.findByText(/步骤 A/)
    fireEvent.change(screen.getAllByRole('combobox')[0]!, {
      target: { value: 'deepseek-official|deepseek-v4-pro' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'applyModels' }))
    await vi.waitFor(() => {
      expect(sessionRemote.prompt).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'sess-1',
          mode: 'queue',
          content: [
            {
              type: 'text',
              text: buildSetModelsPrompt({
                1: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
                2: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
              }),
            },
          ],
        }),
      )
    })
  })

  it('connection 非 loopback → 无打开按钮（只显示路径文本）', async () => {
    render(<SubmitPlanCardView {...makeProps({ connection: { isLoopback: false } })} />)
    await screen.findByText(/步骤 A/)
    expect(screen.queryByRole('button', { name: 'openDir' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'openFile' })).toBeNull()
  })
})
