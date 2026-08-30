// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  SubmitPlanCardView,
  type SessionRemoteLike,
  type SubmitPlanCardViewProps,
} from '../../src/client/PlanCard.tsx'

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

/** prompt 侦听 mock：view 契约不含 prompt（简化后不再发消息），侦听器用于「未被调用」断言。 */
type SessionRemoteMock = SessionRemoteLike & { readonly prompt: ReturnType<typeof vi.fn> }

/** 最小 session 远端面 mock（SessionRemoteLike 契约，无需 as 绕过）。 */
function makeSessionRemote(): SessionRemoteMock {
  return {
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
  it('running block（顶层 argsRaw）→ 卡片渲染步骤，打开目录走 owner openFile', async () => {
    const openFile = vi.fn()
    const sessionRemote = makeSessionRemote()
    render(<SubmitPlanCardView {...makeProps({ openFile, sessionRemote })} />)
    await screen.findByText(/步骤 A/)
    expect(screen.getByText(/步骤 B/)).toBeTruthy()
    expect(screen.getByText('a.md')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'openDir' }))
    expect(openFile).toHaveBeenCalledWith('.pae/sess-9')
    expect(sessionRemote.canOpenWorkspacePath).toHaveBeenCalled()
  })

  it('settled block（call.argsRaw）→ 卡片渲染', async () => {
    render(<SubmitPlanCardView {...makeProps({ block: settledBlock(planArgs) })} />)
    await screen.findByText(/步骤 A/)
    expect(screen.getByText(/步骤 B/)).toBeTruthy()
  })

  it('canOpenWorkspacePath reject → 卡片仍渲染步骤、无打开按钮（不白屏）', async () => {
    const sessionRemote = makeSessionRemote()
    sessionRemote.canOpenWorkspacePath = vi.fn(async () => {
      throw new Error('rpc boom')
    })
    render(<SubmitPlanCardView {...makeProps({ sessionRemote })} />)
    await screen.findByText(/步骤 A/)
    expect(screen.getByText(/步骤 B/)).toBeTruthy()
    expect(screen.queryByText('modelUnavailable')).toBeNull()
    expect(screen.queryByRole('button', { name: 'openDir' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'openFile' })).toBeNull()
  })

  it('简化后：无应用按钮，不调用 sessionRemote.prompt（模型选择唯一入口 = 审批卡）', async () => {
    const sessionRemote = makeSessionRemote()
    render(<SubmitPlanCardView {...makeProps({ sessionRemote })} />)
    await screen.findByText(/步骤 A/)
    expect(screen.queryByRole('button', { name: 'applyModels' })).toBeNull()
    expect(screen.queryAllByRole('combobox')).toHaveLength(0)
    expect(sessionRemote.prompt).not.toHaveBeenCalled()
  })

  it('connection 非 loopback → 无打开按钮（只显示路径文本）', async () => {
    render(<SubmitPlanCardView {...makeProps({ connection: { isLoopback: false } })} />)
    await screen.findByText(/步骤 A/)
    expect(screen.queryByRole('button', { name: 'openDir' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'openFile' })).toBeNull()
  })

  it('旧会话载荷缺 planDir → 降级渲染步骤列表（无打开按钮）', async () => {
    const noPlanDir = { summary: '旧计划', steps: planArgs.steps }
    render(<SubmitPlanCardView {...makeProps({ block: runningBlock(noPlanDir) })} />)
    await screen.findByText(/步骤 A/)
    expect(screen.getByText(/步骤 B/)).toBeTruthy()
    expect(screen.getByText('a.md')).toBeTruthy()
    // 缺 planDir → 打开路径不可用：目录区与打开按钮都不渲染
    expect(screen.queryByRole('button', { name: 'openDir' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'openFile' })).toBeNull()
  })
})
