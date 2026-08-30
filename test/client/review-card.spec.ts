import { describe, expect, it } from 'vitest'
import {
  buildSettingsPatch,
  findLatestSubmitPlanArgs,
  isPlanReviewPending,
  questionView,
} from '../../src/client/review-card.ts'

const pending = {
  kind: 'plan-review',
  key: 'k1',
  questions: [
    {
      id: 'pae-approve',
      question: '批准此计划（共 2 步）并开始执行？',
      options: [
        { label: '批准', description: '离开规划阶段' },
        { label: '继续修改', description: '留在规划阶段' },
      ],
    },
  ],
  answer: async () => undefined,
  cancel: async () => undefined,
}

describe('isPlanReviewPending', () => {
  it('plan-review 结构命中', () => {
    expect(isPlanReviewPending(pending)).toBe(true)
  })
  it('其他结构放行（question kind / 缺 answer / 非对象）', () => {
    expect(isPlanReviewPending({ ...pending, kind: 'question' })).toBe(false)
    expect(isPlanReviewPending({ ...pending, answer: undefined })).toBe(false)
    expect(isPlanReviewPending(null)).toBe(false)
    expect(isPlanReviewPending('x')).toBe(false)
  })
})

describe('questionView', () => {
  it('提取 id/question/options', () => {
    expect(questionView(pending.questions)).toEqual({
      id: 'pae-approve',
      question: '批准此计划（共 2 步）并开始执行？',
      options: [
        { label: '批准', description: '离开规划阶段' },
        { label: '继续修改', description: '留在规划阶段' },
      ],
    })
  })
  it('形状不符返回 undefined', () => {
    expect(questionView([])).toBeUndefined()
    expect(questionView([{ id: 'x' }])).toBeUndefined()
  })
})

describe('buildSettingsPatch', () => {
  it('sessionId 键 + serializeStepModels 结果', () => {
    expect(buildSettingsPatch('sess-1', { 1: 'a|m1' })).toEqual({
      'sess-1': { 1: { provider: 'a', model: 'm1' } },
    })
  })
})

// —— findLatestSubmitPlanArgs：节点形状以宿主 ui-chat conversation-nodes 为准 ——
// ChatNode<'tool-call'> = ChatConversationViewNode & { kind: 'tool-call', data: { root: ToolCallBlock } }；
// ToolCallBlock = RunningToolCall（name/argsRaw 顶层）| ToolResultNode（call 回填 name/argsRaw）。

/** running 形态 tool-call 节点（宿主 records.ts RunningToolCall）。 */
function runningToolNode(callId: string, argsRaw: string) {
  return {
    kind: 'tool-call',
    target: 'chat',
    anchorSeq: 1,
    location: { kind: 'step', turn: { turn: 1 }, step: { step: 1 } },
    visibility: 'visible',
    data: {
      root: {
        callId,
        name: 'submit_plan',
        argsRaw,
        turn: 1,
        step: 1,
        time: 1,
        subCalls: [],
      },
    },
  }
}

/** settled 形态 tool-call 节点（宿主 records.ts ToolResultNode，call 回填）。 */
function settledToolNode(callId: string, argsRaw: string) {
  return {
    kind: 'tool-call',
    target: 'chat',
    anchorSeq: 2,
    location: { kind: 'step', turn: { turn: 1 }, step: { step: 1 } },
    visibility: 'visible',
    data: {
      root: {
        kind: 'tool-result',
        seq: 2,
        time: 2,
        callId,
        call: { name: 'submit_plan', argsRaw },
        callTime: 1,
        content: [],
        isError: false,
        subCalls: [],
      },
    },
  }
}

/** 最小 chat 快照（ChatSnapshot.nodes.values() 面）。 */
function chatOf(nodes: readonly unknown[]): unknown {
  return { nodes: { values: () => nodes } }
}

describe('findLatestSubmitPlanArgs', () => {
  it('running 形态命中：取最后一个 submit_plan 的 argsRaw 解析', () => {
    const chat = chatOf([
      { kind: 'user-message', target: 'chat', anchorSeq: 0, location: {}, visibility: 'visible' },
      runningToolNode('c1', JSON.stringify({ planDir: '.pae/s1', steps: [{ file: 'a.md', title: 'A' }] })),
      runningToolNode('c2', JSON.stringify({ planDir: '.pae/s2', steps: [{ file: 'b.md', title: 'B' }] })),
    ])
    expect(findLatestSubmitPlanArgs(chat)).toEqual({
      planDir: '.pae/s2',
      steps: [{ file: 'b.md', title: 'B' }],
    })
  })
  it('settled 形态命中（call 回填 name/argsRaw）', () => {
    const chat = chatOf([
      settledToolNode('c1', JSON.stringify({ planDir: '.pae/s1', steps: [{ file: 'a.md', title: 'A' }] })),
    ])
    expect(findLatestSubmitPlanArgs(chat)).toEqual({
      planDir: '.pae/s1',
      steps: [{ file: 'a.md', title: 'A' }],
    })
  })
  it('无 submit_plan 节点 → undefined', () => {
    const chat = chatOf([
      { kind: 'user-message', target: 'chat', anchorSeq: 0, location: {}, visibility: 'visible' },
      { kind: 'tool-call', target: 'chat', anchorSeq: 1, location: {}, visibility: 'visible', data: { root: { callId: 'c1', name: 'bash', argsRaw: '{"command":"ls"}', turn: 1, step: 1, time: 1, subCalls: [] } } },
    ])
    expect(findLatestSubmitPlanArgs(chat)).toBeUndefined()
  })
  it('chat 非对象 / nodes 缺 values → undefined', () => {
    expect(findLatestSubmitPlanArgs(null)).toBeUndefined()
    expect(findLatestSubmitPlanArgs('x')).toBeUndefined()
    expect(findLatestSubmitPlanArgs({ nodes: {} })).toBeUndefined()
  })
  it('argsRaw 非 JSON → undefined', () => {
    const chat = chatOf([runningToolNode('c1', 'not-json{')])
    expect(findLatestSubmitPlanArgs(chat)).toBeUndefined()
  })
  it('非 tool-call 节点混入被跳过', () => {
    const chat = chatOf([
      { kind: 'assistant-message', target: 'chat', anchorSeq: 0, location: {}, visibility: 'visible' },
      runningToolNode('c1', JSON.stringify({ planDir: '.pae/s1', steps: [{ file: 'a.md', title: 'A' }] })),
    ])
    expect(findLatestSubmitPlanArgs(chat)).toEqual({
      planDir: '.pae/s1',
      steps: [{ file: 'a.md', title: 'A' }],
    })
  })
  it('subCalls 递归命中（遍历 conversation 树）', () => {
    const parent = runningToolNode('c1', JSON.stringify({ command: 'run' }))
    ;(parent.data.root as { subCalls: unknown[] }).subCalls = [
      { callId: 'c1-1', name: 'submit_plan', argsRaw: JSON.stringify({ planDir: '.pae/s1', steps: [{ file: 'a.md', title: 'A' }] }), turn: 1, step: 1, time: 1, subCalls: [] },
    ]
    const chat = chatOf([parent])
    expect(findLatestSubmitPlanArgs(chat)).toEqual({
      planDir: '.pae/s1',
      steps: [{ file: 'a.md', title: 'A' }],
    })
  })
})
