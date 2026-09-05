import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo'
import { restoreState, snapshotState } from '../src/persist.ts'
import {
  buildTodoPayload,
  decodeApprovalSchedule,
  isPlanModeActive,
  normalizeDir,
  PAE_PLUGIN,
  PAE_SCHEDULE_NS,
  type PaeStepReportPayload,
} from '../src/state.ts'

describe('buildTodoPayload', () => {
  it('按状态表构造整表快照，缺省 pending', () => {
    const steps = [
      { file: 'a.md', title: 'A' },
      { file: 'b.md', title: 'B' },
    ]
    const payload = buildTodoPayload(
      steps,
      new Map([
        [1, 'completed'],
        [2, 'in_progress'],
      ]),
    )
    expect(payload.todos).toEqual([
      { content: '1. A', status: 'completed' },
      { content: '2. B', status: 'in_progress' },
    ])
  })
})

describe('isPlanModeActive', () => {
  it('读宿主 plan/mode 事件，last-wins', () => {
    const events = [
      { seq: 1, type: 'plan/mode', data: { active: true } } as SessionEvent,
      { seq: 2, type: 'plan/mode', data: { active: false } } as SessionEvent,
    ]
    expect(isPlanModeActive(events)).toBe(false)
    expect(isPlanModeActive([events[0]!])).toBe(true)
    expect(isPlanModeActive([])).toBe(false)
  })
})

describe('normalizeDir', () => {
  it('去尾部斜杠', () => {
    expect(normalizeDir('/a/b/')).toBe('/a/b')
    expect(normalizeDir('/a/b///')).toBe('/a/b')
    expect(normalizeDir('/a/b')).toBe('/a/b')
  })
})

describe('stepModels 持久化往返', () => {
  it('snapshotState 仅非空输出；restoreState 还原为 Map', () => {
    const base = {
      phase: 'executing' as const,
      stepReports: new Map<number, PaeStepReportPayload>(),
      statuses: new Map<number, TodoItem['status']>(),
      skipped: new Set<number>(),
      anchorSeqs: new Map<number, number>(),
    }
    const empty = snapshotState({ ...base, stepModels: new Map() })
    expect('stepModels' in empty).toBe(false)
    expect('anchorSeqs' in empty).toBe(false)
    const filled = snapshotState({
      ...base,
      stepModels: new Map([[1, { provider: 'a', model: 'm' }]]),
      anchorSeqs: new Map([[1, 7]]),
    })
    expect(filled.stepModels).toEqual({ 1: { provider: 'a', model: 'm' } })
    expect(filled.anchorSeqs).toEqual({ 1: 7 })
    const restored = restoreState(filled)
    expect(restored.stepModels).toEqual(new Map([[1, { provider: 'a', model: 'm' }]]))
    expect(restored.anchorSeqs).toEqual(new Map([[1, 7]]))
  })
})

describe('旧版 outcome → status 迁移', () => {
  it('restoreState 把旧 { outcome, summary } 汇报映射为新协议；新协议条目原样通过', () => {
    const restored = restoreState({
      phase: 'executing',
      stepReports: [
        { stepIndex: 1, outcome: 'done', summary: '完成' } as unknown as PaeStepReportPayload,
        { stepIndex: 2, outcome: 'blocked', summary: '卡住' } as unknown as PaeStepReportPayload,
        { stepIndex: 3, status: 'failed', artifacts: ['a.md'], summary: '受阻', exit_code: 1 },
      ],
      statuses: {},
      skipped: [],
    })
    expect(restored.stepReports.get(1)).toEqual({
      stepIndex: 1,
      status: 'success',
      artifacts: [],
      summary: '完成',
    })
    expect(restored.stepReports.get(2)).toEqual({
      stepIndex: 2,
      status: 'failed',
      artifacts: [],
      summary: '卡住',
    })
    expect(restored.stepReports.get(3)).toEqual({
      stepIndex: 3,
      status: 'failed',
      artifacts: ['a.md'],
      summary: '受阻',
      exit_code: 1,
    })
  })
})

describe('PAE_SCHEDULE_NS', () => {
  it('排期 settings 命名空间常量', () => {
    expect(PAE_SCHEDULE_NS).toBe('pae-schedule')
    expect(PAE_PLUGIN).toBe('dsh-plan-and-execute')
  })
})

describe('decodeApprovalSchedule', () => {
  it('custom 缺省/空 → none（无排期意图）', () => {
    expect(decodeApprovalSchedule(undefined)).toEqual({ kind: 'none' })
    expect(decodeApprovalSchedule('')).toEqual({ kind: 'none' })
  })
  it('显式立即执行编码 → now', () => {
    expect(decodeApprovalSchedule('paeSchedule:now')).toEqual({ kind: 'now' })
  })
  it('指定时刻编码（安全正整数 epoch ms）→ at', () => {
    expect(decodeApprovalSchedule('paeSchedule:at:1750000000000')).toEqual({
      kind: 'at',
      at: 1_750_000_000_000,
    })
  })
  it('格式非法（负数/小数/非数字/垃圾文本/前缀后多字）→ none（不抛）', () => {
    expect(decodeApprovalSchedule('paeSchedule:at:-1')).toEqual({ kind: 'none' })
    expect(decodeApprovalSchedule('paeSchedule:at:1.5')).toEqual({ kind: 'none' })
    expect(decodeApprovalSchedule('paeSchedule:at:x')).toEqual({ kind: 'none' })
    expect(decodeApprovalSchedule('垃圾文本')).toEqual({ kind: 'none' })
    expect(decodeApprovalSchedule('paeSchedule:nowx')).toEqual({ kind: 'none' })
  })
})

describe('persist scheduledAt', () => {
  it('snapshotState 透出 scheduledAt；restoreState 忽略旧文件（无字段）', () => {
    const snap = snapshotState({
      phase: 'scheduled',
      scheduledAt: 1_750_000_000_000,
      stepReports: new Map(),
      statuses: new Map(),
      stepModels: new Map(),
      skipped: new Set(),
      anchorSeqs: new Map(),
    })
    expect(snap.phase).toBe('scheduled')
    expect(snap.scheduledAt).toBe(1_750_000_000_000)
    // 无 scheduledAt 字段 → 不写键
    const plain = snapshotState({
      phase: 'planning',
      stepReports: new Map(),
      statuses: new Map(),
      stepModels: new Map(),
      skipped: new Set(),
      anchorSeqs: new Map(),
    })
    expect('scheduledAt' in plain).toBe(false)
  })
})
