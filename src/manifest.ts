/**
 * manifest 步骤文件校验：路径安全（必须相对 planDir、无 .. 段）+ 存在/非空/是文件。
 * @module plan-and-execute/manifest
 */
import { stat } from 'node:fs/promises'
import { isAbsolute, join, sep } from 'node:path'
import type { PlanStep } from './state.ts'

export interface ManifestIssue {
  readonly index: number
  readonly file: string
  readonly problem: string
}

export type ManifestCheck = { ok: true } | { ok: false; issues: readonly ManifestIssue[] }

export async function validateManifest(
  planDir: string,
  steps: readonly PlanStep[],
): Promise<ManifestCheck> {
  if (steps.length === 0) {
    return { ok: false, issues: [{ index: -1, file: '', problem: '计划至少需要一步' }] }
  }
  const issues: ManifestIssue[] = []
  for (const [index, step] of steps.entries()) {
    const file = step.file
    if (file.trim() === '' || isAbsolute(file) || file.split(sep).includes('..')) {
      issues.push({
        index,
        file,
        problem: 'file 必须是相对 planDir 的安全路径（非空、非绝对、不含 ..）',
      })
      continue
    }
    try {
      const info = await stat(join(planDir, file))
      if (!info.isFile()) issues.push({ index, file, problem: '不是普通文件' })
      else if (info.size === 0) issues.push({ index, file, problem: '文件为空' })
    } catch {
      issues.push({ index, file, problem: '文件不存在（请先写入步骤 md 文件再提交）' })
    }
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues }
}
