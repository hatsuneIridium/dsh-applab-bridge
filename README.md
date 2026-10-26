# dsh-applab-bridge

> **代码来源**：本仓库代码由 AI（DeepSeek Harness）生成，经人工审查后提交。详见 [代码来源与审查](#代码来源与审查)。

把 **Arduino App Lab / UNO Q** 接到 **DeepSeek Harness（DSH）**：DSH 的 agent 可以直接列出、创建、启动、停止板子上的 App，读日志，把 App 源码拉到本地改完再推回去。

插件不动 Arduino App Lab 本体，也不依赖 App Lab 是否在运行：它走板子上官方自带的 `arduino-app-cli`（App Lab 自己也是它的前端），传输用 **adb**——和 App Lab 的 Connected Mode 完全同一条链路，USB 免密。

```
DSH 工具 (applab_*)
      │  adb -s <serial> shell
      ▼
UNO Q / VENTUNO Q 板子
      ├─ arduino-app-cli app list | start | stop | logs ...
      └─ /home/arduino/ArduinoApps/<app>/{app.yaml,python/,sketch/}
```

## 能做什么

| 工具 | 作用 |
| --- | --- |
| `applab_doctor` | 诊断：配置路径、adb 位置、在线设备、板端 uname 与 CLI 版本 |
| `applab_status` | 板子身份 + App 总数 + 正在运行/启动中/失败的 App（按状态过滤） |
| `applab_apps_list` | `app list`（0.14+ 自动加 `--all`），返回结构化列表 + CLI 原始表格 |
| `applab_app_details` | 0.14+ 用 `app details`；0.13 退回读 `app.yaml` + 文件树（仅 `user:` App） |
| `applab_app_create` | `app new`，支持 `--from-app` 复制示例、`--bricks`、`--description`、`--icon`、`--no-sketch` |
| `applab_app_start` / `_stop` / `_restart` | 生命周期；start/restart 在板端后台执行并轮询到 running（不被 adb 超时打断） |
| `applab_app_logs` | `app logs`，可 `--follow` 采集若干秒后截断 |
| `applab_app_pull` | 把 `user:` App 源码 `adb pull` 到本地工作区 |
| `applab_app_push` | 本地改完 `adb push` 回板子，默认顺带重启 |
| `applab_shell` | 板端 POSIX shell（逃生通道） |
| `applab_bricks_list` / `applab_models_list` | Brick 目录 / AI 模型目录 |

## 前置条件

1. **UNO Q 或 VENTUNO Q**，USB 数据线连接到这台电脑，板子已启动。
2. **adb**：插件按 `配置 → PATH → Arduino App Lab 自带` 的顺序自动找。App Lab 的 adb 在
   `%LOCALAPPDATA%\AppLab\a15\data\packages\arduino\tools\adb\<version>\adb.exe`。
3. 板子上 `arduino-app-cli` 可执行（系统镜像自带；App Lab 的终端里能跑就说明没问题）。

> App Lab 可以同时开着。它用 adb 时同一时刻只能有一个 `adb server`，两边会共用，不冲突。

### 板端 CLI 兼容性

| CLI 版本 | 行为 |
| --- | --- |
| 0.13（实测 UNO Q 出厂镜像） | `app list` 已含全部 App 与状态；没有 `app ps` / `app list --all` / `app details`；插件自动改用 `app.yaml` + 文件树 |
| 0.14+ | 使用 `app ps --all`、`app details`、`app list --all` |

版本以 `arduino-app-cli version` 为准，插件的 `applab_doctor` 会打印出来。

## 安装

### 方式一：插件管理器（推荐）

先克隆到本地任意目录：

```powershell
git clone https://github.com/hatsuneIridium/dsh-applab-bridge.git "$env:USERPROFILE\dsh-applab-bridge"
```

然后 设置 → 插件 → 添加插件 → 选 **本地路径**，填 `%USERPROFILE%\dsh-applab-bridge`，安装后重启 `dsh web`。

插件没有 npm 依赖（只用 Node 内置模块），本地路径安装不需要联网构建。

### 方式二：命令行

```powershell
git clone https://github.com/hatsuneIridium/dsh-applab-bridge.git "$env:USERPROFILE\dsh-applab-bridge"
dsh plugin --profile desktop add -w "$env:USERPROFILE\dsh-applab-bridge"
```

重启 `dsh web`。

## 配置

首次加载会生成 `%USERPROFILE%\.dsh\dsh-applab-bridge\config.json`（`$DSH_HOME` 优先）：

```json
{
  "adbPath": "",
  "serial": "",
  "workspace": "",
  "appRoot": "/home/arduino/ArduinoApps",
  "timeoutMs": 120000,
  "logTimeoutMs": 8000
}
```

| 字段 | 说明 |
| --- | --- |
| `adbPath` | 留空自动查找；指定时必须指向可执行的 `adb.exe` |
| `serial` | 多台设备时必填；单台留空即可 |
| `workspace` | 本地工作区根目录；留空用 `$DSH_HOME\dsh-applab-bridge\workspaces` |
| `appRoot` | 板端 App 根目录，默认 `/home/arduino/ArduinoApps` |
| `timeoutMs` | 一般 CLI 调用超时 |
| `logTimeoutMs` | `logs --follow` 默认采集时长 |

改完保存即可，工具每次调用都会重读配置，不用重启。

## 典型闭环

```
你：看看板子上现在有什么 App，把 user:blink 跑起来
DSH：applab_apps_list → applab_app_start user:blink → applab_app_logs ...

你：把 user:blink 拉到本地，把闪烁周期改成 250ms，推回去重启
DSH：applab_app_pull user:blink
     （本地编辑 %USERPROFILE%\.dsh\dsh-applab-bridge\workspaces\blink\python\main.py）
     applab_app_push user:blink（restart=true）
     applab_app_logs user:blink
```

拉下来的目录就是板上的 App 目录（`app.yaml`、`python/`、`sketch/`、`assets/`），DSH 的读写/搜索/编辑工具可以直接用。推回去之前建议先 `applab_app_stop`，避免容器正在读文件（不强制，CLI 会处理）。

## 设计取舍

- **为什么不用 App Lab 的 `http://localhost:8800`**：那是 App Lab 通过 SSH 隧道转发到板端 orchestrator 的临时端口，只在 App Lab 运行且选中板子时存在；它没有文件读写接口，做不了“改代码”。插件要的是长期可用、能改源码，所以直接对板子说话。
- **为什么是 adb 而不是 SSH**：App Lab 的 Connected Mode（USB）就是 adb，免密、无配置；SSH 只在网络模式用，而且密码无法非交互安全保存。网络模式见 Roadmap。
- **为什么输出多是原始表格**：`arduino-app-cli` 的表格式输出信息完整、随版本变化小；插件只做归一化包装（`ok`/`hint`/`timedOut`），不猜字段，避免 CLI 升级后解析崩掉。

## 已知限制

- 只支持 **USB + adb**（Connected Mode）。网络模式（SSH）未支持。
- 0.13 的 `app list --format json` 会漏掉 uninitialized/broken 的 App（实测 142 个少 7 个），插件以文本表格为主、JSON 只在解析失败时兜底。
- 0.13 里容器已经起来、日志写了 `App started` 后，`app list` 仍可能显示 `uninitialized`；启动判定以日志标记为准。
- `applab_app_logs --follow` 是“采集 N 秒后截断”，不是持久流。
- 内置示例（`examples:` / `release:`）只读：先 `applab_app_create` 用 `fromApp` 复制。
- 首次 `app start` 要编译 sketch / 拉容器，含 sketch 的冷启动约 3–5 分钟；插件在板端后台执行并轮询，不会因等待超时打断启动。
- 板子没有联网时，`app start` 里需要下载依赖的步骤会失败（日志里有 ERROR），这是板端环境问题，不是插件问题。
- 0.13 的 `model list` 在无网络时会长时间不返回（插件 20 秒超时并明确标记）。
- 0.13 的 `app destroy` 只清容器/缓存，**不删源码目录**；要彻底删除需自行 `rm -rf /home/arduino/ArduinoApps/<app>`。插件暂未封装删除。

## 安全

`applab_shell` 等价于板端任意命令执行。建议在 DSH 的权限预设（如 dsh-permgate 的「自定义审查」）里把 `applab_shell` 归到需要审批的一类；其余 `applab_*` 只读写 App 目录与运行态，风险低得多。

## 代码来源与审查

| 项目 | 说明 |
| --- | --- |
| 生成方式 | 代码由 **AI（DeepSeek Harness 内的 agent）** 在会话中生成：需求 → 设计 → 实现 → 测试脚本，均在同一会话内完成。 |
| 人工审查 | 提交者逐文件审查了：命令拼装与注入面（`lib/commands.js` 的引用与白名单校验）、adb 设备选择与超时/杀进程逻辑、配置读写与首次生成、工具描述与错误提示；确认无误后提交。 |
| 已验证 | 16 项单元测试（参数校验、shell 引用、设备解析、配置读写、进程超时、`app list` 表格/JSON 解析）+ 插件形状冒烟 + **真机全链路**：UNO Q（CLI 0.13.0）上 `doctor/status/apps_list/create/start/logs/details/pull/push/stop` 全部跑通；`app start` 冷启动约 6 秒（Python-only），日志出现 `App started`，`app list` 状态变 running。 |
| 未验证 | 0.14+ 的 `app ps` / `app details` / `app list --all` 分支没有实机（本机板子是 0.13）；网络模式（SSH）；Windows 以外的平台。 |
| 提交记录 | 首个功能提交的 message 中同样标注了 AI 生成与人工审查。 |

发现问题请开 issue；涉及板端行为的，请附上 `applab_doctor` 的输出和板端 `arduino-app-cli version`。

## 开发

```powershell
# 单元测试（纯函数 + 进程层，无需板子）
node --test test/unit.test.mjs

# 插件形状冒烟测试：需要一个 @deepseek-ai/dsh-tools 桩
#   node_modules/@deepseek-ai/dsh-tools/{package.json,index.js}
#   index.js: export const defineTool = (d) => d
node test/smoke.mjs
```

（宿主里 `@deepseek-ai/dsh-tools` 由 DSH 自己提供；桩只用于脱离宿主跑测试，装插件前要删掉 `node_modules`，否则会遮蔽真包。）

## Roadmap

- SSH / 网络模式（板子不在 USB 上时）
- 结构化 `app list`（等 CLI 提供 JSON 输出，或加一层解析）
- 串口监视器（`arduino-app-cli monitor`）与 App 端口查看（`app ports`）
- Brick 变量配置（`app brick config`）与模型安装（`model install`）专用工具
- 与 dsh-permgate 联动的默认权限分类

## License

[GPL-3.0](LICENSE)
