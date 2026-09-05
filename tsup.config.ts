import { defineConfig } from 'tsup'

/** 浏览器端种子词（dsh ClientModuleSystem 运行时提供，绝不打包）。 */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    target: 'es2024',
    platform: 'node',
    outDir: 'lib',
    dts: true,
    sourcemap: true,
    clean: true,
    // @deepseek-ai/* 是 peerDependencies，tsup 默认不打包，
    // 运行时由 dsh 进程提供唯一实例（不要把它们打进来）。
  },
  {
    // 产出文件名必须是 client.js：dsh 宿主固定以 /plugins/<id>/client.js(.map) 路由
    // serve 原始字节，文件名若为 index.cjs，浏览器会按脚本 URL 基名解析出
    // /plugins/<id>/index.cjs.map → 404。
    // 对象形式 entry 控制 chunk 名 + outExtension 强制 .js（type:module 下 cjs 默认 .cjs）。
    entry: { client: 'src/client/index.ts' },
    format: ['cjs'],
    target: 'es2024',
    platform: 'browser',
    outDir: 'lib/client',
    dts: true,
    sourcemap: true,
    clean: false,
    external: CLIENT_EXTERNALS,
    // 第三方 UI 依赖须打进 bundle：tsup 默认把 package.json 的 dependencies 也标
    // external（浏览器模块表缺失即崩，assert-client-wrapper 断言非种子词 require 为零）。
    noExternal: ['react-day-picker'],
    outExtension: () => ({ js: '.js' }),
    // dsh client 模块系统契约：包自身调用 window.__ModuleLoader__.load({id, factory})
    // 注册（宿主只 serve 原始字节，不注入包装；对齐 dsh 官方 tsdown.client.ts banner）。
    // factory 的 require 参数解析 externals（loader 模块表），返回 module.exports 完成 materialize。
    banner: {
      js: [
        'window.__ModuleLoader__.load({',
        '\tid: "dsh-plan-and-execute",',
        '\tfactory: (require) => {',
        '\t\tvar module = { exports: {} };',
        '\t\tvar exports = module.exports;',
        '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
      ].join('\n'),
    },
    footer: {
      js: '\t\treturn module.exports;\n\t}\n});',
    },
  },
])
