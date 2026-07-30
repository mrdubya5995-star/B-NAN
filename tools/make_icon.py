#!/usr/bin/env python3
"""Renders web/assets/icons/banana-mark.svg (the single source of truth
for RetroBanana's icon) to every PNG size + favicon.ico + banana.icns the
app needs, using headless Chrome so each size gets a native, pixel-crisp
render rather than a blurry downscale.
"""
import os
import subprocess
import tempfile

from PIL import Image

HERE = os.path.dirname(__file__)
ICON_DIR = os.path.join(HERE, "..", "web", "assets", "icons")
SVG_PATH = os.path.join(ICON_DIR, "banana-mark.svg")
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

SIZES = [16, 32, 48, 64, 128, 180, 192, 256, 512, 1024]


def render_svg_to_png(svg_path, size, out_path):
    with open(svg_path, encoding="utf-8") as f:
        svg = f.read()
    html = f"""<!doctype html><html><head><style>
      html,body{{margin:0;padding:0;background:transparent;}}
      svg{{display:block;width:{size}px;height:{size}px;}}
    </style></head><body>{svg}</body></html>"""
    with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False) as f:
        f.write(html)
        html_path = f.name
    subprocess.run(
        [
            CHROME, "--headless", "--disable-gpu", "--no-sandbox",
            "--default-background-color=00000000",
            f"--screenshot={out_path}",
            f"--window-size={size},{size}",
            f"file://{html_path}",
        ],
        check=True, capture_output=True,
    )
    os.unlink(html_path)
    # Chrome's headless screenshot always includes the OS window chrome
    # sizing quirks; crop/pad to the exact requested square just in case.
    im = Image.open(out_path).convert("RGBA")
    if im.size != (size, size):
        im = im.resize((size, size), Image.LANCZOS)
        im.save(out_path)


def main():
    for s in SIZES:
        out = os.path.join(ICON_DIR, f"banana-{s}.png")
        render_svg_to_png(SVG_PATH, s, out)
        print("wrote", out)

    Image.open(os.path.join(ICON_DIR, "banana-512.png")).save(os.path.join(ICON_DIR, "banana-master.png"))
    Image.open(os.path.join(ICON_DIR, "banana-256.png")).save(os.path.join(ICON_DIR, "banana-mark.png"))

    ico_src = Image.open(os.path.join(ICON_DIR, "banana-256.png"))
    ico_src.save(
        os.path.join(ICON_DIR, "favicon.ico"),
        sizes=[(16, 16), (32, 32), (48, 48), (256, 256)],
    )

    print("Done.")


if __name__ == "__main__":
    main()
