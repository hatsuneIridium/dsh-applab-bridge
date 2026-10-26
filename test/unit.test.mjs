// 本文件由 AI（DeepSeek Harness）生成，经人工审查后提交；说明见 README「代码来源与审查」。
// 单测：全是纯函数 + 进程层，不需要板子、不需要 DSH 宿主。
// 运行：node --test test/unit.test.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DEFAULTS, loadConfig, normalizeConfig, workspaceRoot } from '../lib/config.js'
import { parseDevices, pickDevice, resolveAdb, runProcess } from '../lib/adb.js'
import {
  buildCliCommand,
  isActiveStatus,
  newAppArgv,
  normalizeAppId,
  parseAppList,
  quoteArg,
  remoteAppPath,
  shQuote,
  userAppName,
  validateAppName,
} from '../lib/commands.js'

test('shQuote 处理单引号', () => {
  assert.equal(shQuote('abc'), "'abc'")
  assert.equal(shQuote("it's"), "'it'\\''s'")
})

test('quoteArg 只给需要的参数加引号', () => {
  assert.equal(quoteArg('user:my-app'), 'user:my-app')
  assert.equal(quoteArg('My App'), "'My App'")
  assert.equal(quoteArg('a;rm -rf /'), "'a;rm -rf /'")
})

test('buildCliCommand 拼出可读命令', () => {
  assert.equal(
    buildCliCommand(['app', 'start', 'user:my-app']),
    'arduino-app-cli app start user:my-app',
  )
})

test('parseAppList 解析 0.13 的 app list 表格', () => {
  const text = [
    'ID                                                                                             NAME                                                     ICON STATUS        EXAMPLE ',
    'user:test                                                                                      Test                                                     🇨🇳   stopped       false   ',
    'examples:inspirational/blink                                                                   Blink LED from Python                                    🔴   uninitialized true    ',
    'user:running-app                                                                               Running App                                              💡   running       false   ',
    '',
  ].join('\n')
  const rows = parseAppList(text)
  assert.equal(rows.length, 3)
  assert.deepEqual(rows[0], {
    id: 'user:test', name: 'Test', icon: '🇨🇳', status: 'stopped', example: false, active: false,
  })
  assert.equal(rows[2].active, true)
  assert.equal(rows[2].status, 'running')
  assert.equal(isActiveStatus('failed'), true)
  assert.equal(isActiveStatus('uninitialized'), false)
  assert.deepEqual(parseAppList(''), [])
})

test('validateAppName 接受常见名字、拒绝危险字符', () => {
  assert.equal(validateAppName('My Blink App').value, 'My Blink App')
  assert.equal(validateAppName('blink2.0').value, 'blink2.0')
  for (const bad of ['', '   ', '-leading', 'a/b', 'a;b', 'x'.repeat(65), 'trail.']) {
    assert.ok(validateAppName(bad).error, `应当拒绝 ${JSON.stringify(bad)}`)
  }
})

test('normalizeAppId 补 user: 前缀并校验', () => {
  assert.equal(normalizeAppId('blink').value, 'user:blink')
  assert.equal(normalizeAppId('user:blink').value, 'user:blink')
  assert.equal(normalizeAppId('examples:inspirational/blink').value, 'examples:inspirational/blink')
  assert.ok(normalizeAppId('user:').error)
  assert.ok(normalizeAppId('weird:blink').error)
})

test('userAppName / remoteAppPath 只接受 user: 的扁平名字', () => {
  assert.equal(userAppName('user:blink'), 'blink')
  assert.equal(userAppName('examples:x/y'), null)
  assert.equal(remoteAppPath('/home/arduino/ArduinoApps/', 'user:blink'), '/home/arduino/ArduinoApps/blink')
  assert.equal(remoteAppPath('/home/arduino/ArduinoApps', 'examples:x'), null)
})

test('newAppArgv 组装参数', () => {
  assert.deepEqual(newAppArgv('Demo'), ['app', 'new', 'Demo'])
  assert.deepEqual(
    newAppArgv('Demo', { fromApp: 'examples:inspirational/blink', bricks: ['arduino:web_ui'], noSketch: true }),
    ['app', 'new', 'Demo', '--from-app', 'examples:inspirational/blink', '--bricks', 'arduino:web_ui', '--no-sketch'],
  )
  assert.deepEqual(
    newAppArgv('Demo', { description: 'hi', icon: '💡' }),
    ['app', 'new', 'Demo', '--description', 'hi', '--icon', '💡'],
  )
})

test('parseDevices 解析 adb devices -l', () => {
  const out = [
    'List of devices attached',
    'ABC123\tdevice product:unoq model:Arduino_UNO_Q device:unoq transport_id:1',
    'XYZ\tunauthorized usb:1-1 transport_id:2',
    '',
  ].join('\n')
  const devices = parseDevices(out)
  assert.equal(devices.length, 2)
  assert.deepEqual(devices[0], { serial: 'ABC123', state: 'device', model: 'Arduino_UNO_Q' })
  assert.equal(devices[1].state, 'unauthorized')
})

test('pickDevice 优先配置、唯一设备、多设备报错', () => {
  const one = [{ serial: 'A', state: 'device' }]
  assert.deepEqual(pickDevice(one, ''), { serial: 'A' })
  assert.deepEqual(pickDevice([...one, { serial: 'B', state: 'device' }], 'B'), { serial: 'B' })
  assert.ok(pickDevice([...one, { serial: 'B', state: 'device' }], '').error)
  assert.ok(pickDevice([], '').error)
  assert.ok(pickDevice([{ serial: 'A', state: 'unauthorized' }], 'A').error)
})

test('resolveAdb 用配置里的绝对路径', () => {
  const adb = resolveAdb({ adbPath: process.execPath }, { PATH: '' })
  assert.equal(adb.path, process.execPath)
  assert.equal(adb.source, 'config')
})

test('runProcess 收集输出并支持超时', async () => {
  const ok = await runProcess({ file: process.execPath, args: ['-e', 'console.log("hi")'], timeoutMs: 10000 })
  assert.equal(ok.code, 0)
  assert.equal(ok.stdout.trim(), 'hi')
  assert.equal(ok.timedOut, false)

  const slow = await runProcess({ file: process.execPath, args: ['-e', 'setTimeout(()=>{}, 10000)'], timeoutMs: 800 })
  assert.equal(slow.timedOut, true)
})

test('loadConfig 首次写默认值、坏 JSON 退回默认并告警', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-applab-bridge-'))
  try {
    const first = loadConfig({ DSH_HOME: home })
    assert.equal(first.created, true)
    assert.equal(first.config.timeoutMs, DEFAULTS.timeoutMs)
    const written = JSON.parse(readFileSync(first.path, 'utf8'))
    assert.equal(written.appRoot, DEFAULTS.appRoot)

    writeFileSync(first.path, '{ not json')
    const broken = loadConfig({ DSH_HOME: home })
    assert.ok(broken.warning)
    assert.equal(broken.config.appRoot, DEFAULTS.appRoot)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('normalizeConfig 夹取数值并补全 appRoot', () => {
  const cfg = normalizeConfig({ timeoutMs: 5, logTimeoutMs: 999999, appRoot: 'home/x' })
  assert.equal(cfg.timeoutMs, 1000)
  assert.equal(cfg.logTimeoutMs, 60000)
  assert.equal(cfg.appRoot, '/home/x')
})

test('workspaceRoot 优先配置，否则落在 DSH_HOME 下', () => {
  assert.equal(workspaceRoot({ workspace: 'D:/ws' }), 'D:/ws')
  assert.equal(
    workspaceRoot({ workspace: '' }, { DSH_HOME: 'D:/dsh-home' }),
    join('D:/dsh-home', 'dsh-applab-bridge', 'workspaces'),
  )
})
