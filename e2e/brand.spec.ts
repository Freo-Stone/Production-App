import { expect, test } from '@playwright/test';

import { openApp } from './support';

/**
 * The shop's brand, arriving on the screen and on the device.
 *
 * These are the parts of a brand change that fail without anyone seeing it happen:
 * an image the browser could not fetch, a manifest pointing at icons that are not
 * there, a tab strip that kept the old colours. All of it is checked over the same
 * HTTP the browser uses, because a file that exists on disk and 404s from the served
 * build is exactly the failure worth having a test for.
 */

test.describe('the shop\'s brand', () => {
  test('the logo loads on the screen you see before you sign in', async ({ page }) => {
    await page.goto('/#/');

    const logo = page.getByRole('img', { name: 'Freo Stone Paving' });
    await expect(logo).toBeVisible();

    // Visible is not the same as loaded: a wrong base path leaves the element in the
    // page with nothing in it, and the only sign is that it never fills the box.
    const decoded = await logo.evaluate((el) => (el as HTMLImageElement).naturalWidth);
    expect(decoded).toBeGreaterThan(0);
    // And the box it lands in is the shape of the artwork — square, as the logo is —
    // rather than something stretched to fill a row.
    const box = await logo.boundingBox();
    expect(box).not.toBeNull();
    expect((box?.width ?? 0) / (box?.height ?? 1)).toBeGreaterThan(0.95);
    expect((box?.width ?? 0) / (box?.height ?? 1)).toBeLessThan(1.05);
  });

  test('the header wears the same artwork as the home-screen icon', async ({ page }) => {
    await openApp(page);

    // The rail's tile is the mark, drawn from the logo by the same script the icons
    // come from. It is looked for by where it sits rather than by file name, because
    // a 1KB SVG is inlined into the bundle as a data URI and has no file name by then.
    // On a phone the rail lives in the drawer, so it is in the page whether or not
    // this window is wide enough to show it.
    const mark = page.locator('nav img').first();
    await expect(mark).toBeAttached();
    const size = await mark.evaluate((el) => ({
      natural: (el as HTMLImageElement).naturalWidth,
      complete: (el as HTMLImageElement).complete,
      src: (el as HTMLImageElement).currentSrc ?? (el as HTMLImageElement).getAttribute('src') ?? '',
    }));
    expect(size.src).not.toBe('');
    expect(size.complete).toBe(true);
    // The mark carries its own size, so a loaded one always reports one.
    expect(size.natural).toBeGreaterThanOrEqual(28);

    if (page.viewportSize()?.width && (page.viewportSize()?.width ?? 0) >= 1024) {
      await expect(mark).toBeVisible();
      await expect(page.locator('nav').first().getByText('Freo Stone')).toBeVisible();
    }
  });

  test('what the browser and an installer are told is the shop\'s blue', async ({ page }) => {
    await page.goto('/#/');

    const manifest = await page.request.get('/manifest.webmanifest');
    expect(manifest.ok()).toBe(true);
    const json = (await manifest.json()) as { theme_color?: string; background_color?: string };
    expect(json.theme_color?.toLowerCase()).toBe('#0076c0');
    // The splash stays the colour the app opens on, so installing does not flash blue.
    expect(json.background_color?.toLowerCase()).toBe('#0d1117');

    const icon = await page.request.get('/favicon.svg');
    expect(icon.ok()).toBe(true);
    expect(await icon.text()).toContain('#0076C0');

    for (const file of ['icon-192.png', 'icon-512.png', 'maskable-192.png', 'maskable-512.png']) {
      const response = await page.request.get(`/${file}`);
      expect(response.ok(), file).toBe(true);
    }

    // The tab strip's icon is the SVG, and it is the one that carries the brand.
    const href = await page.locator('link[rel="icon"]').first().getAttribute('href');
    expect(href).toContain('favicon.svg');

    // And the strip the app sits in is the same blue — in either theme. The theme
    // repaints the app; the shop's colour is not a theme setting.
    await expect
      .poll(() => page.locator('meta[name="theme-color"]').getAttribute('content'))
      .toMatch(/#0076c0/i);
    await page.evaluate(() => {
      localStorage.setItem('freo.theme', JSON.stringify({ state: { preference: 'light' } }));
    });
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(
      ((await page.locator('meta[name="theme-color"]').getAttribute('content')) ?? '').toLowerCase(),
    ).toBe('#0076c0');
  });
});
