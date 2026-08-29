/**
 * plan-and-execute 的 client half：submit_plan 步骤卡片（toolview）。
 * dsh 浏览器端模块系统加载；React 可用（种子词）。
 * @module plan-and-execute/client
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only：激活 client 侧 Context 合并（slots/remote/locale/connection）。
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-tool'

/** 插件名（与宿主 half 同名，供模块表路由）。 */
export const name = 'plan-and-execute'
/** 必需服务注入：槽位注册表与远程会话面。 */
export const inject = ['slots', 'locale', 'remote', 'remote.session', 'connection']

/** 客户端入口：目前仅日志（槽位注册见任务 6）。 */
export function apply(ctx: Context): void {
  console.log('[plan-and-execute:client] loaded')
  void ctx
}
