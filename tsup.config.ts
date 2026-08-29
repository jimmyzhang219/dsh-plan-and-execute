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
    entry: ['src/client/index.ts'],
    format: ['cjs'],
    target: 'es2024',
    platform: 'browser',
    outDir: 'lib/client',
    dts: true,
    sourcemap: true,
    clean: false,
    external: CLIENT_EXTERNALS,
  },
])
