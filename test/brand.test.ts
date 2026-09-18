import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The brand is the shop's logo, so none of these numbers are this file's invention.
 *
 * Two things are held here because both fail quietly anywhere else:
 *
 * 1. The colours the app paints with are still the logo's colours. `scripts/make-brand.py`
 *    measures its palette out of `brand/freo-stone-paving.jpg`, and the theme keeps
 *    the same hue while stepping the lightness where a screen needs it. If someone
 *    later drops in a blue that merely looks similar, the app and its icons have
 *    quietly stopped being the shop's, which is the whole point of the change.
 * 2. The colours are still readable. This is used outdoors, in sun, on a phone, with
 *    gloves on. Every colour that carries text is measured against the canvas it
 *    actually sits on, at WCAG AA — which is why the dark theme's blue is lighter
 *    than the logo's and the light theme's red is darker. `docs/brand.md` carries the
 *    table this produces.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const css = readFileSync(`${root}/src/styles/theme.css`, 'utf8');
const script = readFileSync(`${root}/scripts/make-brand.py`, 'utf8');

const THEME = css.indexOf('@theme {');
/** The selector is named in the header comment too, so it is looked for after it. */
const LIGHT = css.indexOf("html[data-theme='light']", THEME);

/** The palette `scripts/make-brand.py` measures out of the logo, as hex. */
function logoPalette(): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of script.matchAll(/^(BLUE|RED|INK|WHITE) = \((\d+), (\d+), (\d+)\)/gm)) {
    const [, name, r, g, b] = match;
    if (name && r && g && b) {
      found[name.toLowerCase()] =
        `#${[Number(r), Number(g), Number(b)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    }
  }
  return found;
}

/**
 * The colour a token is given in one of the two themes, following `var()` through:
 * `--color-short` *is* `var(--color-brandred)` on purpose, so the red in the app is
 * one decision rather than two that can disagree.
 */
function token(theme: 'dark' | 'light', name: string): string {
  const section = theme === 'dark' ? css.slice(THEME, LIGHT) : css.slice(LIGHT);
  const indirect = new RegExp(`--color-${name}:\\s*var\\(--color-([a-z-]+)\\)`, 'i').exec(section);
  if (indirect?.[1]) return token(theme, indirect[1]);
  const match = new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(section);
  if (!match?.[1]) throw new Error(`--color-${name} is not a colour in the ${theme} theme`);
  return match[1].toLowerCase();
}

/** The part of the stylesheet one theme owns. */
function block(theme: 'dark' | 'light'): string {
  return theme === 'dark' ? css.slice(THEME, LIGHT) : css.slice(LIGHT);
}

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
}

/** WCAG 2.1 relative luminance. */
function luminance(hex: string): number {
  // WCAG's own piecewise sRGB ramp, then the standard luminosity weights.
  const lin = (c: number): number => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = channels(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2.1 contrast ratio: 1 is identical, 21 is black on white. */
function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Hue in degrees, because "the logo's blue" is a hue rather than one exact hex. */
function hue(hex: string): number {
  const [r, g, b] = channels(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return 0;
  const step = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return step * 60;
}

/** Shortest distance between two hues, so 359° and 1° are 2° apart. */
function hueApart(a: string, b: string): number {
  const d = Math.abs(hue(a) - hue(b));
  return Math.min(d, 360 - d);
}

/** The colour a translucent status wash actually lands on, composited by hand. */
function tinted(theme: 'dark' | 'light', name: string, onto: string): string | null {
  const wash = new RegExp(
    `--color-${name}bg:\\s*rgba\\(\\s*([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)\\s*\\)`,
    'i',
  ).exec(block(theme));
  const [, r, g, b, a] = (wash ?? []).slice(1).map(Number);
  if (!r || !g || !b || a === undefined) return null;
  const part = (channel: number, i: number): string => {
    const base = Number.parseInt(onto.slice(1 + i * 2, 3 + i * 2), 16);
    return Math.round(a * channel + (1 - a) * base)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${part(r, 0)}${part(g, 1)}${part(b, 2)}`;
}

describe('the app is painted in the shop\'s own colours', () => {
  it('measures the logo as the four colours it is made of', () => {
    const palette = logoPalette();
    expect(Object.keys(palette).sort()).toEqual(['blue', 'ink', 'red', 'white']);
    expect(palette.blue).toBe('#0076c0');
    expect(palette.red).toBe('#ef3e34');
    expect(palette.ink).toBe('#231f20');
  });

  it('keeps every blue and red on the logo hue', () => {
    const palette = logoPalette();
    const blue = palette['blue'] ?? 'not a colour';
    const red = palette['red'] ?? 'not a colour';
    for (const theme of ['dark', 'light'] as const) {
      // Lightness may move — it has to, to read on a dark canvas or on paper. Hue may
      // not: that is the part a person recognises as the shop's.
      for (const name of ['accent', 'info']) {
        expect(hueApart(token(theme, name), blue), `${theme} --color-${name} against the logo's blue`).toBeLessThan(4);
      }
      expect(hueApart(token(theme, 'short'), red), `${theme} short-stock red against the logo's red`).toBeLessThan(4);
    }
  });

  it('steps the lightness where a screen needs it, and says so', () => {
    const palette = logoPalette();
    const blue = palette['blue'] ?? 'not a colour';
    const red = palette['red'] ?? 'not a colour';
    // The logo is coloured ink on white paper; the app is light-on-dark most of the
    // day. Copying the ink straight across is what fails outdoors, in sun.
    expect(luminance(token('dark', 'accent'))).toBeGreaterThan(luminance(blue));
    expect(luminance(token('light', 'accent'))).toBeLessThanOrEqual(luminance(blue));
    expect(luminance(token('light', 'short'))).toBeLessThan(luminance(red));
    // On the dark canvas the logo's red reads on its own, so it is used exactly.
    expect(token('dark', 'short')).toBe(red);
  });

  it('keeps anything that carries text at 4.5:1 on the canvas it sits on', () => {
    for (const theme of ['dark', 'light'] as const) {
      const canvas = token(theme, 'canvas');
      // 4.5:1 is WCAG AA for body text. The body text here is 14px and the labels are
      // 12px, on a phone, outside — so AA is the floor, not the goal.
      for (const name of ['ink', 'ink2', 'ink3', 'accent', 'short', 'info', 'curing', 'warn']) {
        const value = token(theme, name);
        expect(contrast(value, canvas), `${theme} --color-${name} (${value}) on ${canvas}`).toBeGreaterThanOrEqual(4.5);
      }
      // Whatever is written on a filled accent button has to read too.
      expect(contrast(token(theme, 'accentink'), token(theme, 'accent'))).toBeGreaterThanOrEqual(4.5);
      // Status colours also sit on their own wash rather than on bare canvas. A wash
      // lifts the bed, so the pair is measured on the lifted bed.
      for (const name of ['short', 'curing', 'warn']) {
        const bed = tinted(theme, name, canvas);
        if (!bed) continue;
        expect(contrast(token(theme, name), bed), `${theme} ${name} on its own wash`).toBeGreaterThanOrEqual(3);
      }
    }
  });
});

describe('the brand artwork is the logo, not a drawing of it', () => {
  it('ships every file the app and an installer are pointed at', () => {
    for (const file of [
      'brand/freo-stone-paving.jpg',
      'src/assets/logo.png',
      'src/assets/logo-mark.svg',
      'public/favicon.svg',
      'public/apple-touch-icon.png',
      'public/icon-192.png',
      'public/icon-512.png',
      'public/maskable-192.png',
      'public/maskable-512.png',
    ]) {
      expect(existsSync(`${root}/${file}`), file).toBe(true);
    }
  });

  it('draws the tab icon in the logo colours and nothing else', () => {
    // The icons come off the same measurements as the header's mark, so a colour in
    // this file that is not the logo's means somebody drew one of them by hand.
    const svg = readFileSync(`${root}/public/favicon.svg`, 'utf8');
    const fills = [...svg.matchAll(/fill="(#[0-9a-f]{6})"/gi)].map((m) => m[1]?.toLowerCase());
    expect(fills.length).toBeGreaterThan(4);
    const palette = Object.values(logoPalette());
    for (const fill of fills) {
      expect(palette, `favicon.svg fills with ${fill}`).toContain(fill);
    }
  });

  it('makes the header tile and the tab icon the same drawing', () => {
    const rects = (s: string): string => [...s.matchAll(/<rect[^>]*>/g)].map((m) => m[0]).join('\n');
    expect(rects(readFileSync(`${root}/src/assets/logo-mark.svg`, 'utf8'))).toBe(
      rects(readFileSync(`${root}/public/favicon.svg`, 'utf8')),
    );
  });

  it('names the shop the way the shop is named, and dresses the chrome in its blue', () => {
    const shell = readFileSync(`${root}/src/app/Brand.tsx`, 'utf8');
    expect(shell).toContain('Freo Stone');
    expect(shell).toContain('Freo Stone Paving');
    const vite = readFileSync(`${root}/vite.config.ts`, 'utf8');
    expect(vite).toContain("name: 'Freo Stone Production'");
    // An installed window's title bar and a phone's status bar wear the logo's blue.
    expect(vite).toContain("theme_color: '#0076c0'");
  });
});
