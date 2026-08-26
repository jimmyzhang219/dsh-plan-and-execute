import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { validateManifest } from '../src/manifest.ts'

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pae-manifest-'))
  await writeFile(join(dir, 'step-01.md'), '# Step 1\ncontent', 'utf8')
  await writeFile(join(dir, 'empty.md'), '', 'utf8')
  await mkdir(join(dir, 'subdir'))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('validateManifest', () => {
  it('全部合法 → ok', async () => {
    const result = await validateManifest(dir, [{ file: 'step-01.md', title: 'S1' }])
    expect(result).toEqual({ ok: true })
  })
  it('空步骤清单 → 报错', async () => {
    const result = await validateManifest(dir, [])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues[0]?.problem).toContain('至少')
  })
  it('绝对路径 / .. 逃逸 → 报错（不触盘）', async () => {
    const result = await validateManifest(dir, [
      { file: '/etc/passwd', title: 'A' },
      { file: '../escape.md', title: 'B' },
    ])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues).toHaveLength(2)
  })
  it('悬空 / 空文件 / 目录 → 报错', async () => {
    const result = await validateManifest(dir, [
      { file: 'missing.md', title: 'A' },
      { file: 'empty.md', title: 'B' },
      { file: 'subdir', title: 'C' },
    ])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues.map(i => i.file)).toEqual(['missing.md', 'empty.md', 'subdir'])
    }
  })
})
