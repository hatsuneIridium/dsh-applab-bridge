// 本文件由 AI（DeepSeek Harness）生成，经人工审查后提交；说明见 README「代码来源与审查」。
// dsh-applab-bridge — 把 Arduino App Lab / UNO Q 接到 DSH。
//
// 设计取舍：不复制 App Lab 的私有 UI 通道，而是走板子上官方自带的
// `arduino-app-cli`（App Lab 自己也是它的前端），传输用 adb（与 App Lab 的
// Connected Mode 完全一致，USB 免密）。这样 DSH 不依赖 App Lab 是否在运行，
// 也不会因为 App Lab 升级内部接口而失效。
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { loadConfig, workspaceRoot } from './lib/config.js'
import { Board, BoardError, toToolResult } from './lib/board.js'
import { parseDevices, resolveAdb, runProcess } from './lib/adb.js'
import {
  isActiveStatus,
  newAppArgv,
  normalizeAppId,
  parseAppList,
  remoteAppPath,
  shQuote,
  userAppName,
  validateAppName,
} from './lib/commands.js'

const render = (_args, value) => [
  { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
]

const output = () => ({ schema: { type: 'json' }, render })

/** 统一错误出口：把 BoardError 的提示原样交给模型，而不是抛栈。 */
async function guarded(fn) {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof BoardError) {
      return { ok: false, error: err.message, hint: err.hint, ...(err.extra || {}) }
    }
    return { ok: false, error: String(err && err.message ? err.message : err) }
  }
}

/** 秒 → 毫秒，夹在 [min, max] 里。 */
function seconds(value, fallbackSec, min = 1, max = 3600) {
  const n = typeof value === 'number' ? value : Number(value)
  const sec = Number.isFinite(n) && n > 0 ? n : fallbackSec
  return Math.min(max, Math.max(min, Math.round(sec * 1000)))
}

export default {
  inject: ['tools'],
  apply(ctx) {
    const disposers = []
    ctx.effect(() => () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          /* 卸载时忽略单个工具的释放错误 */
        }
      }
    })

    /** 每次调用重新读配置：用户改了 config.json 不必重启 DSH。 */
    function config() {
      return loadConfig()
    }

    function board(cfg) {
      return new Board(cfg)
    }

    /** 跑一条 CLI 子命令并归一化结果。 */
    async function cli(cfg, argv, { timeoutMs, extra } = {}) {
      const b = board(cfg)
      const { res, command } = await b.cli(argv, { timeoutMs })
      return toToolResult(res, command, { serial: b.serial, ...(extra || {}) })
    }

    function register(definition) {
      disposers.push(ctx.tools.register(defineTool(definition)))
    }

    // ── 诊断 ────────────────────────────────────────────────────────────────

    register({
      name: 'applab_doctor',
      description:
        '诊断 DSH 到 Arduino UNO Q / VENTUNO Q 的链路：配置路径、adb 位置（PATH/Arduino App Lab 自带）、在线设备、板端 uname 与 arduino-app-cli 版本。任何 applab_* 工具报错时先跑它。',
      parameters: {},
      output: output(),
      async execute() {
        return guarded(async () => {
          const { config: cfg, path, created, warning } = config()
          const adb = resolveAdb(cfg)
          const result = {
            ok: true,
            configPath: path,
            configCreated: created,
            config: cfg,
            adbPath: adb.path || '(未找到)',
            adbSource: adb.source || '(未找到)',
            devices: [],
          }
          if (warning) result.configWarning = warning
          if (!adb.path) {
            result.ok = false
            result.hint = '安装 Android platform-tools 并加入 PATH，或在 config.json 里设置 adbPath。装了 Arduino App Lab 时会自动发现它自带的 adb。'
            return result
          }
          const listed = await runProcess({ file: adb.path, args: ['devices', '-l'], timeoutMs: 20000 })
          result.devices = parseDevices(listed.stdout)
          if (listed.code !== 0) {
            result.ok = false
            result.error = `adb devices 失败：${(listed.stderr || listed.stdout || '').trim() || `退出码 ${listed.code}`}`
            result.hint = '在终端里手动跑一次 adb version / adb devices，确认 adb 能启动且 5037 端口没被占用。'
            return result
          }
          if (result.devices.length === 0) {
            result.ok = false
            result.hint = 'adb 没有看到设备：用数据线连接板子，确认板子已启动并在系统里出现为 USB 设备。'
            return result
          }
          try {
            result.board = await board(cfg).identity()
          } catch (err) {
            result.ok = false
            result.error = err instanceof BoardError ? err.message : String(err && err.message ? err.message : err)
            if (err instanceof BoardError) result.hint = err.hint
          }
          return result
        })
      },
    })

    // ── 状态 ────────────────────────────────────────────────────────────────

    register({
      name: 'applab_status',
      description:
        '板子与 App 运行态总览：板端 uname、arduino-app-cli 版本、App 总数与正在运行/启动中/失败的 App。定位“为什么没跑起来”的第一步。',
      parameters: {},
      output: output(),
      async execute() {
        return guarded(async () => {
          const { config: cfg } = config()
          const b = board(cfg)
          const identity = await b.identity()
          const list = await b.cli(['app', 'list'], { timeoutMs: 45000 })
          const rows = parseAppList(list.res.stdout)
          const active = rows.filter((row) => isActiveStatus(row.status))
          const result = {
            ok: list.res.code === 0,
            ...identity,
            totalApps: rows.length,
            activeCount: active.length,
            active,
          }
          if (list.res.code !== 0) Object.assign(result, toToolResult(list.res, list.command))
          return result
        })
      },
    })

    register({
      name: 'applab_apps_list',
      description:
        '列出板子上的 App：`app list`（0.14+ 加 --all）。返回结构化列表（id/name/icon/status/example）以及 CLI 原始表格；App id 形如 user:my-app、examples:inspirational/blink。',
      parameters: {},
      output: output(),
      async execute() {
        return guarded(async () => {
          const { config: cfg } = config()
          const b = board(cfg)
          const modern = await b.modern()
          const argv = ['app', 'list']
          if (modern) argv.push('--all')
          const list = await b.cli(argv, { timeoutMs: 60000 })
          const rows = parseAppList(list.res.stdout)
          const result = toToolResult(list.res, list.command, { cliVersion: (await b.versionInfo()).text || undefined })
          if (rows.length) {
            result.total = rows.length
            result.apps = rows.map(({ id, name, icon, status, example }) => ({ id, name, icon, status, example }))
          }
          return result
        })
      },
    })

    register({
      name: 'applab_app_details',
      description:
        '查看一个 App 的详情。0.14+ 用 `app details <id>`；0.13 没有该子命令，改为读取板端 app.yaml 与文件树（仅 user: App）。改 Bricks 前先看它。',
      parameters: {
        id: { type: 'string', required: true, description: 'App id，例如 user:blink 或 examples:inspirational/blink' },
      },
      output: output(),
      async execute(args) {
        return guarded(async () => {
          const { config: cfg } = config()
          const id = normalizeAppId(args.id)
          if (id.error) return { ok: false, error: id.error }
          const b = board(cfg)
          const modern = await b.modern()
          if (modern) return cli(cfg, ['app', 'details', id.value], { timeoutMs: 45000 })
          const remote = remoteAppPath(cfg.appRoot, id.value)
          if (!remote) {
            return {
              ok: false,
              error: `当前板端 CLI ${(await b.versionInfo()).text || ''} 没有 app details 子命令，且 ${id.value} 不是 user: App。`,
              hint: '先用 applab_app_create 的 fromApp 把它复制成 user: App，再查看详情。',
            }
          }
          const yaml = await b.shell(`cat ${shQuote(`${remote}/app.yaml`)}`, { timeoutMs: 20000 })
          const tree = await b.shell(`find ${shQuote(remote)} -maxdepth 2 -type f | sort | head -60`, { timeoutMs: 20000 })
          return {
            ok: yaml.res.code === 0,
            path: remote,
            cliVersion: (await b.versionInfo()).text || undefined,
            appYaml: (yaml.res.stdout || '').trim(),
            files: (tree.res.stdout || '').trim().split(/\r?\n/).filter(Boolean),
            note: '板端 CLI 没有 app details，这里用 app.yaml + 文件树代替。',
          }
        })
      },
    })

    // ── 创建与生命周期 ───────────────────────────────────────────────────────

    register({
      name: 'applab_app_create',
      description:
        '新建 App：`arduino-app-cli app new <name>`，可从示例复制（fromApp）并预装 Bricks。生成 board 端的 app.yaml、python/、sketch/。创建后用 applab_app_pull 拉到本地改代码。',
      parameters: {
        name: { type: 'string', required: true, description: 'App 名称，例如 My Blink App（会变成 user:my-blink-app 之类的 id）' },
        fromApp: { type: 'string', description: '可选：从已有 App/示例复制，例如 examples:inspirational/blink' },
        bricks: { type: 'array', description: '可选：预装 Brick 列表，例如 ["arduino:web_ui"]' },
        noSketch: { type: 'boolean', description: '可选：只建 Python 部分，不建 sketch（--no-sketch）' },
        description: { type: 'string', description: '可选：App 描述（--description）' },
        icon: { type: 'string', description: '可选：单 emoji 图标（--icon）' },
      },
      output: output(),
      async execute(args) {
        return guarded(async () => {
          const { config: cfg } = config()
          const name = validateAppName(args.name)
          if (name.error) return { ok: false, error: name.error }
          let fromApp = ''
          if (args.fromApp) {
            const id = normalizeAppId(args.fromApp)
            if (id.error) return { ok: false, error: `fromApp 不合法：${id.error}` }
            fromApp = id.value
          }
          const bricks = Array.isArray(args.bricks) ? args.bricks.filter((b) => typeof b === 'string' && b.trim()) : []
          const argv = newAppArgv(name.value, {
            fromApp,
            bricks,
            noSketch: args.noSketch === true,
            description: typeof args.description === 'string' ? args.description.trim() : '',
            icon: typeof args.icon === 'string' ? args.icon.trim() : '',
          })
          return cli(cfg, argv, { timeoutMs: 120000, extra: { appId: `user:${name.value}` } })
        })
      },
    })

    register({
      name: 'applab_app_start',
      description:
        '启动 App：板端后台跑 `app start <id> --verbose`，再轮询 `app list` 直到 running 或 failed（默认等 600 秒）。首次启动要编译 sketch / 拉容器，几分钟很正常；超时只会结束等待，不会中断板端启动。返回启动日志尾部。',
      parameters: {
        id: { type: 'string', required: true, description: 'App id，例如 user:my-app' },
        timeoutSec: { type: 'number', description: '等待上限（秒，默认 600）' },
      },
      output: output(),
      async execute(args) {
        return guarded(async () => {
          const { config: cfg } = config()
          const id = normalizeAppId(args.id)
          if (id.error) return { ok: false, error: id.error }
          const b = board(cfg)
          const result = await b.startApp(id.value, { timeoutMs: seconds(args.timeoutSec, 600, 10, 1800) })
          return { ...result, serial: b.serial }
        })
      },
    })

    register({
      name: 'applab_app_stop',
      description: '停止 App：`app stop <id>`。',
      parameters: {
        id: { type: 'string', required: true, description: 'App id，例如 user:my-app' },
      },
      output: output(),
      async execute(args) {
        return guarded(async () => {
          const { config: cfg } = config()
          const id = normalizeAppId(args.id)
          if (id.error) return { ok: false, error: id.error }
          return cli(cfg, ['app', 'stop', id.value], { timeoutMs: 120000 })
        })
      },
    })

    register({
      name: 'applab_app_restart',
      description: '重启 App：与 start 相同的后台 + 轮询方式，只是动词换成 `app restart`。改了代码、push 之后最常用。',
      parameters: {
        id: { type: 'string', required: true, description: 'App id，例如 user:my-app' },
        timeoutSec: { type: 'number', description: '等待上限（秒，默认 600）' },
      },
      output: output(),
      async execute(args) {
        return guarded(async () => {
          const { config: cfg } = config()
          const id = normalizeAppId(args.id)
          if (id.error) return { ok: false, error: id.error }
          const b = board(cfg)
          const result = await b.startApp(id.value, {
            restart: true,
            timeoutMs: seconds(args.timeoutSec, 600, 10, 1800),
          })
          return { ...result, serial: b.serial }
        })
      },
    })

    register({
      name: 'applab_app_logs',
      description:
        '读 App 的 Python 日志：`app logs <id>`。follow=true 时用 `--follow` 采集若干秒后截断返回（默认 8 秒）；默认采集 3 秒。返回带 timedOut 标记说明是主动截断，不是失败。',
      parameters: {
        id: { type: 'string', required: true, description: 'App id，例如 user:my-app' },
        follow: { type: 'boolean', description: '是否跟随新日志（--follow）' },
        timeoutSec: { type: 'number', description: '采集时长（秒，默认 follow=8 / 非 follow=3）' },
      },
      output: output(),
      async execute(args) {
        return guarded(async () => {
          const { config: cfg } = config()
          const id = normalizeAppId(args.id)
          if (id.error) return { ok: false, error: id.error }
          const follow = args.follow === true
          const fallback = follow ? Math.round(cfg.logTimeoutMs / 1000) || 8 : 3
          const b = board(cfg)
          const modern = await b.modern()
          const argv = ['app', 'logs', id.value]
          if (!modern) argv.push('--tail', '200')
          if (follow) argv.push('--follow')
          const result = await cli(cfg, argv, { timeoutMs: seconds(args.timeoutSec, fallback, 1, 60) })
          if (result.timedOut) result.note = '已按采集时长截断（follow 模式正常现象）。需要更多日志就调大 timeoutSec 再跑一次。'
          return result
        })
      },
    })

    // ── 源码同步 ─────────────────────────────────────────────────────────────

    register({
      name: 'applab_app_pull',
      description:
        '把板子上的 user App 源码拉到本地工作区（adb pull）。之后用 DSH 的读写/编辑工具改本地文件，再用 applab_app_push 推回去并 restart。只支持 user: 开头的 App——示例先用 applab_app_create 的 fromApp 复制一份。',
      parameters: {
        id: { type: 'string', required: true, description: 'App id，例如 user:my-app' },
        dir: { type: 'string', description: '可选：本地工作区根目录（默认 $DSH_HOME/dsh-applab-bridge/workspaces，或配置里的 workspace）' },
        timeoutSec: { type: 'number', description: '超时（秒，默认 180）' },
      },
      output: output(),
      async execute(args) {
        return guarded(async () => {
          const { config: cfg } = config()
          const id = normalizeAppId(args.id)
          if (id.error) return { ok: false, error: id.error }
          const remote = remoteAppPath(cfg.appRoot, id.value)
          if (!remote) {
            return {
              ok: false,
              error: `只能拉取 user: 开头的 App，收到 ${id.value}。`,
              hint: '内置示例是只读的：先用 applab_app_create 的 fromApp 复制成自己的 App。',
            }
          }
          const workspace = typeof args.dir === 'string' && args.dir.trim() ? args.dir.trim() : workspaceRoot(cfg)
          const b = board(cfg)
          const { res, command, localPath } = await b.pull(remote, workspace, {
            timeoutMs: seconds(args.timeoutSec, 180, 5, 1800),
          })
          return toToolResult(res, command, { serial: b.serial, localPath, workspace })
        })
      },
    })

    register({
      name: 'applab_app_push',
      description:
        '把本地工作区里的 App 目录推回板子（adb push），并可选重启。改完代码的标准闭环：applab_app_pull → 本地编辑 → applab_app_push（restart=true）→ applab_app_logs。',
      parameters: {
        id: { type: 'string', required: true, description: 'App id，例如 user:my-app' },
        dir: { type: 'string', description: '可选：本地 App 目录（默认 <workspace>/<app 名>）' },
        restart: { type: 'boolean', description: '推送后是否 app restart（默认 true）' },
        timeoutSec: { type: 'number', description: '推送超时（秒，默认 180）' },
      },
      output: output(),
      async execute(args) {
        return guarded(async () => {
          const { config: cfg } = config()
          const id = normalizeAppId(args.id)
          if (id.error) return { ok: false, error: id.error }
          const name = userAppName(id.value)
          if (!name) {
            return { ok: false, error: `只能推送 user: 开头的 App，收到 ${id.value}。` }
          }
          const localPath = typeof args.dir === 'string' && args.dir.trim() ? args.dir.trim() : join(workspaceRoot(cfg), name)
          const b = board(cfg)
          const pushed = await b.push(localPath, cfg.appRoot, { timeoutMs: seconds(args.timeoutSec, 180, 5, 1800) })
          const result = toToolResult(pushed.res, pushed.command, { serial: b.serial, localPath })
          // 板端目录可能归 root（adb push 以 shell 身份写），尽力修正属主；失败不影响推送结果。
          const chown = await b.shell(`chown -R arduino:arduino ${cfg.appRoot}/${name} 2>&1 || true`, { timeoutMs: 30000 })
          if (chown.res.code !== 0) result.chownWarning = (chown.res.stderr || chown.res.stdout || '').trim()
          if (args.restart !== false) {
            result.restart = await b.startApp(id.value, {
              restart: true,
              timeoutMs: seconds(args.timeoutSec, 600, 10, 1800),
            })
          }
          return result
        })
      },
    })

    // ── 板端命令 / 目录 ──────────────────────────────────────────────────────

    register({
      name: 'applab_shell',
      description:
        '在板子上执行一条 POSIX shell 命令（adb shell，以板端用户身份）。这是逃生通道：优先用专用工具；查看/修改 App 源码请走 applab_app_pull/push，不要用 cat/sed 改板上的文件（改动会绕过本地工作区，且容易和推送互相覆盖）。',
      parameters: {
        command: { type: 'string', required: true, description: '要执行的命令，例如 ls -la /home/arduino/ArduinoApps' },
        timeoutSec: { type: 'number', description: '超时（秒，默认 120）' },
      },
      output: output(),
      async execute(args) {
        return guarded(async () => {
          const { config: cfg } = config()
          const command = String(args.command || '').trim()
          if (!command) return { ok: false, error: 'command 不能为空。' }
          const b = board(cfg)
          const { res, command: shown } = await b.shell(command, {
            timeoutMs: seconds(args.timeoutSec, 120, 1, 1800),
          })
          return toToolResult(res, shown, { serial: b.serial })
        })
      },
    })

    register({
      name: 'applab_bricks_list',
      description: '列出板子上可用的 Bricks：`brick list`。给 App 加 Brick 或排查缺 Brick 时用。',
      parameters: {},
      output: output(),
      async execute() {
        return guarded(async () => {
          const { config: cfg } = config()
          return cli(cfg, ['brick', 'list'], { timeoutMs: 45000 })
        })
      },
    })

    register({
      name: 'applab_models_list',
      description: '列出板子上的 AI 模型（`model list`）。装模型用 applab_shell 跑 `arduino-app-cli model install <id>`。注意：0.13 的 model list 偶尔会卡住（可能在校验远端目录），这里默认 20 秒超时并明确标记。',
      parameters: {},
      output: output(),
      async execute() {
        return guarded(async () => {
          const { config: cfg } = config()
          const result = await cli(cfg, ['model', 'list'], { timeoutMs: 20000 })
          if (result.timedOut) {
            result.note = 'model list 在 20 秒内没有返回，已中止（板端 CLI 可能正在联网校验模型目录）。可稍后重试，或在 App Lab 里查看模型页。'
          }
          return result
        })
      },
    })
  },
}
