#!/usr/bin/env python3
"""
Renders every PNG the app is installed from, from the shapes in public/favicon.svg.

    python3 scripts/make-icons.py

The mark is five rounded rectangles, so the files are drawn here rather than kept
as hand-made binaries: change the SVG, re-run this, and the icons cannot drift
apart. Sizes are not decoration. iOS installs from the 180px apple-touch-icon and
ignores the manifest's icon list; Android and desktop Chrome install from the
manifest and want a 192px and a 512px PNG marked "any", and prefer a separate
"maskable" pair so they can crop the icon to a circle or squircle without clipping
the artwork. The SVG is still there for the tab strip.

The maskable pair differs in two ways, both required by the spec: the background
runs to the edge of the canvas with no rounded corners, because the launcher
applies its own mask, and the artwork is scaled down and centred to stay inside the
safe zone — a circle of 80% diameter, so 40% of the side as a radius. The pavers
are 44 units wide and 38 tall, so a corner sits 1.32 times as far from the centre
as the half-width; sized at 58% of the canvas that corner lands at 0.38 of the
side, inside the limit. Re-run this after touching the artwork, and note that the
build step checks the manifest's icon list resolves — it cannot tell that an icon
is badly composed, only that it is there.
"""

from pathlib import Path
from PIL import Image, ImageDraw

VIEWBOX = 64.0
SUPER = 4  # draw big, shrink afterwards, so the corners stay smooth

BACKGROUND = (13, 17, 23, 255)  # #0d1117
ACCENT = (255, 139, 61)  # #ff8b3d

# x, y, w, h, alpha — as in the SVG, in the 64-unit space.
RECTS = [
    (10, 14, 20, 12, 1.00),
    (34, 14, 20, 12, 0.55),
    (10, 30, 20, 12, 0.55),
    (34, 30, 20, 12, 1.00),
    (10, 46, 44, 6, 0.35),
]
ART = (10, 14, 44, 38)  # left, top, width, height of the artwork's bounding box
CORNER = 12

# Where the artwork's centre sits in the 64-unit space, so it can be re-centred.
CENTRE = (ART[0] + ART[2] / 2, ART[1] + ART[3] / 2)

# Art width as a fraction of the canvas. The corner of the art is the point a
# circular mask clips first: at 58% fill its radius is sqrt(0.29² + 0.25²) = 0.38
# of the side, inside the 0.40 safe zone. At the 0.66 this started at it was 0.44 —
# the outer pavers would have lost their corners on any launcher that masks.
MASKABLE_FILL = 0.58


def render(size: int, *, maskable: bool) -> Image.Image:
    if maskable:
        scale = (MASKABLE_FILL * size / ART[2]) * SUPER
    else:
        scale = (size / VIEWBOX) * SUPER
    side = size * SUPER
    # Centre the artwork's own centre in the canvas when it has been scaled.
    off_x = (side / 2 - CENTRE[0] * scale) if maskable else 0.0
    off_y = (side / 2 - CENTRE[1] * scale) if maskable else 0.0

    image = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    if maskable:
        # The launcher crops this one, so the background must reach every corner.
        draw.rectangle((0, 0, side - 1, side - 1), fill=BACKGROUND)
    else:
        draw.rounded_rectangle(
            (0, 0, side - 1, side - 1), radius=CORNER * scale, fill=BACKGROUND
        )

    for x, y, w, h, alpha in RECTS:
        left = x * scale + off_x
        top = y * scale + off_y
        layer = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        ImageDraw.Draw(layer).rounded_rectangle(
            (left, top, left + w * scale, top + h * scale),
            radius=2 * scale,
            fill=(*ACCENT, round(alpha * 255)),
        )
        image = Image.alpha_composite(image, layer)

    return image.resize((size, size), Image.LANCZOS)


def main() -> None:
    out = Path("public")
    jobs = [
        ("apple-touch-icon.png", 180, False),  # iOS
        ("icon-192.png", 192, False),
        ("icon-512.png", 512, False),
        ("maskable-192.png", 192, True),
        ("maskable-512.png", 512, True),
    ]
    for name, size, maskable in jobs:
        image = render(size, maskable=maskable)
        path = out / name
        image.save(path, optimize=True)
        print(f"{path} {size}x{size}{' maskable' if maskable else ''}")


if __name__ == "__main__":
    main()
