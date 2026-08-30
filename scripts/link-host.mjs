#!/usr/bin/env node
/**
 * 把 dsh checkout 里的 @deepseek-ai/* 宿主包软链到本工程 node_modules，
 * 保证插件与宿主共享同一包实例（否则出现两个 cordis 实例，插件失效）。
 * 用法：node scripts/link-host.mjs [--remove]；DSH_ROOT 可覆盖默认路径。
 */
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dshRoot = resolve(
  process.env.DSH_ROOT ?? join(process.env.HOME ?? '', 'git', 'deepseek-harness'),
)

const HOST_PACKAGES = {
  '@deepseek-ai/cordis': 'vendor/cordis',
  '@deepseek-ai/schemastery': 'vendor/schemastery',
  '@deepseek-ai/dsh-agent': 'packages/core/agent',
  '@deepseek-ai/dsh-commands': 'packages/interaction/commands',
  '@deepseek-ai/dsh-llm': 'packages/llm/llm',
  '@deepseek-ai/dsh-session': 'packages/core/session',
  '@deepseek-ai/dsh-session-title': 'packages/session/session-title',
  '@deepseek-ai/dsh-settings': 'packages/settings/settings',
  '@deepseek-ai/dsh-system-prompt': 'packages/core/system-prompt',
  '@deepseek-ai/dsh-tool-todo': 'packages/todo/tool-todo',
  '@deepseek-ai/dsh-tools': 'packages/core/tools',
  '@deepseek-ai/dsh-user-questions': 'packages/interaction/user-questions',
  '@deepseek-ai/dsh-client-connection': 'packages/client/connection',
  '@deepseek-ai/dsh-client-locale': 'packages/client/locale',
  '@deepseek-ai/dsh-client-ui-renderer': 'packages/client/ui-renderer',
  '@deepseek-ai/dsh-client-ui-session': 'packages/client/ui-session',
  '@deepseek-ai/dsh-client-ui-slots': 'packages/client/ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives': 'packages/client/ui-primitives',
  '@deepseek-ai/dsh-client-ui-tool': 'packages/client/ui-tool',
  // conversation.composer 槽位契约与 useChat 标准钩子：审批卡注册/消费所需
  '@deepseek-ai/dsh-client-ui-chat': 'packages/client/ui-chat',
  '@deepseek-ai/dsh-client-ui-conversation': 'packages/client/ui-conversation',
  '@deepseek-ai/dsh-api-remotes': 'packages/api/remotes',
}

const remove = process.argv.includes('--remove')
const scopeDir = join(projectRoot, 'node_modules', '@deepseek-ai')

if (!remove && !existsSync(dshRoot)) {
  console.error(
    `[link-host] dsh checkout not found: ${dshRoot}\n[link-host] set DSH_ROOT or re-run after pnpm install inside the dsh repo.`,
  )
  process.exit(0)
}

mkdirSync(scopeDir, { recursive: true })

let failures = 0
for (const [pkg, rel] of Object.entries(HOST_PACKAGES)) {
  const linkPath = join(scopeDir, pkg.split('/')[1] ?? pkg)
  let existing = null
  try {
    existing = lstatSync(linkPath)
  } catch {
    /* 不存在 */
  }
  if (existing?.isSymbolicLink() || existing?.isFile()) rmSync(linkPath, { force: true })
  else if (existing?.isDirectory()) {
    console.error(`[link-host] refusing to replace real directory: ${linkPath}`)
    failures += 1
    continue
  }
  if (remove) {
    console.log(`[link-host] removed ${pkg}`)
    continue
  }
  const target = join(dshRoot, rel)
  if (!existsSync(join(target, 'package.json'))) {
    console.error(`[link-host] ${target} is not a package — is DSH_ROOT a dsh checkout?`)
    failures += 1
    continue
  }
  symlinkSync(target, linkPath, 'dir')
  console.log(`[link-host] ${pkg} -> ${target}`)
}
if (failures > 0) process.exit(1)
