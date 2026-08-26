import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  buildTodoPayload,
  foldPae,
  foldPaePlan,
  foldStepReports,
  isPlanModeActive,
} from '../src/state.ts'

let seq = 0
const ev = <T extends string>(type: T, data: object): SessionEvent =>
  ({ seq: (seq += 1), type, data }) as SessionEvent

describe('foldPae', () => {
  it('空日志折叠为 none', () => {
    expect(foldPae([]).phase).toBe('none')
  })
  it('last-wins：最后一个 pae/state 胜出', () => {
    const events = [
      ev('pae/state', { phase: 'planning', task: 'T', planDir: '/p' }),
      ev('pae/state', { phase: 'executing', stepIndex: 2 }),
    ]
    const folded = foldPae(events)
    expect(folded.phase).toBe('executing')
    expect(folded.stepIndex).toBe(2)
  })
  it('paused 携带 pausedReason，非 pae 事件被忽略', () => {
    const events = [
      ev('pae/state', { phase: 'planning' }),
      ev('turn/start', { turn: 1 }),
      ev('pae/state', { phase: 'paused', pausedReason: 'failure', stepIndex: 3 }),
    ]
    expect(foldPae(events)).toMatchObject({ phase: 'paused', pausedReason: 'failure', stepIndex: 3 })
  })
})

describe('foldPaePlan', () => {
  it('无计划返回 undefined；replan 取最后一个', () => {
    expect(foldPaePlan([])).toBeUndefined()
    const p1 = ev('pae/plan', { planDir: '/p', steps: [{ file: 'a.md', title: 'A' }] })
    const p2 = ev('pae/plan', { planDir: '/p', steps: [{ file: 'b.md', title: 'B' }] })
    expect(foldPaePlan([p1, p2])?.steps[0]?.file).toBe('b.md')
  })
})

describe('foldStepReports', () => {
  it('按 stepIndex last-wins 聚合', () => {
    const events = [
      ev('pae/step-report', { stepIndex: 1, outcome: 'done', summary: 's1' }),
      ev('pae/step-report', { stepIndex: 2, outcome: 'blocked', summary: 's2' }),
      ev('pae/step-report', { stepIndex: 1, outcome: 'blocked', summary: 's1b' }),
    ]
    const reports = foldStepReports(events)
    expect(reports.get(1)?.summary).toBe('s1b')
    expect(reports.get(2)?.outcome).toBe('blocked')
  })
})

describe('buildTodoPayload', () => {
  it('按状态表构造整表快照，缺省 pending', () => {
    const steps = [
      { file: 'a.md', title: 'A' },
      { file: 'b.md', title: 'B' },
    ]
    const payload = buildTodoPayload(steps, new Map([[1, 'completed'], [2, 'in_progress']]))
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
