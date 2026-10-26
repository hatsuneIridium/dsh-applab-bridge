// 本文件由 AI（DeepSeek Harness）生成，经人工审查后提交；说明见 README「代码来源与审查」。
// 纯函数层：参数校验、shell 引用、命令拼装。全部可直接单测，不碰进程与文件系统。
// 之所以把「拼命令」和「跑命令」分开：板子上的一切都是字符串命令，注入风险集中在
// 这一层，单测覆盖它比在集成测试里碰真板子便宜得多。

/** POSIX 单引号引用；用于把用户值安全嵌进 adb shell 的远端命令。 */
export function shQuote(value) {
  const s = String(value)
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** 只给含空白或 shell 元字符的参数加引号，让日志里的命令保持可读。 */
export function quoteArg(value) {
  const s = String(value)
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : shQuote(s)
}

/** 把 argv 拼成一条远端命令（arduino-app-cli ...）。 */
export function buildCliCommand(argv) {
  return argv.map(quoteArg).join(' ')
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/
const ID_RE = /^(user|examples|release):[A-Za-z0-9][A-Za-z0-9 ._/-]{0,199}$/

/** 校验 App 名称（`app new` 的参数）。 */
export function validateAppName(name) {
  const s = String(name ?? '').trim()
  if (!s) return { error: 'App 名称不能为空。' }
  if (!NAME_RE.test(s)) {
    return { error: `App 名称不合法：${JSON.stringify(s)}。只允许字母、数字、空格、点、下划线、连字符，且以字母或数字开头（最长 64）。` }
  }
  if (s.endsWith('.')) return { error: 'App 名称不能以点结尾。' }
  return { value: s }
}

/**
 * 规范化 App 引用：`blink` → `user:blink`，`user:blink` 原样。
 * 其它前缀（examples:/release:）只读，允许用于列表/详情/克隆来源。
 */
export function normalizeAppId(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return { error: 'App id 不能为空，例如 user:blink。' }
  if (s.includes(':')) {
    if (!ID_RE.test(s)) return { error: `App id 不合法：${JSON.stringify(s)}。示例：user:blink` }
    return { value: s }
  }
  const checked = validateAppName(s)
  if (checked.error) return checked
  return { value: `user:${checked.value}` }
}

/** 从 `user:name` 取出板子上的目录名；非 user: 返回 null。 */
export function userAppName(id) {
  if (typeof id !== 'string' || !id.startsWith('user:')) return null
  const name = id.slice('user:'.length)
  if (!name || name.includes('/')) return null
  return name
}

/** user: App 在板子上的绝对路径。 */
export function remoteAppPath(appRoot, id) {
  const name = userAppName(id)
  if (!name) return null
  return `${appRoot.replace(/\/+$/, '')}/${name}`
}

/** `arduino-app-cli app new` 的 argv。 */
export function newAppArgv(name, { fromApp, bricks, noSketch } = {}) {
  const argv = ['app', 'new', name]
  if (fromApp) argv.push('--from-app', fromApp)
  if (Array.isArray(bricks)) for (const brick of bricks) if (brick) argv.push('--bricks', brick)
  if (noSketch) argv.push('--no-sketch')
  return argv
}

/** 从 `adb pull` 输出里数出传输的条目数（用于给模型一个体积感）。 */
export function countPulledEntries(output) {
  const m = /(\d+)\s+files?\s+pulled/i.exec(String(output || ''))
  if (m) return Number(m[1])
  const lines = String(output || '').split(/\r?\n/).filter((l) => /\b(pulled|skipped)\b/i.test(l))
  return lines.length
}

/** 把 stderr 里最常见的板端错误翻译成可执行的下一步。 */
export function explainCliFailure(command, output) {
  const text = String(output || '')
  if (/command not found|not found/i.test(text) && /arduino-app-cli/.test(command)) {
    return '板子上找不到 arduino-app-cli。请确认这是 UNO Q / VENTUNO Q 的 Debian 侧，并且系统镜像未损坏（App Lab 里可查看板子信息）。'
  }
  if (/unauthorized/i.test(text)) return 'adb 设备未授权：在板子上确认 USB 调试授权，或重新插拔 USB。'
  if (/more than one device|multiple devices/i.test(text)) return 'adb 看到多台设备：请在配置里指定 serial。'
  if (/no devices|device offline/i.test(text)) return 'adb 没有在线设备：检查 USB 线（要数据线）、板子电源，以及 App Lab 是否占用了连接。'
  if (/permission denied/i.test(text)) return '板端权限不足：App 目录可能属于 root。可以先用 applab_shell 执行 chown -R arduino:arduino /home/arduino/ArduinoApps。'
  if (/unknown command|unknown flag|unknown shorthand/i.test(text)) return '板子上的 arduino-app-cli 版本较旧，可能不支持这个子命令/参数。可以先跑 applab_doctor 看版本，必要时在板子上 system update。'
  return ''
}
