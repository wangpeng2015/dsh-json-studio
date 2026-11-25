"""Generate the committed OCR fixtures for json-studio.

Run with the bundled Python (Pillow 12):
  C:\\Users\\ygt\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe scripts/make-ocr-fixtures.py

Outputs (test/fixtures/ocr/):
  json-clean-900x420.png    clean dark-on-white pretty JSON screenshot
  json-ide-1920x1080.png    VSCode-ish dark IDE screenshot with line numbers
  json-chinese.png          Chinese + JSON mixed screenshot (white theme)
  json-lowres-600w.png      600px-wide low-resolution downscale

The generator is deterministic: same Pillow/fonts -> same PNG bytes, so the
fixtures can be regenerated and diffed.
"""
from __future__ import annotations

import os
import re
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "test" / "fixtures" / "ocr"

CONSOLAS = r"C:\Windows\Fonts\consola.ttf"
CONSOLAS_BOLD = r"C:\Windows\Fonts\consolab.ttf"
MSYH = r"C:\Windows\Fonts\msyh.ttc"

CLEAN_JSON = '''{
  "name": "json-studio",
  "version": "1.0.0",
  "active": true,
  "list": [1, 2, 3],
  "tags": ["ocr", "json"],
  "meta": { "author": "lead" }
}'''

IDE_JSON = '''{
  "id": 1024,
  "name": "json-studio",
  "kind": "panel",
  "enabled": true,
  "items": [
    { "key": "alpha", "value": 1 },
    { "key": "beta", "value": 2 }
  ],
  "meta": {
    "author": "lead",
    "version": "1.0.0",
    "list": ["ocr", "json", "ui"]
  }
}'''

CHINESE_JSON = '''{
  "标题": "数据报告",
  "状态": "成功",
  "说明": "这是一份 JSON 测试",
  "数量": 42,
  "list": [1, 2, 3]
}'''


def font(path: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(path, size)


def draw_plain(lines: str, size: int, line_height: int, width: int, height: int,
               margin: tuple[int, int] = (32, 36)) -> Image.Image:
    img = Image.new("RGB", (width, height), "#ffffff")
    draw = ImageDraw.Draw(img)
    f = font(CONSOLAS, size)
    x, y = margin
    for line in lines.split("\n"):
        draw.text((x, y), line, font=f, fill="#1a1a1a")
        y += line_height
    return img


def draw_chinese(lines: str, width: int = 1000, height: int = 520) -> Image.Image:
    img = Image.new("RGB", (width, height), "#ffffff")
    draw = ImageDraw.Draw(img)
    f = font(MSYH, 30)
    x, y = 40, 34
    for line in lines.split("\n"):
        draw.text((x, y), line, font=f, fill="#111111")
        y += 42
    return img


TOKEN_RE = re.compile(
    r'("(?:[^"\\]|\\.)*")|(-?\d+(?:\.\d+)?)|(\btrue\b|\bfalse\b|\bnull\b)|([{}\[\]:,])|(\s+)|(.)'
)
KEY_COLOR = "#9cdcfe"
STRING_COLOR = "#ce9178"
NUMBER_COLOR = "#b5cea8"
LITERAL_COLOR = "#569cd6"
PUNCT_COLOR = "#d4d4d4"
DEFAULT_COLOR = "#d4d4d4"
BG = "#1e1e1e"
GUTTER_BG = "#252526"
GUTTER_LINE = "#3c3c3c"
LINENO_COLOR = "#858585"


def draw_ide(lines: str, width: int = 1920, height: int = 1080, size: int = 26,
             line_height: int = 34, top: int = 70, gutter_w: int = 96) -> Image.Image:
    """Render `lines` as a VSCode-ish dark editor screenshot with line numbers."""
    img = Image.new("RGB", (width, height), BG)
    draw = ImageDraw.Draw(img)
    code_x = gutter_w + 18
    f = font(CONSOLAS, size)
    fnum = font(CONSOLAS, size - 2)

    draw.rectangle([0, 0, gutter_w, height], fill=GUTTER_BG)

    y = top
    for lineno, line in enumerate(lines.split("\n"), start=1):
        draw.text((28, y + 1), str(lineno).rjust(3), font=fnum, fill=LINENO_COLOR)
        x = code_x
        for m in TOKEN_RE.finditer(line):
            token = m.group(0)
            if token == "":
                continue
            if m.group(1):  # quoted string; is it a key?
                rest = line[m.end():].lstrip()
                color = KEY_COLOR if rest.startswith(":") else STRING_COLOR
            elif m.group(2):
                color = NUMBER_COLOR
            elif m.group(3):
                color = LITERAL_COLOR
            elif m.group(4):
                color = PUNCT_COLOR
            else:
                color = DEFAULT_COLOR
            draw.text((x, y), token, font=f, fill=color)
            x += draw.textlength(token, font=f)
        y += line_height

    draw.line([(gutter_w, 0), (gutter_w, height)], fill=GUTTER_LINE, width=1)
    return img


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    if not os.path.exists(CONSOLAS):
        raise SystemExit(f"missing font: {CONSOLAS}")

    clean = draw_plain(CLEAN_JSON, size=28, line_height=36, width=900, height=420,
                       margin=(36, 40))
    clean.save(OUT / "json-clean-900x420.png", optimize=True)

    ide = draw_ide(IDE_JSON)
    ide.save(OUT / "json-ide-1920x1080.png", optimize=True)

    chinese = draw_chinese(CHINESE_JSON)
    chinese.save(OUT / "json-chinese.png", optimize=True)

    # Low-resolution variant: downscale the clean screenshot to 600px wide.
    low = clean.resize((600, round(clean.height * 600 / clean.width)), Image.LANCZOS)
    low.save(OUT / "json-lowres-600w.png", optimize=True)

    for p in sorted(OUT.glob("*.png")):
        im = Image.open(p)
        print(f"{p.name}: {im.width}x{im.height} {p.stat().st_size} bytes")


if __name__ == "__main__":
    main()
