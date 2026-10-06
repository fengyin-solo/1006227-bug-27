// 验证脚本运行器：Node 20 不能直接执行 TS，这里用项目自带的 esbuild 打包后立即运行。
// 用法：npm run verify:overhaul
import { build } from 'esbuild'
import { rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(fileURLToPath(import.meta.url))
const outfile = path.join(root, '..', 'node_modules', '.tmp-verify-overhaul.mjs')

await build({
  entryPoints: [path.join(root, 'verify-overhaul.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
})

try {
  await import(outfile)
} finally {
  await rm(outfile, { force: true })
}
