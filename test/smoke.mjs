// 本文件由 AI（DeepSeek Harness）生成，经人工审查后提交；说明见 README「代码来源与审查」。
// 不依赖 DSH 宿主的冒烟测试：用桩替身验证插件形状（inject/apply/工具注册/释放）
// 和几个不需要板子的错误路径。运行：node test/smoke.mjs
// 注意：只在临时 node_modules 桩存在时可用（见 README 的“开发”一节）。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import plugin from '../index.js'

const home = mkdtempSync(join(tmpdir(), 'applab-smoke-'))
process.env.DSH_HOME = home

const tools = new Map()
const cleanups = []
plugin.apply({
  tools: {
    register: (def) => {
      tools.set(def.name, def)
      return () => tools.delete(def.name)
    },
  },
  effect: (fn) => cleanups.push(fn()),
})

const expected = [
  'applab_doctor',
  'applab_status',
  'applab_apps_list',
  'applab_app_details',
  'applab_app_create',
  'applab_app_start',
  'applab_app_stop',
  'applab_app_restart',
  'applab_app_logs',
  'applab_app_pull',
  'applab_app_push',
  'applab_shell',
  'applab_bricks_list',
  'applab_models_list',
]
for (const name of expected) {
  if (!tools.has(name)) throw new Error(`缺少工具：${name}`)
}
console.log(`tools: ${tools.size}`)

const call = (name, args = {}) => tools.get(name).execute(args, {})

const invalidId = await call('applab_app_details', { id: 'user:' })
if (invalidId.ok !== false || !invalidId.error) throw new Error('非法 id 应当被拒绝')
console.log('invalid id rejected')

const pullExample = await call('applab_app_pull', { id: 'examples:inspirational/blink' })
if (pullExample.ok !== false || !/user:/.test(pullExample.error)) throw new Error('示例 App 不应允许 pull')
console.log('read-only example rejected')

const badName = await call('applab_app_create', { name: 'a;b' })
if (badName.ok !== false) throw new Error('危险 App 名应当被拒绝')
console.log('bad app name rejected')

// doctor 会真的探测 adb；没插板子时应给出可执行提示，而不是抛栈。
const doctor = await call('applab_doctor')
if (typeof doctor.ok !== 'boolean') throw new Error('doctor 未返回 ok')
if (!doctor.ok && !doctor.hint) throw new Error('doctor 失败时必须给出 hint')
console.log(`doctor ok=${doctor.ok} adb=${doctor.adbPath || '-'} devices=${(doctor.devices || []).length}`)

for (const cleanup of cleanups.reverse()) cleanup()
if (tools.size !== 0) throw new Error(`释放后仍有 ${tools.size} 个工具`)
console.log('dispose ok')

rmSync(home, { recursive: true, force: true })
console.log('smoke passed')
