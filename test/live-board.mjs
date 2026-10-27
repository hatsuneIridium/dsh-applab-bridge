// 真机只读自检：用插件自己的工具层跑一遍，不需要 DSH 宿主。
//
//   node --test 之外的独立脚本；先按 README 放好 @deepseek-ai/dsh-tools 桩：
//     node_modules/@deepseek-ai/dsh-tools/index.js -> export const defineTool = (d) => d
//
//   node test/live-board.mjs
//
// 需要板子 USB 在线。不会创建/启动/停止任何 App。

import assert from 'node:assert/strict'
import plugin from '../index.js'

const tools = new Map()
plugin.apply({
  tools: { register: (definition) => (tools.set(definition.name, definition), () => tools.delete(definition.name)) },
  effect: () => {},
})
const call = (name, args = {}) => tools.get(name).execute(args, {})

const doctor = await call('applab_doctor')
assert.equal(doctor.ok, true, `doctor 失败: ${doctor.error || ''}`)
assert.match(String(doctor.board.cliVersion), /\d+\.\d+\.\d+/, `CLI 版本异常: ${doctor.board.cliVersion}`)
console.log('doctor      ok  cli=%s serial=%s', doctor.board.cliVersion, doctor.board.serial)

const status = await call('applab_status')
assert.equal(status.ok, true, `status 失败: ${status.error || status.hint || ''}`)
assert.ok(status.totalApps > 0, 'status 没有返回任何 App')
console.log('status      ok  total=%d active=%d format=%s', status.totalApps, status.activeCount, status.appListFormat)

const list = await call('applab_apps_list')
assert.equal(list.ok, true, `apps_list 失败: ${list.error || list.hint || ''}`)
assert.ok(list.total > 0 && Array.isArray(list.apps), 'apps_list 没有返回结构化列表')
assert.ok(list.apps.every((app) => /^(user|examples|release):/.test(app.id)), 'apps_list 的 id 没解码')
console.log('apps_list   ok  total=%d first=%s', list.total, list.apps[0].id)

const bricks = await call('applab_bricks_list')
assert.equal(bricks.ok, true, `bricks_list 失败: ${bricks.error || bricks.hint || ''}`)
assert.match(String(bricks.output), /arduino:/, 'brick 列表里没有 arduino: 前缀的 Brick')
console.log('bricks_list ok  bytes=%d', String(bricks.output).length)

const models = await call('applab_models_list')
assert.ok(String(models.output || '').length > 0, 'model list 没拿到任何输出')
console.log('models_list ok  timedOut=%s bytes=%d', Boolean(models.timedOut), String(models.output).length)

const userApp = list.apps.find((app) => app.id.startsWith('user:'))
if (userApp) {
  const details = await call('applab_app_details', { id: userApp.id })
  assert.equal(details.ok, true, `details 失败: ${details.error || details.hint || ''}`)
  const hasYaml = typeof details.appYaml === 'string' && details.appYaml.length > 0
  const hasText = typeof details.output === 'string' && details.output.length > 0
  assert.ok(hasYaml || hasText, 'details 既没有 app.yaml 也没有 CLI 输出')
  console.log('details     ok  id=%s source=%s', userApp.id, hasYaml ? 'app.yaml' : 'cli')
} else {
  console.log('details     skip（没有 user: App）')
}

console.log('\nall live checks passed')
