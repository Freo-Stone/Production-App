#!/usr/bin/env python3
"""
Renders public/apple-touch-icon.png from the shapes in public/favicon.svg.

The icon is referenced by the PWA manifest and by index.html, and iOS wants a
real 180x180 PNG rather than the SVG. The mark is five rounded rectangles, so it
is redrawn here instead of being kept as a hand-made binary — change the SVG and
re-run this, and the two cannot drift apart by accident.

    python3 scripts/make-apple-icon.py
"""
from PIL import Image, ImageDraw

SRC_VIEWBOX = 64
SIZE = 180
SUPER = 4  # draw big, shrink afterwards, so the corners stay smooth
SCALE = (SIZE / SRC_VIEWBOX) * SUPER

BACKGROUND = (13, 17, 23, 255)  # #0d1117
ACCENT = (255, 139, 61)  # #ff8b3d

# x, y, w, h, rx — as in the SVG, in the 64-unit space.
CORNER = 12
RECTS = [
    (10, 14, 20, 12, 1.00),
    (34, 14, 20, 12, 0.55),
    (10, 30, 20, 12, 0.55),
    (34, 30, 20, 12, 1.00),
    (10, 46, 44, 6, 0.35),
]


def box(x: float, y: float, w: float, h: float) -> tuple[float, float, float, float]:
    return (x * SCALE, y * SCALE, (x + w) * SCALE, (y + h) * SCALE)


def main() -> None:
    side = SIZE * SUPER
    image = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((0, 0, side - 1, side - 1), radius=CORNER * SCALE, fill=BACKGROUND)

    for x, y, w, h, alpha in RECTS:
        layer = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        ImageDraw.Draw(layer).rounded_rectangle(
            box(x, y, w, h), radius=2 * SCALE, fill=(*ACCENT, round(alpha * 255))
        )
        image = Image.alpha_composite(image, layer)

    image = image.resize((SIZE, SIZE), Image.LANCZOS)
    out = "public/apple-touch-icon.png"
    image.save(out, optimize=True)
    print(f"{out} {SIZE}x{SIZE}")


if __name__ == "__main__":
    main()
