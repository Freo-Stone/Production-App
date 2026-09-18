# The shop's brand

The app is painted in the colours of the shop's own paving logo, and the artwork in
it is the logo, not a drawing of it.

```
brand/freo-stone-paving.jpg   the logo as the shop has it, kept in this repository
scripts/make-brand.py         measures that file and draws everything else from it
public/, src/assets/          what the script writes — do not hand-edit these
```

Nothing about the palette was picked by eye. The script counts the pixels of the logo
and takes the four colours that are actually in it, and the numbers below were
measured from the stylesheet the same way `test/brand.test.ts` measures them.

## The four colours in the logo

| Colour | Hex | Share of the artwork | Where it turns up |
| --- | --- | --- | --- |
| Block blue | `#0076C0` | 17% | the bars, the panel, the app's accent |
| Corner red | `#EF3E34` | 2.3% | the four corner blocks, the short-stock red |
| Foot charcoal | `#231F20` | 7.8% | the PAVING foot, and what the dark theme's darks are made of |
| Card white | `#FFFFFF` | 19.6% | the card the blocks sit on, the lettering |

## How those four become a theme

A logo is coloured ink on white paper. An app that is read outdoors in sun and at
night in a yard is mostly light-on-dark, so the lightness has to move. **The hue does
not move.** That is the whole rule, and it is the one `test/brand.test.ts` enforces:
every blue in the theme is within 4° of the logo's blue, every red within 4° of the
logo's red, and anything that carries text clears 4.5:1 on the canvas it actually
sits on.

| Token | Dark | On its canvas | Light | On its canvas |
| --- | --- | --- | --- | --- |
| `--color-accent` | `#3D9ADC` | 6.2 | `#0070B8` | 4.8 |
| `--color-accentink` | `#08202E` | 5.5 on the accent | `#FFFFFF` | 5.2 on the accent |
| `--color-short` | `#EF3E34` | 4.9 | `#C22B22` | 5.3 |
| `--color-info` | `#3D9ADC` | 6.2 | `#0070B8` | 4.8 |
| `--color-canvas` | `#0D1117` | — | `#F4F6F8` | — |
| `--color-ink` | `#E8EDF2` | 16.1 | `#10161D` | 16.8 |

Three of those steps are the rule doing work, and each is written down where the
colour is:

- The logo's blue on the dark canvas is **3.9:1**. That is a fine block of colour and
  a poor 12px label, so the dark theme's accent is the same hue lifted until it
  reads: 6.2:1.
- The logo's blue on this light theme's canvas is **4.45:1** — just under. The light
  theme uses it one step darker, at 4.8:1, which is a blue nobody can tell from the
  logo's.
- The logo's red is **4.9:1 on the dark canvas** and so is used exactly, but only
  **3.6:1 on the light one**, where it comes down to `#C22B22` at 5.3:1.

White on the logo's own blue is 4.8:1, which is why a filled button in the light
theme carries white text and the dark theme's filled button carries the charcoal
navy instead.

Not everything is brand, deliberately:

- **The stage colours** (`--color-stage-*`, for the production board that is not
  built yet) are their own seven-step scale. Seven stages in two brand colours would
  be unreadable, and inventing a brand scale before the board exists would be a
  guess.
- **The neutrals** stay the cool greys they were, except the light theme's faintest
  text, `--color-ink3`, which was failing on its own canvas at 3.4:1 and now sits at
  4.9:1.

## The artwork, and what uses it

| File | What it is | Where it is used |
| --- | --- | --- |
| `src/assets/logo.png` | the logo itself, cleaned: the four palette colours only, the white card made transparent so the lettering inside it survives | the screen before you sign in, at 64px |
| `src/assets/logo-mark.svg` | the block device with no lettering: eight rectangles in a 64-unit box | the header tile, at 28px |
| `public/favicon.svg` | the same eight rectangles, byte for byte | the browser tab |
| `public/icon-192.png`, `icon-512.png` | the logo's white card with the device inside it | an installed app |
| `public/maskable-192.png`, `maskable-512.png` | the same, with the device at 56% of the canvas | launchers that crop |
| `public/apple-touch-icon.png` | 180px, no rounding, because iOS rounds it | "Add to Home Screen" |

The mark carries no lettering because lettering at 28px is mush; the shapes are what
carry the shop at that size. Where there is room to be read — the first screen on a
device that has never opened the app — the real logo is used.

Both icon kinds are the logo's **white card** with the blocks inside it, rather than
the blocks bleeding to the edge. Two reasons: it is what the logo looks like, and it
means no launcher and no corner rounding can cut a block in half. The maskable pair
puts the device at 56% of the canvas for the same reason — a square device's corner
sits 0.707 times its own width from the centre, so at 56% of the canvas that corner
lands at 0.40 of the side, which is exactly the edge of the safe circle. At the 62%
this started at, the red corner blocks lost their points.

The strip the app sits in — a tab's frame, an installed window's title bar, a phone's
status bar — is `#0076C0` in both themes, and in the manifest too. It is the one
piece of chrome that is the shop rather than the screen, so it does not follow the
theme. The splash colour an installer shows is the dark canvas instead, because that
is the colour the app opens on.

## Changing it

```
pnpm run brand     # python3 scripts/make-brand.py
```

Drop a new logo at `brand/freo-stone-paving.jpg` and run it. The script is not
patient about a logo that has different colours in it: it counts the blue, charcoal
and red pixels first and stops with a message telling you what it measured, because
the silent failure here is a script drawing last year's logo forever from a file
nobody looked at. `test/brand.test.ts` then holds the theme to whatever the script
measured — so the palette in `theme.css` and the palette in the artwork move
together, or a test fails.

## Checks

- `test/brand.test.ts` — 8 tests: the logo measures as the four colours, every blue
  and red in both themes is on the logo's hue, the lightness moves the way the rule
  says, every text colour clears 4.5:1 on its own canvas (and status colours clear
  3:1 on their own wash), the artwork files exist, the tab icon is drawn in the
  logo's colours and nothing else, the header tile and the tab icon are the same
  drawing, and the installed chrome is the brand blue.
- `e2e/brand.spec.ts` — 3 tests × 3 browser projects: the logo *decodes* before
  sign-in and lands in a square box, the header's mark decodes too, and what the
  browser and an installer are told over HTTP is the shop's blue — the manifest's
  chrome colour, the splash colour, the favicon's fills, the icon files answering
  200, and the theme-colour in both themes.
- `scripts/check-build.mjs` — 6 of its 33 checks: the manifest's chrome and splash
  colours, the tab icon's fills and its intrinsic size, and that the logo and the
  mark reached the bundle whether inlined or emitted as files.
