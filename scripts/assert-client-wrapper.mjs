/**
 * 构建后回归断言：lib/client/index.cjs 必须以 dsh ClientModuleSystem 契约形态存在——
 * window.__ModuleLoader__.load({id, factory}) 包装、id 为插件名、factory 以
 * return module.exports 收尾。任一断言不满足即 exit 1（防止 tsup banner/footer
 * 改动静默破坏客户端加载）。
 * @module scripts/assert-client-wrapper
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const file = resolve(import.meta.dirname, '../lib/client/index.cjs')
let text
try {
  text = await readFile(file, 'utf8')
} catch (error) {
  console.error(`[assert-client-wrapper] 读取 ${file} 失败：${error.message}`)
  process.exit(1)
}
// tsup 在 footer 之后追加 sourceMappingURL 注释：先剥掉再校验包装尾部。
const body = text.replace(/\n?\/\/# sourceMappingURL=[^\n]*$/m, '').replace(/\s+$/, '')
const checks = [
  ['以 window.__ModuleLoader__.load({ 开头', body.startsWith('window.__ModuleLoader__.load({')],
  ['包含 id: "plan-and-execute"', body.includes('id: "plan-and-execute"')],
  ['以 return module.exports; }); 收尾', /return module\.exports;\s*\}\s*\}\);?$/.test(body)],
]
// 运行时 require 只允许平台种子词：client 代码若值导入宿主模块（如 schemastery），
// tsup 会把 peerDeps 标 external 发出 require，浏览器模块表缺失即加载崩溃。
const seedWords = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
])
const requires = [...body.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1])
const strayRequires = [...new Set(requires.filter((spec) => !seedWords.has(spec)))]
if (strayRequires.length > 0) {
  console.error(
    `[assert-client-wrapper] FAIL：bundle 含非种子词运行时 require：${strayRequires.join(', ')}`,
  )
  console.error(
    '[assert-client-wrapper] client 代码值导入了宿主模块（tsup 将 peerDeps 标 external），' +
      '浏览器模块表缺失即崩。共享常量请放 state.ts 等无运行时依赖的模块，宿主依赖留在宿主侧。',
  )
  process.exit(1)
}
const failed = checks.filter(([, ok]) => !ok)
if (failed.length > 0) {
  for (const [name] of failed) console.error(`[assert-client-wrapper] FAIL：${name}`)
  console.error(
    '[assert-client-wrapper] lib/client/index.cjs 未满足 dsh 模块加载契约，请检查 tsup banner/footer 配置',
  )
  process.exit(1)
}
console.log('[assert-client-wrapper] OK：client bundle 包装契约完整')
