import { describe, expect, it } from 'vitest'
import { classifyOutcome, decideAction } from '../src/decision.ts'

describe('classifyOutcome', () => {
  it('turn aborted → aborted（优先于 report）', () => {
    expect(classifyOutcome('aborted', { stepIndex: 1, outcome: 'done', summary: 'x' })).toBe(
      'aborted',
    )
  })
  it('turn error / max-tokens / interrupted → failed', () => {
    for (const kind of ['error', 'max-tokens', 'interrupted']) {
      expect(classifyOutcome(kind, undefined)).toBe('failed')
    }
  })
  it('completed + 本步 report → done/blocked；无 report → missing-report', () => {
    expect(classifyOutcome('completed', { stepIndex: 1, outcome: 'done', summary: 's' })).toBe(
      'done',
    )
    expect(classifyOutcome('completed', { stepIndex: 1, outcome: 'blocked', summary: 's' })).toBe(
      'blocked',
    )
    expect(classifyOutcome('completed', undefined)).toBe('missing-report')
  })
  it('无 turn/end 但无 report → missing-report', () => {
    expect(classifyOutcome(undefined, undefined)).toBe('missing-report')
  })
})

describe('decideAction', () => {
  const policy = { onStepFailure: 'pause' as const, maxAutoRecoveries: 2 }
  it('done → advance；aborted → pause(cancelled)', () => {
    expect(decideAction('done', { nudged: false, recoveries: 0, policy })).toEqual({
      kind: 'advance',
    })
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
