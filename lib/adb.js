// 本文件由 AI（DeepSeek Harness）生成，经人工审查后提交；说明见 README「代码来源与审查」。
// adb 层：定位 adb、执行进程、枚举设备。所有板子操作最终都从这里走。
// 不依赖任何 npm 包，只用 Node 内置模块，因此插件可以直接从本地目录安装。
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const DEVICE_BIN = process.platform === 'win32' ? 'adb.exe' : 'adb'

/** 进程输出上限，避免一次 logs --follow 把内存撑爆或把结果灌进模型上下文。 */
export const MAX_OUTPUT_CHARS = 200_000

/**
 * 运行一个进程，收集 stdout/stderr，超时杀掉。
 * 不抛错：把退出码、是否超时都放进返回值，由调用方决定怎么呈现。
 */
export function runProcess({ file, args = [], timeoutMs = 120000, cwd, env }) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(file, args, {
        cwd,
        env: env || process.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err && err.message ? err.message : err), timedOut: false, spawnError: true })
      return
    }
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const trim = (s) => (s.length > MAX_OUTPUT_CHARS ? s.slice(-MAX_OUTPUT_CHARS) : s)
    const finish = (code, extra) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout: trim(stdout), stderr: trim(stderr), timedOut, ...extra })
    }
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGKILL')
      } catch {
        /* 已经退出 */
      }
    }, Math.max(500, timeoutMs))
    child.stdout?.on('data', (buf) => {
      stdout += buf.toString('utf8')
      if (stdout.length > MAX_OUTPUT_CHARS * 2) stdout = stdout.slice(-MAX_OUTPUT_CHARS)
    })
    child.stderr?.on('data', (buf) => {
      stderr += buf.toString('utf8')
      if (stderr.length > MAX_OUTPUT_CHARS * 2) stderr = stderr.slice(-MAX_OUTPUT_CHARS)
    })
    child.on('error', (err) => finish(-1, { spawnError: true, stderr: String(err && err.message ? err.message : err) }))
    child.on('close', (code) => finish(typeof code === 'number' ? code : -1))
  })
}

/** 在 PATH 里找可执行文件。 */
export function findOnPath(bin, env = process.env) {
  const pathVar = env.PATH || env.Path || ''
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat'] : ['']
  for (const dir of pathVar.split(process.platform === 'win32' ? ';' : ':')) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = join(dir, bin + ext)
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
      } catch {
        /* 忽略不可访问的目录 */
      }
    }
  }
  return ''
}

/**
 * Arduino App Lab 自带的 adb（Windows/macOS/Linux 都在 AppLab 数据目录下）。
 * App Lab 把 arduino:tools:adb 装在 <data>/packages/arduino/tools/adb/<version>/。
 */
export function appLabAdbCandidates(env = process.env) {
  const out = []
  const roots = []
  if (process.platform === 'win32') {
    if (env.LOCALAPPDATA) roots.push(join(env.LOCALAPPDATA, 'AppLab'), join(env.LOCALAPPDATA, 'arduino-app-lab'))
  } else if (process.platform === 'darwin') {
    roots.push(join(env.HOME || '', 'Library', 'Application Support', 'AppLab'))
  } else {
    if (env.XDG_DATA_HOME) roots.push(join(env.XDG_DATA_HOME, 'AppLab'))
    if (env.HOME) roots.push(join(env.HOME, '.local', 'share', 'AppLab'))
  }
  for (const root of roots) {
    const base = join(root, 'a15', 'data', 'packages', 'arduino', 'tools', 'adb')
    let versions = []
    try {
      versions = readdirSync(base)
    } catch {
      continue
    }
    for (const version of versions) out.push(join(base, version, DEVICE_BIN))
  }
  return out
}

/**
 * 定位 adb。顺序：配置 → PATH → App Lab 自带。
 * @returns {{ path: string, source: 'config'|'path'|'applab'|'' }}
 */
export function resolveAdb(config = {}, env = process.env) {
  const configured = typeof config.adbPath === 'string' ? config.adbPath.trim() : ''
  if (configured) {
    try {
      if (existsSync(configured) && statSync(configured).isFile()) return { path: configured, source: 'config' }
    } catch {
      /* 落回自动查找 */
    }
  }
  const onPath = findOnPath('adb', env)
  if (onPath) return { path: onPath, source: 'path' }
  for (const candidate of appLabAdbCandidates(env)) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return { path: candidate, source: 'applab' }
    } catch {
      /* 继续找 */
    }
  }
  return { path: '', source: '' }
}

/** 解析 `adb devices -l`。 */
export function parseDevices(output) {
  const devices = []
  for (const line of String(output || '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('List of devices') || trimmed.startsWith('*')) continue
    const parts = trimmed.split(/\s+/)
    if (parts.length < 2) continue
    const [serial, state] = parts
    if (!serial || !state) continue
    const detail = trimmed.slice(serial.length + state.length).trim()
    const model = /model:(\S+)/.exec(detail)
    devices.push({ serial, state, model: model ? model[1] : '' })
  }
  return devices
}

/**
 * 选择目标设备：优先配置的 serial，否则唯一在线设备。
 * @returns {{ serial: string } | { error: string, devices: Array }}
 */
export function pickDevice(devices, preferred) {
  const online = devices.filter((d) => d.state === 'device')
  if (preferred) {
    const hit = online.find((d) => d.serial === preferred)
    if (hit) return { serial: hit.serial }
    const known = devices.find((d) => d.serial === preferred)
    if (known) return { error: `设备 ${preferred} 当前状态是 ${known.state}（不是 device），请检查 USB 授权或重新插拔。`, devices }
    return { error: `配置的 serial=${preferred} 不在线。当前设备：${describeDevices(devices)}`, devices }
  }
  if (online.length === 1) return { serial: online[0].serial }
  if (online.length === 0) {
    return { error: '没有在线的 adb 设备。请用 USB 连接 UNO Q / VENTUNO Q，并在板子上允许 USB 调试；App Lab 的 Connected Mode 也需要它。', devices }
  }
  return { error: `检测到多台在线设备，请在 $DSH_HOME/dsh-applab-bridge/config.json 里设置 serial。当前：${describeDevices(devices)}`, devices }
}

export function describeDevices(devices) {
  if (!devices || devices.length === 0) return '（无）'
  return devices.map((d) => `${d.serial}(${d.state}${d.model ? ',' + d.model : ''})`).join(', ')
}
