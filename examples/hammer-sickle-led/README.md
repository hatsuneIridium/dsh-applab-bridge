# 镰刀锤子 · UNO Q LED 点阵

在 Arduino UNO Q 板载 **8×13 LED 点阵**上显示一个镰刀锤子标志。Python 侧组帧，经 Bridge 发给 MCU 侧 sketch（`Arduino_LED_Matrix`）显示。

![预览](preview.png)

```
....#####....
........###..
.....###.##..
....####.##..
.......####..
..#######.##.
.##..........
##...........
```

> 104 个像素画不下完整徽记，这是按 Unicode `U+262D`（☭）降采样后手工收边的结果；实物上比放大预览更连贯。

## 点阵参数

| 项 | 值 |
| --- | --- |
| 尺寸 | 8 行 × 13 列（104 颗 LED） |
| 亮度 | 0–7（sketch 里 `setGrayscaleBits(3)`），0 = 灭 |
| 接口 | `Arduino_LED_Matrix` + Bridge RPC（`draw`） |

## 目录

```
app.yaml              App 元数据（名字 / 描述 / 图标）
python/main.py        帧数据 + 启动逻辑（改这里换图案）
sketch/sketch.ino     MCU 侧：初始化点阵，暴露 draw RPC
sketch/sketch.yaml    编译配置（arduino:zephyr）
tools/preview.py      在电脑上把帧画成 PNG（需要 Pillow）
preview.png           预览图
```

## 运行

已经部署到板子上（`user:hammer-sickle`），当前 running。重新部署：

```bash
# 1. 从官方示例建一个 App（带 sketch 和编译配置）
arduino-app-cli app new "Hammer Sickle" \
  --from-app examples:core-and-foundational/02-led-matrix/02-led-matrix-frame

# 2. 把本目录的 app.yaml 和 python/main.py 推上去
adb push app.yaml /home/arduino/ArduinoApps/hammer-sickle/app.yaml
adb push python/main.py /home/arduino/ArduinoApps/hammer-sickle/python/main.py
adb shell chown -R arduino:arduino /home/arduino/ArduinoApps/hammer-sickle

# 3. 启动（首次要编译 sketch，约 2–4 分钟）
arduino-app-cli app start user:hammer-sickle

# 停止 / 查看日志
arduino-app-cli app stop user:hammer-sickle
arduino-app-cli app logs user:hammer-sickle --tail 20
```

用 DSH 插件的话等价于：`applab_app_create`（fromApp 同上）→ `applab_app_push` → `applab_app_start`。

## 改图案

`python/main.py` 里的 `FRAME` 是 8 行 × 13 列的数组，行自上而下、列自左向右，值 0–7。改完跑：

```bash
python tools/preview.py   # 生成 preview.png 预览
```

再 `adb push` 回去并 `arduino-app-cli app restart user:hammer-sickle` 即可。

想加呼吸效果，把 `main()` 改成在 `App.run(user_loop=...)` 的循环里按正弦缩放 `FRAME` 再 `Bridge.call("draw", ...)`。

## 本机实测规格

| 项 | 实测 |
| --- | --- |
| 型号 | Arduino UnoQ（device-tree `arduino,imola`） |
| SoC | Qualcomm QRB2210，4× Kryo-V2（aarch64），Adreno 702 |
| 内存 | 4 GB LPDDR4（`MemTotal` 3.75 GiB，可用约 3.1 GiB） |
| 存储 | 32 GB eMMC（`lsblk` 29.1 GB）；根分区 9.8 GB，已用 6.7 GB / 剩 2.7 GB |
| Swap | 1.8 GiB |
| MCU | STM32U585（Cortex-M33，2 MB Flash / 786 KB SRAM，官方规格） |
| 系统 | Debian GNU/Linux 13 (trixie)，kernel 7.0.0 aarch64 |

## 来源与许可

- `sketch/`、目录结构与 `Frame` 用法来自 Arduino 官方示例 [`02-led-matrix-frame`](examples:core-and-foundational/02-led-matrix/02-led-matrix-frame)（MPL-2.0）。
- `python/main.py` 的帧数据与本文档是本目录自己的改动；**本目录按 MPL-2.0 发布**，见 [LICENSE](LICENSE)。仓库其余部分（插件本体）仍按 GPL-3.0。
- 代码由 AI（DeepSeek Harness）生成，经人工审查后提交；实机在 UNO Q（CLI 0.13.0）上启动验证。

## 用插件跑这个示例

这个 App 同时也充当 `dsh-applab-bridge` 的真机测试程序：

```text
applab_app_create  name="Hammer Sickle Test"
                   fromApp="examples:core-and-foundational/02-led-matrix/02-led-matrix-frame"
applab_app_push    id="user:hammer-sickle-test"  dir="<repo>/examples/hammer-sickle-led"
applab_app_start   id="user:hammer-sickle-test"
applab_app_logs    id="user:hammer-sickle-test"
```

> `applab_app_push` 会按目录名推到 `user:<目录名>`；想用别的 App 名，先把目录复制/改名，或直接用 `adb push` 覆盖 `app.yaml` 与 `python/main.py`。


