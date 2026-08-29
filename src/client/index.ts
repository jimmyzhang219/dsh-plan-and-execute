/**
 * plan-and-execute 的 client half：submit_plan 步骤卡片（toolview）。
 * dsh 浏览器端模块系统加载；React 可用（种子词）。
 * @module plan-and-execute/client
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// Type-only：激活 client 侧 Context 合并（slots/remote/locale/connection）。
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import { en, NS, zh } from './locale.ts'
import { SubmitPlanCardView, type SubmitPlanCardInjected } from './PlanCard.tsx'

/** 插件名（与宿主 half 同名，供模块表路由）。 */
export const name = 'plan-and-execute'
/** 必需服务注入：槽位注册表、文案字典、远程会话面与连接面。 */
export const inject = ['slots', 'locale', 'remote', 'remote.session', 'connection']

/** 客户端入口：注册字典与 submit_plan toolview 槽位。 */
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
}
