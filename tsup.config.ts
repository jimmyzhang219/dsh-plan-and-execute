import { defineConfig } from 'tsup'

export default defineConfig({
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
})
