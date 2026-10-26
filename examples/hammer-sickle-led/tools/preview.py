#!/usr/bin/env python3
"""把 python/main.py 里的 FRAME 画成一张预览图（只在电脑上跑，不部署到板子）。

用法（需要 Pillow）：
    python tools/preview.py

输出 preview.png：每个 LED 一个圆点，亮度 0..7 映射到暖色。
"""

import ast
import re
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
MAIN = ROOT / "python" / "main.py"


def load_frame() -> list[list[int]]:
    text = MAIN.read_text(encoding="utf-8")
    match = re.search(r"FRAME = np\.array\(\s*(\[.*?\])\s*,\s*dtype", text, re.S)
    if not match:
        raise SystemExit("在 python/main.py 里找不到 FRAME = np.array([...])")
    return ast.literal_eval(match.group(1))


def main() -> None:
    frame = load_frame()
    rows, cols = len(frame), len(frame[0])
    cell, pad = 22, 12
    img = Image.new("RGB", (cols * cell + pad * 2, rows * cell + pad * 2), (8, 8, 10))
    draw = ImageDraw.Draw(img)
    for y, row in enumerate(frame):
        for x, value in enumerate(row):
            cx = pad + x * cell + cell // 2
            cy = pad + y * cell + cell // 2
            r = cell // 2 - 2
            if value == 0:
                draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(24, 24, 28))
            else:
                k = min(7, max(0, int(value))) / 7
                draw.ellipse(
                    [cx - r, cy - r, cx + r, cy + r],
                    fill=(int(255 * k), int(60 + 150 * k), int(40 + 60 * k)),
                )
    out = ROOT / "preview.png"
    img.save(out)
    print(f"saved {out} ({cols}x{rows})")


if __name__ == "__main__":
    main()
