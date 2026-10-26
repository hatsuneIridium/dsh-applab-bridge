# SPDX-FileCopyrightText: Copyright (C) Arduino s.r.l. and/or its affiliated companies
#
# SPDX-License-Identifier: MPL-2.0
"""在 Arduino UNO Q 板载 8x13 LED 点阵上显示镰刀锤子标志。

点阵由 MCU 侧 sketch 驱动（Arduino_LED_Matrix），Python 侧通过 Bridge
把一帧 8x13 的亮度矩阵发过去。亮度范围 0..7（sketch 里 setGrayscaleBits(3)），
0 = 灭，7 = 最亮。

帧数据的行是自上而下，列是自左向右；改下面的 FRAME 就能换图案。
"""

from arduino.app_utils import App, Bridge, Frame
import numpy as np

# 8 行 x 13 列。轮廓取自 Unicode U+262D（☭）的降采样，
# 再按点阵分辨率手工收边，保证 3 bit 灰阶下轮廓不断。
FRAME = np.array(
    [
        [0, 0, 0, 0, 7, 7, 7, 7, 7, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0, 7, 7, 7, 0, 0],
        [0, 0, 0, 0, 0, 7, 7, 7, 0, 7, 7, 0, 0],
        [0, 0, 0, 0, 7, 7, 7, 7, 0, 7, 7, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 7, 7, 7, 7, 0, 0],
        [0, 0, 7, 7, 7, 7, 7, 7, 7, 0, 7, 7, 0],
        [0, 7, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        [7, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    ],
    dtype=np.uint8,
)


def main():
    frame = Frame(FRAME)
    Bridge.call("draw", frame.to_board_bytes())
    # App.run() 保持 Python 进程存活；sketch 的 loop() 会持续把帧画到点阵上。
    App.run()


if __name__ == "__main__":
    main()
