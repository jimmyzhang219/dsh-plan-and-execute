import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { decideScheduledFire, voidColdArchivedSession } from '../src/archive-guard.ts'
import type { PersistedOrchestratorState } from '../src/persist.ts'

const tempDirs: string[] = []

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

/** 建临时会话 cwd，写入 <cwd>/.pae/<sessionId>/orchestrator.json，返回 { cwd, planDir }。 */
async function seedColdState(
  sessionId: string,
  phase: PersistedOrchestratorState['phase'],
  extra: Partial<PersistedOrchestratorState> = {},
): Promise<{ cwd: string; planDir: string }> {
  const cwd = await mkdtemp(join(tmpdir(), 'pae-cold-'))
  tempDirs.push(cwd)
  const planDir = join(cwd, '.pae', sessionId)
  await mkdir(planDir, { recursive: true })
  await writeFile(
    join(planDir, 'orchestrator.json'),
    JSON.stringify({
      phase,
      planDir,
      stepReports: [],
      statuses: {},
      skipped: [],
      ...extra,
    } satisfies PersistedOrchestratorState),
    'utf8',
  )
  return { cwd, planDir }
}

/** 读回状态文件（断言作废是否落盘）。 */
async function readColdState(sessionId: string, cwd: string): Promise<Record<string, unknown>> {
  const raw = await readFile(join(cwd, '.pae', sessionId, 'orchestrator.json'), 'utf8')
  return JSON.parse(raw) as Record<string, unknown>
}

describe('decideScheduledFire（到点触发决策）', () => {
  it('workspaceRegistry 缺失（archivedIds undefined）→ 无法判定放行 execute', () => {
    expect(decideScheduledFire(undefined, 'sess-1')).toBe('execute')
  })

  it('归档集合含目标会话 → void-by-archive', () => {
    expect(decideScheduledFire(['sess-1', 'sess-2'], 'sess-1')).toBe('void-by-archive')
  })

  it('归档集合不含目标会话 → execute', () => {
    expect(decideScheduledFire(['sess-2'], 'sess-1')).toBe('execute')
  })

  it('空归档集合 → execute', () => {
    expect(decideScheduledFire([], 'sess-1')).toBe('execute')
  })
})

describe('voidColdArchivedSession（冷归档会话终态落盘）', () => {
  it('phase=scheduled 的排期文件 → 改写 aborted：scheduledAt 键删除、plan/其余字段保留', async () => {
    const sessionId = 'cold-1'
    const { cwd } = await seedColdState(sessionId, 'scheduled', {
      scheduledAt: 1_800_000_000_000,
      task: 'T',
      plan: {
        planDir: 'PLAN_DIR_PLACEHOLDER',
        steps: [{ file: 'a.md', title: 'A' }],
      },
    })
    const warn = vi.fn<(message: string) => void>()
    await voidColdArchivedSession(
      {
        listHeaders: async () => [{ id: sessionId, cwd }],
        planRoot: '.pae',
        warn,
      },
      sessionId,
    )
    const state = await readColdState(sessionId, cwd)
    expect(state.phase).toBe('aborted')
    expect(state).not.toHaveProperty('scheduledAt')
    expect(state.task).toBe('T') // 其余字段保留
    expect((state.plan as { steps: unknown[] }).steps).toHaveLength(1) // plan 保留供查看
    expect(warn).not.toHaveBeenCalled()
  })

  it('phase 非 scheduled（executing）→ 不动、不告警', async () => {
    const sessionId = 'cold-2'
    const { cwd } = await seedColdState(sessionId, 'executing', { stepIndex: 1 })
    const warn = vi.fn<(message: string) => void>()
    await voidColdArchivedSession(
      { listHeaders: async () => [{ id: sessionId, cwd }], planRoot: '.pae', warn },
      sessionId,
    )
    expect((await readColdState(sessionId, cwd)).phase).toBe('executing')
    expect(warn).not.toHaveBeenCalled()
  })

  it('会话不在持久化索引中 → warn 遗留，状态文件不动', async () => {
    const sessionId = 'cold-3'
    const { cwd } = await seedColdState(sessionId, 'scheduled')
    const warn = vi.fn<(message: string) => void>()
    await voidColdArchivedSession(
      { listHeaders: async () => [{ id: 'other-session', cwd }], planRoot: '.pae', warn },
      sessionId,
    )
    expect((await readColdState(sessionId, cwd)).phase).toBe('scheduled')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(sessionId))
  })

  it('无 sessionPersistence 服务（listHeaders undefined）→ warn 遗留，不抛', async () => {
    const sessionId = 'cold-4'
    const { cwd } = await seedColdState(sessionId, 'scheduled')
    const warn = vi.fn<(message: string) => void>()
    await voidColdArchivedSession({ planRoot: '.pae', warn }, sessionId)
    expect((await readColdState(sessionId, cwd)).phase).toBe('scheduled')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(sessionId))
  })

  it('header 无 cwd → warn 遗留，状态文件不动', async () => {
    const sessionId = 'cold-5'
    const { cwd } = await seedColdState(sessionId, 'scheduled')
    const warn = vi.fn<(message: string) => void>()
    await voidColdArchivedSession(
      { listHeaders: async () => [{ id: sessionId }], planRoot: '.pae', warn },
      sessionId,
    )
    expect((await readColdState(sessionId, cwd)).phase).toBe('scheduled')
    expect(warn).toHaveBeenCalled()
  })
})
