import type { Context } from '@deepseek-ai/cordis'

export const name = 'plan-and-execute'

export function apply(_ctx: Context): void {
  console.log('[plan-and-execute] plugin loaded')
}
