import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { classifyStepOutcome, decideAction } from '../src/decision.ts'

let seq = 0
const ev = (type: string, data: object): SessionEvent =>
  ({ seq: ++seq, type, data }) as SessionEvent

describe('classifyStepOutcome', () => {
  it('turn aborted → aborted（优先于 report）', () => {
    const recent = [
      ev('pae/step-report', { stepIndex: 1, outcome: 'done', summary: 'x' }),
      ev('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }),
    ]
    expect(classifyStepOutcome(recent, 1)).toBe('aborted')
  })
  it('turn error / max-tokens / interrupted → failed', () => {
    for (const kind of ['error', 'max-tokens', 'interrupted'] as const) {
      const recent = [ev('turn/end', { turn: 1, reason: { kind } })]
      expect(classifyStepOutcome(recent, 1)).toBe('failed')
    }
  })
  it('completed + 本步 report → done/blocked；他步 report 不算', () => {
    const ok = [
      ev('pae/step-report', { stepIndex: 1, outcome: 'done', summary: 's' }),
      ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ]
    expect(classifyStepOutcome(ok, 1)).toBe('done')
    const blocked = [
      ev('pae/step-report', { stepIndex: 1, outcome: 'blocked', summary: 's' }),
      ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ]
    expect(classifyStepOutcome(blocked, 1)).toBe('blocked')
    const other = [
      ev('pae/step-report', { stepIndex: 2, outcome: 'done', summary: 's' }),
      ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ]
    expect(classifyStepOutcome(other, 1)).toBe('missing-report')
  })
})

describe('decideAction', () => {
  const policy = { onStepFailure: 'pause' as const, maxAutoRecoveries: 2 }
  it('done → advance；aborted → pause(cancelled)', () => {
    expect(decideAction('done', { nudged: false, recoveries: 0, policy })).toEqual({ kind: 'advance' })
    expect(decideAction('aborted', { nudged: false, recoveries: 0, policy })).toEqual({
      kind: 'pause',
      reason: 'cancelled',
    })
  })
  it('missing-report：首次 nudge，追问后按失败处理', () => {
    expect(decideAction('missing-report', { nudged: false, recoveries: 0, policy })).toEqual({
      kind: 'nudge',
    })
    expect(decideAction('missing-report', { nudged: true, recoveries: 0, policy })).toEqual({
      kind: 'pause',
      reason: 'failure',
    })
  })
  it('failure 默认 pause；auto-recover 在限额内 recover，超限 pause', () => {
    expect(decideAction('failed', { nudged: false, recoveries: 0, policy })).toEqual({
      kind: 'pause',
      reason: 'failure',
    })
    const auto = { onStepFailure: 'auto-recover' as const, maxAutoRecoveries: 2 }
    expect(decideAction('blocked', { nudged: false, recoveries: 1, policy: auto })).toEqual({
      kind: 'recover',
    })
    expect(decideAction('blocked', { nudged: false, recoveries: 2, policy: auto })).toEqual({
      kind: 'pause',
      reason: 'failure',
    })
  })
})
