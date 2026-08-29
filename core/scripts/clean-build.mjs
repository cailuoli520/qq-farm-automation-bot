import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const buildDir = path.resolve(scriptDir, '..', 'build')
const cacheDir = path.resolve(scriptDir, '..', 'node_modules', '.cache')

fs.rmSync(buildDir, { recursive: true, force: true })
// 输出目录被删除后，旧增量信息不能继续声明这些文件已经生成。
fs.rmSync(path.join(cacheDir, 'tsconfig.core.tsbuildinfo'), { force: true })
fs.rmSync(path.join(cacheDir, 'tsconfig.test.tsbuildinfo'), { force: true })
