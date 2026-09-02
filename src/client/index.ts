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
import './styles.ts' // 副作用：按 claimStyles 契约注入审批卡样式（模块顶层执行）
import { isPlanReviewPending } from './review-card.ts'
import { PaeReviewCardView, type PaeReviewCardInjected } from './PaeReviewCard.tsx'

/** 插件名（与宿主 half 同名，供模块表路由）。 */
export const name = 'dsh-plan-and-execute'
/**
 * 必需服务注入：槽位注册表、文案字典、远程基面与连接面。
 * 注意 remote.session/remote.settings 不在其中——它们仅 alpha.1+ 提供，rc.2 缺失，
 * 列入 inject 会让 entry 永久 pending、web 启动失败（assertEntriesActive 抛错）。
 * 二者的取用延迟到 slot 渲染期（见 apply 的 rc.2 兼容说明）。
 */
export const inject = ['slots', 'locale', 'remote', 'connection']

/** 客户端入口：注册字典与 plan-review 审批卡 composer。 */
export function apply(ctx: Context): void {
  const connection = ctx.get('connection') as ConnectionHandle
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-plan-and-execute: dictionaries')
  // rc.2 兼容：remote.session/remote.settings 不能进模块 inject（rc.2 缺失 →
  // entry 永久 pending、web 启动失败），且 cordis 属性访问（ctx.remote.session）
  // 要求服务在当前 fiber 的 inject 中声明——两难之下用 ctx.inject 子 fiber 包住
  // 注册：alpha.x 下等两服务就绪才注册（与 0.3.0 激活时序一致，属性访问合法）；
  // rc.2 下服务永不就绪、注册永不发生（子 fiber 无 loader entry，不影响 boot 的
  // entries 激活检查），plan-review 审批由内置 PlanReviewPanel 接管（host 提问
  // 协议不变）。
  ctx.inject(['remote.session', 'remote.settings'], (scope) => {
    // plan-review 审批卡替换：priority -1 先于宿主 question composer 判定，
    // 结构命中（kind==='plan-review' 且具备 answer/cancel/questions）即接管
    scope.slots.inject('conversation.composer', () =>
      scope.slots.register(
        {
          name: 'conversation.composer',
          priority: -1,
          select: ({ pendingInteraction }: { pendingInteraction: unknown }) =>
            isPlanReviewPending(pendingInteraction) ? pendingInteraction : null,
          locale: NS,
          inject: (): PaeReviewCardInjected => ({
            sessionRemote: scope.remote.session,
            settingsRemote: scope.remote.settings,
            connection,
          }),
        },
        PaeReviewCardView,
      ),
    )
  })
}
