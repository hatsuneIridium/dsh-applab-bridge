// 本文件由 AI（DeepSeek Harness）生成，经人工审查后提交；说明见 README「代码来源与审查」。
// 板子会话：定位 adb、选设备、跑远端命令。所有工具共用这一层。
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describeDevices, parseDevices, pickDevice, resolveAdb, runProcess } from './adb.js'
import { buildCliCommand, explainCliFailure, parseAppList, parseAppListJSON, quoteArg } from './commands.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

  /** 在板子上跑一条 shell 命令（-n：不分配 pty，避免后台任务把会话挂住）。 */
  async shell(command, opts = {}) {
    return this.adbRun(['shell', '-n', command], opts)
  }

  /** 跑 `arduino-app-cli <argv>`。 */
  async cli(argv, opts = {}) {
    return this.shell(buildCliCommand(argv), opts)
  }

  /**
   * 把一条 CLI 命令放到板端后台执行、输出写文件，再用**新的** adb shell 读取。
   *
   * 0.13 的 `model list` 会留下继承 stdout 的 daemon 子进程：直接 `adb shell`
   * 会一直等 EOF（实测即使 timeout 杀了命令，会话仍挂住）。detach 到文件后，
   * 读取不经过那条会话，就不会被残留进程拖住；顺带也能拿到超时前的部分输出。
   */
  async collectCli(argv, { timeoutMs = 20000, pollMs = 500, logPath } = {}) {
    await this.connect()
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
    const log = logPath || `/tmp/dsh-applab-collect-${stamp}.txt`
    const pidFile = `${log}.pid`
    const inner = `${buildCliCommand(argv)} > ${quoteArg(log)} 2>&1`
    const launch = `rm -f ${quoteArg(log)} ${quoteArg(pidFile)}; setsid sh -c ${quoteArg(inner)} </dev/null >/dev/null 2>&1 & echo $! > ${quoteArg(pidFile)}; echo launched`
    const launched = await this.shell(launch, { timeoutMs: 15000 })
    if (launched.res.code !== 0) {
      return { res: launched.res, command: launched.command, logPath: log, timedOut: false }
    }
    const deadline = Date.now() + timeoutMs
    let timedOut = false
    while (Date.now() < deadline) {
      await sleep(pollMs)
      const probe = await this.shell(
        `p=$(cat ${quoteArg(pidFile)} 2>/dev/null); if [ -n "$p" ] && kill -0 $p 2>/dev/null; then echo running; else echo done; fi; wc -c < ${quoteArg(log)} 2>/dev/null || echo 0`,
        { timeoutMs: 10000 },
      )
      const text = (probe.res.stdout || '').trim()
      if (/^done/m.test(text)) break
    }
    if (Date.now() >= deadline) timedOut = true
    const read = await this.shell(`cat ${quoteArg(log)} 2>/dev/null`, { timeoutMs: 20000 })
    // 超时或异常退出时清理残留（setsid 让它可以按进程组杀）。
    await this.shell(
      `p=$(cat ${quoteArg(pidFile)} 2>/dev/null); [ -n "$p" ] && kill -TERM -$p 2>/dev/null; rm -f ${quoteArg(pidFile)}; true`,
      { timeoutMs: 10000 },
    )
    return {
      res: { code: read.res.code, stdout: read.res.stdout || '', stderr: read.res.stderr || '', timedOut },
      command: `${buildCliCommand(argv)}  (detached; log=${log})`,
      logPath: log,
      timedOut,
    }
  }

  /**
   * 列出 App。优先文本表格：0.13 的 `--format json` 会漏掉 broken/uninitialized 的
   * App（实测 142 个里少 7 个），而文本表格是全的。JSON 只在文本解析不出时兜底。
   */
  async appList({ all = false, timeoutMs = 30000 } = {}) {
    const argv = ['app', 'list']
    if (all) argv.push('--all')
    const text = await this.cli(argv, { timeoutMs })
    const rows = parseAppList(text.res.stdout)
    if (rows.length) return { rows, raw: text.res.stdout, format: 'text', command: text.command }
    const json = await this.cli([...argv, '--format', 'json'], { timeoutMs })
    return { rows: parseAppListJSON(json.res.stdout), raw: json.res.stdout, format: 'json', command: json.command, ok: json.res.code === 0 }
  }

  /**
   * 启动/重启 App：板端后台执行，再轮询 `app list` 等它真正 running。
   *
   * 为什么不在前台跑 `app start`：它会阻塞到容器就绪，首次启动还要编译 sketch，
   * 几分钟很正常；前台跑一旦超时被杀，adb 断开会把板端的 start 一起带走（实测编译
   * 到一半就停）。后台执行 + 轮询，超时只影响这次调用的等待，不影响板端启动。
   */
  async startApp(id, { restart = false, timeoutMs = 600000, pollMs = 2500, logPath } = {}) {
    await this.connect()
    const safe = String(id).replace(/[^A-Za-z0-9._-]/g, '_')
    const log = logPath || `/tmp/dsh-applab-${safe}.log`
    const verb = restart ? 'restart' : 'start'
    const inner = `${buildCliCommand(['app', verb, id, '--verbose'])} > ${quoteArg(log)} 2>&1`
    // setsid：脱离当前会话/控制终端，adb shell 断开时不会被一起收走。
    // 只用 nohup 实测不够——启动进程会在 adb 会话结束时消失（日志只剩第一行）。
    const launch = `setsid sh -c ${quoteArg(inner)} </dev/null >/dev/null 2>&1 & echo launched`
    let launched = await this.shell(launch, { timeoutMs: 20000 })
    if (launched.res.code !== 0 || /setsid: not found|command not found/i.test(launched.res.stderr || '')) {
      const fallback = `nohup sh -c ${quoteArg(inner)} </dev/null >/dev/null 2>&1 & echo launched`
      launched = await this.shell(fallback, { timeoutMs: 20000 })
    }
    if (launched.res.code !== 0) {
      return { ok: false, command: launched.command, logPath: log, output: (launched.res.stderr || launched.res.stdout || '').trim() }
    }
    const deadline = Date.now() + timeoutMs
    let status = ''
    let timedOut = false
    let sawStartMarker = false
    while (Date.now() < deadline) {
      await sleep(pollMs)
      // 日志标记比 `app list` 的状态更可靠：0.13 里容器已经起来、日志也写了
      // "started successfully"，app list 仍可能显示 uninitialized。
      const chunk = await this.shell(`tail -c 1200 ${quoteArg(log)} 2>/dev/null`, { timeoutMs: 10000 })
      if (/started successfully|App started/i.test(chunk.res.stdout || '')) {
        sawStartMarker = true
        status = 'running'
        break
      }
      const listing = await this.appList({ timeoutMs: 15000 })
      const row = listing.rows.find((r) => r.id === id)
      status = row ? row.status : ''
      if (status === 'running' || /fail|error/i.test(status)) break
    }
    if (!sawStartMarker && status !== 'running') timedOut = Date.now() >= deadline
    const tail = await this.shell(`tail -n 40 ${quoteArg(log)} 2>/dev/null`, { timeoutMs: 15000 })
    const raw = (tail.res.stdout || '').trim()
    // 编译输出单行可达数 KB，逐行截断后再交给模型。
    const lines = raw
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-25)
      .map((line) => (line.length > 300 ? `${line.slice(0, 300)}…` : line))
    const startMarker = /started successfully|App started/i.test(raw)
    const started = startMarker || status === 'running'
    const logError = /\[ERROR\]|Exit Status [1-9]|error:/i.test(raw)
    const result = {
      ok: started,
      command: launched.command,
      logPath: log,
      status: status || 'unknown',
      timedOut: started ? false : timedOut,
      output: lines.join('\n') || undefined,
    }
    if (logError) {
      result.logError = true
      result.note = started
        ? '日志里出现 ERROR（常见于 sketch 编译/上传失败），但 App 进程已启动；用 applab_app_logs 看 Python 侧，用 applab_shell 看完整启动日志。'
        : '启动日志里出现 ERROR，App 可能没有起来。'
    }
    return result
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

  /**
   * 板端 CLI 版本。0.13 与 0.14 的命令集不同（`app ps`、`app details`、
   * `app list --all` 都是 0.14 才有的），所以命令要按版本分流。
   */
  async versionInfo() {
    if (this._versionInfo !== undefined) return this._versionInfo
    const { res } = await this.cli(['version'], { timeoutMs: 20000 })
    const text = `${res.stdout || ''}\n${res.stderr || ''}`.trim()
    const m = /version\s+(\d+)\.(\d+)\.(\d+)/i.exec(text)
    this._versionInfo = m
      ? { raw: text, text: `${m[1]}.${m[2]}.${m[3]}`, major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
      : { raw: text, text: '', major: NaN, minor: NaN, patch: NaN }
    return this._versionInfo
  }

  /** 是否支持 0.14+ 的 `app ps` / `app details` / `app list --all`。 */
  async modern() {
    const v = await this.versionInfo()
    if (!v.text) return true // 版本读不出来时按新命令试一次，失败会带 CLI 的原始报错
    return v.major > 0 || v.minor >= 14
  }

  /** 板子身份摘要（给 applab_status / doctor 用）。 */
  async identity() {
    const [uname, version] = await Promise.all([
      this.shell('uname -a', { timeoutMs: 15000 }),
      this.versionInfo(),
    ])
    return {
      serial: this.serial,
      adb: this.adb,
      adbSource: this.adbSource,
      devices: this.devices.map((d) => `${d.serial}(${d.state}${d.model ? ',' + d.model : ''})`).join(', ') || describeDevices(this.devices),
      uname: (uname.res.stdout || uname.res.stderr || '').trim(),
      cliVersion: version.text || version.raw,
    }
  }
}
