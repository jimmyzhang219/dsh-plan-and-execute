/**
 * dsh-plan-and-execute 的 client half：plan-review 审批卡替换（composer）。
 * dsh 浏览器端模块系统加载；React 可用（种子词）。
 * 注：submit_plan toolview 自定义卡片已于 2026-08-30 移除（功能收敛到审批卡，
 * 会话流恢复 dsh 默认消息流渲染）。
 * @module dsh-plan-and-execute/client
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// Type-only：激活 client 侧 Context 合并（slots/remote/locale/connection/composer 槽位）。
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { en, NS, zh } from './locale.ts'
import { createChannelsWriter } from './channels.ts'
import { allowSessionPing } from './ping.ts'
import './styles.ts' // 副作用：按 claimStyles 契约注入审批卡样式（模块顶层执行）
import { isPlanReviewPending } from './review-card.ts'
import { PaeReviewCardView, type PaeReviewCardInjected } from './PaeReviewCard.tsx'

/** 插件名（与宿主 half 同名，供模块表路由）。 */
export const name = 'dsh-plan-and-execute'
/** 必需服务注入：槽位注册表、文案字典、远程会话/设置面与连接面。 */
export const inject = [
  'slots',
  'locale',
  'remote',
  'remote.session',
  'remote.settings',
  'connection',
]

/** 客户端入口：注册字典与 plan-review 审批卡 composer。 */
export function apply(ctx: Context): void {
  const connection = ctx.get('connection') as ConnectionHandle
  // 静默通道写入器（每步模型 + 会话查看脉冲）：条目 id 惰性发现后复用，全局一份。
  const channels = createChannelsWriter(ctx.remote.settings)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-plan-and-execute: dictionaries')
  // plan-review 审批卡替换：priority -1 先于宿主 question composer 判定，
  // 结构命中（kind==='plan-review' 且具备 answer/cancel/questions）即接管
  ctx.slots.inject('conversation.composer', () =>
    ctx.slots.register(
      {
        name: 'conversation.composer',
        priority: -1,
        select: ({
          sessionId,
          pendingInteraction,
        }: {
          sessionId?: string
          pendingInteraction: unknown
        }) => {
          const sid = sessionId ?? ''
          // 会话打开信号：本卡无持久化状态通道，宿主靠脉冲得知「会话正被查看」，
          // 以便 scheduled 等待期重弹回显卡。select 每次链求值都执行（含无 pending），
          // 限频防同一会话持续渲染风暴（空闲无渲染则天然不重发）。
          if (sid !== '' && allowSessionPing(sid, Date.now())) {
            void channels.writePing(sid, Date.now()).catch(() => {
              // 装配/连接故障：静默（缺信号仅失去自动重弹，不阻塞其他功能）
            })
          }
          return isPlanReviewPending(pendingInteraction) ? pendingInteraction : null
        },
        locale: NS,
        inject: (): PaeReviewCardInjected => ({
          sessionRemote: ctx.remote.session,
          channels,
          connection,
        }),
      },
      PaeReviewCardView,
    ),
  )
}
