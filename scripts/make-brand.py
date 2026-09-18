#!/usr/bin/env python3
"""
Everything the shop's brand ships from, from one file: `brand/freo-stone-paving.jpg`.

    python3 scripts/make-brand.py
    # or: pnpm run brand

It writes the logo and the header's mark into `src/assets/`, where the bundler can
see them and give them a hashed, base-path-correct URL, and it writes
`public/favicon.svg` plus the five PNGs an installed app is built from, which have to
keep their names because that is what the manifest and iOS point at.

Nothing in here is a drawing of the logo. The palette is sampled out of the file, the
geometry of the block device is measured off it, and the script stops with what it
measured if the file it is given has different colours in it — because the quiet
failure here is this script drawing last year's logo forever from a file nobody
looked at, while every check that only asks whether a file exists keeps passing.

Three pieces, for three jobs:

* `src/assets/logo.png` — the logo itself, cleaned. The source is a JPEG, so every
  pixel is pulled to the nearest of the four colours the logo actually uses and edges
  are un-mixed from white, which is what the artefacts are. Only the white *around*
  the artwork becomes transparent — a flood fill in from the edge of the sheet, not a
  colour test — because the letters are white too and a colour test would leave holes
  in the word FREO.
* `src/assets/logo-mark.svg` / `public/favicon.svg` — the block device without the
  lettering: red corner blocks, blue bars, charcoal foot. Lettering is mush at 16px
  and 28px, which is where these are used, so the shapes carry the brand there. Both
  are the same eight rectangles, from one list (`PARTS` below).
* The icon PNGs — rendered from those same parts, as the logo's own white card with
  the device inside it. That is what the logo looks like, and it means no launcher and
  no corner rounding can cut a block in half. Sizes are not decoration either: iOS
  installs from the 180px apple-touch-icon and ignores the manifest's icon list;
  Android and desktop Chrome install from the manifest and want a 192px and a 512px
  PNG marked "any", and prefer a separate "maskable" pair so a launcher can crop the
  icon to a circle or squircle. The maskable pair differs in two required ways: its
  background runs to every corner, because the launcher paints its own mask over it,
  and the device sits smaller, inside the safe zone — a circle 80% of the canvas
  across — because the red corner blocks are exactly what a crop would eat.
  `scripts/check-build.mjs` checks the manifest's icon list resolves; it cannot tell
  that an icon is badly composed, which is why composition is reasoned about here
  instead.
"""

from collections import Counter, deque
from pathlib import Path

from PIL import Image, ImageDraw

SOURCE = Path("brand/freo-stone-paving.jpg")
OUT = Path("public")  # what an installer fetches by name
ASSETS = Path("src/assets")  # what the app imports

# Sampled from the source, not from a design file. Percentages in brackets are how
# much of the sheet each one covers, and the script re-checks them before drawing.
BLUE = (0, 118, 192)  # #0076C0  17%   the block
RED = (239, 62, 52)  # #EF3E34  2.3%  the corner blocks
INK = (35, 31, 32)  # #231F20  7.8%  the PAVING foot
WHITE = (255, 255, 255)  # 20%   the card, and the lettering
PALETTE = [BLUE, RED, INK, WHITE]

# The device, measured off the source in its pixel space and then reduced to a
# 64-unit canvas. Each entry is (name, left, top, width, height, colour) in the
# artwork's own space, where the artwork is the 364px square the sheet contains.
ART = 364
PARTS = [
    ("corner", 0, 0, 45, 46, RED),
    ("bar", 54, 0, 256, 46, BLUE),
    ("corner", 319, 0, 45, 46, RED),
    ("panel", 0, 54, 364, 179, BLUE),
    ("corner", 0, 240, 45, 46, RED),
    ("bar", 54, 240, 256, 46, BLUE),
    ("corner", 319, 240, 45, 46, RED),
    ("foot", 0, 294, 364, 70, INK),
]
UNIT = 64.0 / ART
SUPER = 4  # draw big and shrink afterwards, so the edges stay smooth
CORNER = 12  # canvas corner radius, in 64-unit space, for the non-maskable icons

# How much of the canvas the device covers. Both figures come off one rule: the icon
# is the logo's own white card with the blocks inside it, so no launcher and no
# rounding ever cuts a block. A device is a square, so its corner sits 0.707 times
# its own width from the centre; at 0.56 of the canvas that corner lands at 0.40 of
# the side, which is exactly the maskable safe zone of an 80% circle. At the 0.62
# this started at, the red corner blocks lost their points on any launcher that crops.
CARD_FILL = 0.88
MASKABLE_FILL = 0.56

# Where the source's artwork starts, so the PNG can be trimmed without eating it.
MARGIN = 12


def check_source(im: Image.Image) -> None:
    """The drawing is only honest if the file it came from still says so."""
    counts = Counter(im.resize((im.width // 4, im.height // 4), Image.BOX).get_flattened_data())
    total = sum(counts.values())

    def share(colour, within=28):
        return (
            sum(n for p, n in counts.items() if all(abs(p[i] - colour[i]) <= within for i in range(3)))
            / total
        )

    # The palette has to still be the palette. A re-export with a different blue is
    # a signal to re-measure, not to keep shipping the old one.
    for colour, minimum in ((BLUE, 0.10), (INK, 0.04), (RED, 0.01)):
        got = share(colour)
        if got < minimum:
            raise SystemExit(
                f"{SOURCE}: {'#%02X%02X%02X' % colour} covers {got:.1%}, expected at least "
                f"{minimum:.0%}. Re-measure the palette and the block geometry before drawing."
            )


def clean(im: Image.Image) -> Image.Image:
    """Pull the sheet to its four colours, with the card's surroundings removed."""
    src = im.convert("RGB")
    w, h = src.size
    pixels = src.load()
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    target = out.load()

    for y in range(h):
        for x in range(w):
            p = pixels[x, y]
            # The sheet is flat colour laid over white, so a pixel between two of
            # them is explained by one of them at partial coverage. Un-mixing from
            # white and keeping the colour that explains it best is what removes the
            # JPEG fringe instead of posterising it into visible steps.
            best = None
            for colour in PALETTE:
                d = [255 - c for c in colour]
                denom = sum(v * v for v in d)
                a = 1.0 if denom == 0 else sum((255 - p[i]) * d[i] for i in range(3)) / denom
                a = max(0.0, min(1.0, a))
                residual = sum((p[i] - (255 - a * d[i])) ** 2 for i in range(3))
                if best is None or residual < best[0]:
                    best = (residual, colour, a)
            residual, colour, a = best
            # A near-white pixel is also "charcoal, 0.5% coverage" as far as the
            # arithmetic is concerned, and that answer wins by a hair on a JPEG of a
            # white card. Coverage that thin is the card, not the ink.
            if a < 0.15:
                colour = WHITE
            target[x, y] = (*colour, 255)

    # The white that the artwork sits on is not part of it, so it goes. A colour
    # test alone would do that to the lettering too — FREO, STONE and PAVING are
    # white on a dark block — so only the white a finger could reach from the edge
    # of the sheet is taken out. Whatever white is enclosed stays.
    white = [[target[x, y][:3] == WHITE for x in range(w)] for y in range(h)]
    seen = [[False] * w for _ in range(h)]
    queue = deque(
        [(x, y) for x in range(w) for y in (0, h - 1) if white[y][x]]
        + [(x, y) for y in range(h) for x in (0, w - 1) if white[y][x]]
    )
    while queue:
        x, y = queue.popleft()
        if x < 0 or y < 0 or x >= w or y >= h or seen[y][x] or not white[y][x]:
            continue
        seen[y][x] = True
        queue.extend(((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)))
    for y in range(h):
        for x in range(w):
            if seen[y][x]:
                target[x, y] = (*WHITE, 0)

    # The alpha band, not the image: getbbox on an RGBA sheet measures luminance,
    # and a transparent white counts as content there.
    box = out.split()[3].getbbox()
    return out.crop(
        (
            max(0, box[0] - MARGIN),
            max(0, box[1] - MARGIN),
            min(w, box[2] + MARGIN),
            min(h, box[3] + MARGIN),
        )
    )


def make_logo(cleaned: Image.Image) -> None:
    # Kept at its drawn size. The sheet is about 390px; the sign-in screen shows it
    # at 76px, so it stays sharp on a 2x phone screen and there is no point inventing
    # detail by upscaling.
    path = ASSETS / "logo.png"
    cleaned.save(path, optimize=True)
    print(f"{path} {cleaned.width}x{cleaned.height}")


def rect(part, scale=UNIT, dx=0.0, dy=0.0):
    _, x, y, w, h, colour = part
    return (x * scale + dx, y * scale + dy, (x + w) * scale + dx, (y + h) * scale + dy), colour


def svg(purpose: str) -> str:
    """The device as vectors, in the same 64-unit space the PNGs are drawn in."""
    shapes = "\n".join(
        f'  <rect x="{left:.2f}" y="{top:.2f}" width="{right - left:.2f}" height="{bottom - top:.2f}" '
        f'fill="#{c[0]:02X}{c[1]:02X}{c[2]:02X}" />'
        for (left, top, right, bottom), c in (rect(p) for p in PARTS)
    )
    note = (
        f"  <!-- {purpose} Blue bars with red corners on a charcoal foot, measured from\n"
        "       brand/freo-stone-paving.jpg by scripts/make-brand.py. No lettering: it turns\n"
        "       to mush at the 16px a browser tab offers, which is where these are used. -->"
    )
    # width/height on the root, not just a viewBox: a small SVG is inlined into the
    # bundle as a data URI by the bundler, and one without intrinsic size reports no
    # size to the page — which is how a logo that loaded perfectly can measure 0×0.
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" '
        'role="img" aria-label="Freo Stone Paving">\n'
        f"{note}\n{shapes}\n</svg>\n"
    )


def make_svg_mark() -> None:
    for folder, name, purpose in (
        (OUT, "favicon.svg", "The browser tab and the manifest's scalable icon."),
        (ASSETS, "logo-mark.svg", "The tile in the app's own header, where 28px is all there is."),
    ):
        path = folder / name
        path.write_text(svg(purpose), encoding="utf-8")
        print(f"{path}")


def render_icon(size: int, *, maskable: bool) -> Image.Image:
    """The logo's white card, with the device inside it, at a launcher size."""
    side = size * SUPER
    fill = MASKABLE_FILL if maskable else CARD_FILL
    # Both kinds are the card. The maskable pair only differs in that it has to run
    # its background to every corner — the launcher paints its own mask over it — and
    # keep the device inside the safe circle, which is what the smaller fill is for.
    image = Image.new("RGBA", (side, side), (*WHITE, 255))
    scale = (fill * side) / ART
    offset = (side - ART * scale) / 2

    draw = ImageDraw.Draw(image)
    for part in PARTS:
        (left, top, right, bottom), colour = rect(part, scale, offset, offset)
        draw.rectangle((left, top, right, bottom), fill=(*colour, 255))

    if not maskable:
        # CORNER is in the 64-unit canvas, so it scales with the canvas and not with
        # the artwork inside it. iOS rounds this file again, which costs nothing.
        canvas = Image.new("L", (side, side), 0)
        ImageDraw.Draw(canvas).rounded_rectangle(
            (0, 0, side - 1, side - 1), radius=CORNER * (side / 64.0), fill=255
        )
        image.putalpha(canvas)

    return image.resize((size, size), Image.LANCZOS)


def main() -> None:
    if not SOURCE.exists():
        raise SystemExit(f"{SOURCE} is missing. Every brand asset is drawn from it.")
    source = Image.open(SOURCE)
    check_source(source)

    ASSETS.mkdir(parents=True, exist_ok=True)
    cleaned = clean(source)
    make_logo(cleaned)
    make_svg_mark()

    for name, size, maskable in (
        ("apple-touch-icon.png", 180, False),  # iOS
        ("icon-192.png", 192, False),
        ("icon-512.png", 512, False),
        ("maskable-192.png", 192, True),
        ("maskable-512.png", 512, True),
    ):
        image = render_icon(size, maskable=maskable)
        path = OUT / name
        image.save(path, optimize=True)
        print(f"{path} {size}x{size}{' maskable' if maskable else ''}")


if __name__ == "__main__":
    main()
