import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo'
import { restoreState, snapshotState } from '../src/persist.ts'
import {
  buildTodoPayload,
  isPlanModeActive,
  normalizeDir,
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
    }
    const empty = snapshotState({ ...base, stepModels: new Map() })
    expect('stepModels' in empty).toBe(false)
    const filled = snapshotState({
      ...base,
      stepModels: new Map([[1, { provider: 'a', model: 'm' }]]),
    })
    expect(filled.stepModels).toEqual({ 1: { provider: 'a', model: 'm' } })
    const restored = restoreState(filled)
    expect(restored.stepModels).toEqual(new Map([[1, { provider: 'a', model: 'm' }]]))
  })
})
