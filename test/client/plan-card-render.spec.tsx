// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PlanCard } from '../../src/client/PlanCard.tsx'
import type { CardArgs, ModelOption } from '../../src/client/plan-card.ts'

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
const options: ModelOption[] = [
  {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    label: 'deepseek-official · deepseek-v4-flash',
  },
  {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    label: 'deepseek-official · deepseek-v4-pro',
  },
]
const current = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }

const base = {
  args,
  canOpen: true,
  options,
  current,
  openFile: vi.fn(),
  onSubmit: vi.fn(async () => {}),
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

  it('下拉默认 = 当前会话模型', () => {
    render(<PlanCard {...base} />)
    const selects = screen.getAllByRole('combobox')
    expect(selects).toHaveLength(2)
    expect((selects[0] as HTMLSelectElement).value).toBe('deepseek-official|deepseek-v4-flash')
  })

  it('修改下拉并点「应用模型」→ onSubmit 收到 {步骤号: {provider, model}}', async () => {
    render(<PlanCard {...base} />)
    fireEvent.change(screen.getAllByRole('combobox')[0]!, {
      target: { value: 'deepseek-official|deepseek-v4-pro' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'applyModels' }))
    await vi.waitFor(() => {
      expect(base.onSubmit).toHaveBeenCalledWith({
        1: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
        2: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      })
    })
  })

  it('未修改时「应用模型」禁用', () => {
    render(<PlanCard {...base} />)
    expect(
      (screen.getByRole('button', { name: 'applyModels' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })
})
