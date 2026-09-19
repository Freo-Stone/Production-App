import { expect, test, type Page } from '@playwright/test';
import { importBoth, markAllCurrent, openApp } from './support';

/**
 * Three things the eye is supposed to be able to do, written down so they cannot rot:
 * see what is selected, find one left edge, and not be shown a control nobody can hit.
 * Each was measured off a photograph of the real screens, and each one fails when the
 * change that fixes it is put back.
 *
 * A fourth was here -- totals cut off at the cell edge -- and is gone. It did not
 * reproduce: with the clipping rule removed, every totals cell on the Matrix and on
 * Products measured scrollWidth == clientWidth at 1920 and at 1366, so the assertion
 * could not fail and the "fix" was protecting nothing. What IS wrong there is that the
 * unit is printed inside every cell ("525,509.73 m2" five times a row), which is what
 * makes those columns wide enough to threaten the edge at all; that is the fix to do.
 */
test.describe('the screen answers the questions it is asked', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page, '/sources');
    await importBoth(page);
    await markAllCurrent(page);
  });

  test('a control that is switched on looks switched on', async ({ page }) => {
    await page.goto(`${page.url().split('#')[0]}#/matrix`);
    const on = page.locator('[role="radiogroup"] button[aria-pressed="true"], .card button[aria-pressed="true"]').first();
    await expect(on).toBeVisible();
    const paint = await page.evaluate(() => {
      const btn = document.querySelector('.card button[aria-pressed="true"]') as HTMLElement | null;
      const seg = document.querySelector('[role="radiogroup"] .bg-accent, .bg-accent') as HTMLElement | null;
      return { pressed: btn ? getComputedStyle(btn).backgroundColor : 'none', segment: seg ? getComputedStyle(seg).backgroundColor : 'none' };
    });
    // #3d9adc is the accent. A selected segment must carry it as a fill, not a hue shift.
    expect(paint.segment).toBe('rgb(61, 154, 220)');
    expect(paint.pressed).not.toBe('rgba(0, 0, 0, 0)');
  });

  test('a card has one left edge', async ({ page }) => {
    await page.goto(`${page.url().split('#')[0]}#/products`);
    const edges = await page.evaluate(() => {
      // Measure inside the toolbar band, and take the control inside it: asking for
      // "the card's input" picks up whichever card happens to be first in the DOM.
      const card = document.querySelector('main section.card') as HTMLElement | null;
      const title = card?.querySelector('h2')?.getBoundingClientRect().left ?? -1;
      const band = card?.querySelector('div[class*="border-b"]') as HTMLElement | null;
      const input = band?.querySelector('input')?.getBoundingClientRect().left ?? -1;
      return { title, band: band ? 0 : -1, input };
    });
    expect(Math.abs(edges.input - edges.title)).toBeLessThanOrEqual(1);
  });

  test('a number cell does not show a stepper nobody can press', async ({ page }) => {
    await page.goto(`${page.url().split('#')[0]}#/products`);
    const appearance = await page.evaluate(() => {
      const el = document.querySelector('input[type="number"]') as HTMLInputElement | null;
      return el ? getComputedStyle(el).appearance : 'no number input';
    });
    expect(appearance).toBe('textfield');
  });
});
