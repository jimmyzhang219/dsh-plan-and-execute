// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PlanCard } from '../../src/client/PlanCard.tsx'
import type { CardArgs } from '../../src/client/plan-card.ts'

// vitest 未开 globals，@testing-library/react 的自动 cleanup 不会挂载：显式清理避免跨用例 DOM 累积。
afterEach(cleanup)

const args: CardArgs = {
  planDir: '.pae/sess-1',
  summary: '测试计划',
  steps: [
    { file: 'a.md', title: '步骤 A' },
    { file: 'b.md', title: '步骤 B', requiresConfirmation: true },
  ],
}

const base = {
  args,
  canOpen: true,
  openFile: vi.fn(),
  t: (key: string) => key,
}

describe('PlanCard', () => {
  it('canOpen 时点「打开目录」调 openFile(planDir)', () => {
    render(<PlanCard {...base} />)
    fireEvent.click(screen.getByRole('button', { name: 'openDir' }))
    expect(base.openFile).toHaveBeenCalledWith('.pae/sess-1')
  })

  it('每步「打开文件」调 openFile(planDir/file)', () => {
    render(<PlanCard {...base} />)
    const buttons = screen.getAllByRole('button', { name: 'openFile' })
    fireEvent.click(buttons[1]!)
    expect(base.openFile).toHaveBeenCalledWith('.pae/sess-1/b.md')
  })

  it('canOpen=false → 不渲染打开按钮，显示路径文本', () => {
    render(<PlanCard {...base} canOpen={false} />)
    expect(screen.queryByRole('button', { name: 'openDir' })).toBeNull()
    expect(screen.getByText('.pae/sess-1')).toBeTruthy()
  })

  it('简化后：无下拉与应用按钮（模型选择唯一入口 = 审批卡）', () => {
    render(<PlanCard {...base} />)
    expect(screen.queryAllByRole('combobox')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: 'applyModels' })).toBeNull()
  })
})
