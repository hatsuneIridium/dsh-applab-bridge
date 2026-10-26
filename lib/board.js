// 本文件由 AI（DeepSeek Harness）生成，经人工审查后提交；说明见 README「代码来源与审查」。
// 板子会话：定位 adb、选设备、跑远端命令。所有工具共用这一层。
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describeDevices, parseDevices, pickDevice, resolveAdb, runProcess } from './adb.js'
import { buildCliCommand, explainCliFailure } from './commands.js'

/** 板子不可用/命令失败时抛的错：带一句可执行的下一步提示。 */
export class BoardError extends Error {
  constructor(message, hint = '', extra = {}) {
    super(message)
    this.name = 'BoardError'
    this.hint = hint
    this.extra = extra
  }
}

/** 把一次进程结果收敛成工具返回值（模型能直接读）。 */
export function toToolResult(res, command, extra = {}) {
  const output = [res.stdout, res.stderr].map((s) => (s || '').trim()).filter(Boolean).join('\n')
  const ok = res.code === 0 && !res.timedOut
  const result = {
    ok,
    command,
    exitCode: res.code,
    ...extra,
  }
  if (res.timedOut) result.timedOut = true
  if (output) result.output = output
  if (!ok) {
    const hint = explainCliFailure(command, output)
    if (hint) result.hint = hint
  }
  return result
}

export class Board {
  constructor(config) {
    this.config = config
    this.adb = ''
    this.adbSource = ''
    this.serial = ''
    this.devices = []
  }

  /** 定位 adb 并选中设备；结果缓存在实例上（一次工具调用一个实例）。 */
  async connect() {
    if (this.serial) return this
    const { path, source } = resolveAdb(this.config)
    if (!path) {
      throw new BoardError(
        '找不到 adb 可执行文件。',
        '安装 Android platform-tools 并加入 PATH，或在 $DSH_HOME/dsh-applab-bridge/config.json 里把 adbPath 指向 adb.exe。装了 Arduino App Lab 的话，它自带的 adb 会被自动发现。',
      )
    }
    const listed = await runProcess({ file: path, args: ['devices', '-l'], timeoutMs: 20000 })
    if (listed.code !== 0) {
      throw new BoardError(
        `adb devices 失败：${(listed.stderr || listed.stdout || '').trim() || `退出码 ${listed.code}`}`,
        '确认 adb 能正常启动（在终端里跑一次 adb version）。',
      )
    }
    const devices = parseDevices(listed.stdout)
    const picked = pickDevice(devices, this.config.serial)
    if (picked.error) {
      throw new BoardError(picked.error, 'USB 连接后在板子上允许调试；同时只连一台板子最省事。', { devices })
    }
    this.adb = path
    this.adbSource = source
    this.serial = picked.serial
    this.devices = devices
    return this
  }

  /** 跑一条 adb 子命令（自动带 -s）。 */
  async adbRun(args, { timeoutMs } = {}) {
    await this.connect()
    const command = `adb ${args.join(' ')}`
    const res = await runProcess({
      file: this.adb,
      args: ['-s', this.serial, ...args],
      timeoutMs: timeoutMs || this.config.timeoutMs,
    })
    return { res, command }
  }

  /** 在板子上跑一条 shell 命令。 */
  async shell(command, opts = {}) {
    return this.adbRun(['shell', command], opts)
  }

  /** 跑 `arduino-app-cli <argv>`。 */
  async cli(argv, opts = {}) {
    return this.shell(buildCliCommand(argv), opts)
  }

  /**
   * 把板子上的 App 目录拉到本地工作区。
   * 总是直接拉到 workspace 根下，避免目标已存在时 adb 多套一层目录。
   */
  async pull(remotePath, workspace, { timeoutMs } = {}) {
    const target = join(workspace, remotePath.split('/').filter(Boolean).pop())
    try {
      mkdirSync(workspace, { recursive: true })
    } catch (err) {
      throw new BoardError(`无法创建本地工作区 ${workspace}：${err.message}`, '检查配置里的 workspace 路径是否可写。')
    }
    const { res, command } = await this.adbRun(['pull', remotePath, workspace], { timeoutMs })
    return { res, command, localPath: target }
  }

  /** 把本地目录推回板子上的 App 根目录。 */
  async push(localPath, remoteParent, { timeoutMs } = {}) {
    let isDir = false
    try {
      isDir = existsSync(localPath) && statSync(localPath).isDirectory()
    } catch {
      isDir = false
    }
    if (!isDir) {
      throw new BoardError(`本地目录不存在：${localPath}`, '先执行 applab_app_pull 把 App 拉到本地，改完再 push。')
    }
    const { res, command } = await this.adbRun(['push', localPath, remoteParent], { timeoutMs })
    return { res, command }
  }

  /** 板子身份摘要（给 applab_status / doctor 用）。 */
  async identity() {
    const [uname, version] = await Promise.all([
      this.shell('uname -a', { timeoutMs: 15000 }),
      this.cli(['version'], { timeoutMs: 20000 }),
    ])
    return {
      serial: this.serial,
      adb: this.adb,
      adbSource: this.adbSource,
      devices: this.devices.map((d) => `${d.serial}(${d.state}${d.model ? ',' + d.model : ''})`).join(', ') || describeDevices(this.devices),
      uname: (uname.res.stdout || uname.res.stderr || '').trim(),
      cliVersion: (version.res.stdout || version.res.stderr || '').trim(),
    }
  }
}
