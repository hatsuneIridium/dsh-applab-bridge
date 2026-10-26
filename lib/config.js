// 本文件由 AI（DeepSeek Harness）生成，经人工审查后提交；说明见 README「代码来源与审查」。
// 配置：$DSH_HOME/dsh-applab-bridge/config.json（首次加载时写默认值）。
// 全部字段都可省略；缺省即默认。路径解析失败不抛错，退回默认值——
// 一个坏掉的配置文件不应该让插件整体加载失败。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** DSH 用户目录：优先 $DSH_HOME，否则 ~/.dsh。 */
export function dshHome(env = process.env) {
  const fromEnv = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  return fromEnv || join(homedir(), '.dsh')
}

/** 配置文件绝对路径。 */
export function configFile(env = process.env) {
  return join(dshHome(env), 'dsh-applab-bridge', 'config.json')
}

export const DEFAULTS = Object.freeze({
  // adb 可执行文件；留空则自动查找（PATH → Arduino App Lab 自带 platform-tools）。
  adbPath: '',
  // 目标板序列号；留空则用 adb 唯一在线的设备，多台时报错要求填。
  serial: '',
  // 本地工作区根目录；留空则用进程 cwd/applab-workspaces。
  workspace: '',
  // 板子上 App 的根目录（user: 前缀的 App 在这里）。
  appRoot: '/home/arduino/ArduinoApps',
  // 一般 CLI 调用的超时（毫秒）。
  timeoutMs: 120000,
  // logs --follow 的默认采集时长（毫秒）。
  logTimeoutMs: 8000,
})

/** 允许出现在配置里的字段（未知字段忽略，避免旧配置污染）。 */
const KEYS = Object.keys(DEFAULTS)

function asBool(v, fallback) {
  return typeof v === 'boolean' ? v : fallback
}

function asInt(v, fallback, min, max) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  if (!Number.isFinite(n)) return fallback
  const i = Math.trunc(n)
  if (i < min) return min
  if (i > max) return max
  return i
}

/** 把任意输入规范化成完整配置对象。 */
export function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const cfg = {}
  for (const key of KEYS) {
    const v = src[key]
    if (key === 'timeoutMs') cfg[key] = asInt(v, DEFAULTS[key], 1000, 3600000)
    else if (key === 'logTimeoutMs') cfg[key] = asInt(v, DEFAULTS[key], 500, 60000)
    else cfg[key] = typeof v === 'string' ? v.trim() : DEFAULTS[key]
  }
  if (!cfg.appRoot) cfg.appRoot = DEFAULTS.appRoot
  if (!cfg.appRoot.startsWith('/')) cfg.appRoot = '/' + cfg.appRoot
  return cfg
}

/**
 * 读取配置。文件不存在时写一份默认值并返回；文件损坏时返回默认值并带 warning。
 * @returns {{ config: object, path: string, created: boolean, warning?: string }}
 */
export function loadConfig(env = process.env) {
  const path = configFile(env)
  let created = false
  let warning
  let raw = {}
  if (!existsSync(path)) {
    try {
      mkdirSync(join(dshHome(env), 'dsh-applab-bridge'), { recursive: true })
      writeFileSync(path, JSON.stringify(DEFAULTS, null, 2) + '\n', { mode: 0o600 })
      created = true
    } catch (err) {
      warning = `无法创建配置文件：${err && err.message ? err.message : err}`
    }
  } else {
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'))
    } catch (err) {
      warning = `配置文件不是合法 JSON，已按默认值运行：${err && err.message ? err.message : err}`
    }
  }
  return { config: normalizeConfig(raw), path, created, warning }
}

/**
 * 工作区根目录：配置优先，否则 $DSH_HOME/dsh-applab-bridge/workspaces。
 * 不用进程 cwd：DSH 宿主的 cwd 可能是安装目录（只读），拉下来的源码会写不进去。
 */
export function workspaceRoot(config, env = process.env) {
  const configured = config && config.workspace ? config.workspace : ''
  return configured || join(dshHome(env), 'dsh-applab-bridge', 'workspaces')
}

export { asBool }
