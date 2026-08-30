/**
 * plan-and-execute 的 client half：submit_plan 步骤卡片（toolview）。
 * dsh 浏览器端模块系统加载；React 可用（种子词）。
 * @module plan-and-execute/client
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// Type-only：激活 client 侧 Context 合并（slots/remote/locale/connection/composer 槽位）。
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { en, NS, zh } from './locale.ts'
import { SubmitPlanCardView, type SubmitPlanCardInjected } from './PlanCard.tsx'
import { isPlanReviewPending } from './review-card.ts'
import { PaeReviewCardView, type PaeReviewCardInjected } from './PaeReviewCard.tsx'

/** 插件名（与宿主 half 同名，供模块表路由）。 */
export const name = 'plan-and-execute'
/** 必需服务注入：槽位注册表、文案字典、远程会话/设置面与连接面。 */
export const inject = [
  'slots',
  'locale',
  'remote',
  'remote.session',
  'remote.settings',
  'connection',
]

/** 客户端入口：注册字典、submit_plan toolview 槽位与 plan-review 审批卡 composer。 */
export function apply(ctx: Context): void {
  const connection = ctx.get('connection') as ConnectionHandle
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'plan-and-execute: dictionaries')
  ctx.slots.inject('tool.call.toolview', () =>
    ctx.slots.register(
      {
        name: 'tool.call.toolview',
        key: 'submit_plan',
        locale: NS,
        inject: (): SubmitPlanCardInjected => ({
          sessionRemote: ctx.remote.session,
          connection,
        }),
      },
      SubmitPlanCardView,
    ),
  )
  // plan-review 审批卡替换：priority -1 先于宿主 question composer 判定，
  // 结构命中（kind==='plan-review' 且具备 answer/cancel/questions）即接管
  ctx.slots.inject('conversation.composer', () =>
    ctx.slots.register(
      {
        name: 'conversation.composer',
        priority: -1,
        select: ({ pendingInteraction }: { pendingInteraction: unknown }) =>
          isPlanReviewPending(pendingInteraction) ? pendingInteraction : null,
        locale: NS,
        inject: (): PaeReviewCardInjected => ({
          sessionRemote: ctx.remote.session,
          settingsRemote: ctx.remote.settings,
          connection,
        }),
      },
      PaeReviewCardView,
    ),
  )
}
