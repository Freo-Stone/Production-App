import { expect, test, type Page } from '@playwright/test';
import { importBoth, openApp } from './support';

/**
 * The table is the reason these screens are opened, so it gets the screen.
 *
 * This used to be wrong in two ways at once, and both are cheap to lose again:
 * the grid box had a guessed height, and the grid inside it grew to the height of
 * every row it had — 91,673px for 1,102 job lines — so the card clipped everything
 * below the twelfth row and the wheel moved the page instead of the table. A person
 * could see neither the bottom of the list nor the bottom of the window.
 *
 * The numbers here are measured against the window, never against the fixture
 * files: a screenful of furniture is the same size whatever the export contains.
 */

/** The grid's own scroll box. */
const scroller = (page: Page) => page.locator('[data-density]').first();

type Box = { top: number; bottom: number; cardTop: number; innerHeight: number; winScroll: number };

async function box(page: Page): Promise<Box> {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-density]');
    const r = el?.getBoundingClientRect();
    // The card's own top is where the screen's furniture ends. The scroll box sits
    // below the table's title and filter row, which belong to the table.
    const card = el?.closest('section');
    const c = card?.getBoundingClientRect();
    return {
      top: r ? Math.round(r.top) : -1,
      bottom: r ? Math.round(r.bottom) : -1,
      cardTop: c ? Math.round(c.top) : -1,
      innerHeight: window.innerHeight,
      winScroll: window.scrollY,
    };
  });
}

/** The shell keeps the last 80px clear for the phone nav below 640px. */
function bottomAllowance(width: number): number {
  return width < 640 ? 80 : 16;
}

const topCell = (page: Page) => scroller(page).locator('[role="row"]').nth(1).locator('.dt-cell').first();

test.describe('the table gets the screen', () => {
  test('the stock grid fills the window and the page has nothing left to scroll', async ({ page }) => {
    await openApp(page, '/sources');
    await importBoth(page);
    // What is being measured is the screen at rest, not with a drawer open.
    await page.getByRole('button', { name: /Import by hand/ }).click();

    const width = page.viewportSize()?.width ?? 1280;

    // Polled, not sampled: the height is measured after render, and the screen
    // has just taken on two thousand rows. Sampling once measures a screen that is
    // still arranging itself, which fails on a loaded machine and means nothing.
    await expect
      .poll(
        async () => {
          const b = await box(page);
          const target = b.innerHeight - bottomAllowance(width);
          if (b.bottom > target + 8) return `the table runs ${String(b.bottom - target)}px past the bottom`;
          if (b.bottom < target - 12) return `the table stops ${String(target - b.bottom)}px short of the bottom`;
          const over = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
          if (over > 2) return `the page still has ${String(over)}px left to scroll`;
          return 'ok';
        },
        { timeout: 10_000, message: 'the table reaches the bottom and the page has nothing left to scroll' },
      )
      .toBe('ok');

    // The furniture above is not allowed to grow back: where the table's card
    // starts is the measure of that. Measured today the card begins at a quarter of
    // the window on a desktop and a quarter on a phone, so anything that reappears
    // above it and pushes the table down again fails here.
    const b = await box(page);
    expect(b.cardTop).toBeLessThanOrEqual(Math.round(b.innerHeight * 0.32));
  });

  test('the last row is one scroll inside the table, not three page scrolls away', async ({ page }) => {
    await openApp(page, '/sources');
    await importBoth(page);
    await page.getByRole('button', { name: /Import by hand/ }).click();

    const b = await box(page);
    const width = page.viewportSize()?.width ?? 1280;
    const first = await topCell(page).innerText();

    // Deep into the list, inside the table.
    await scroller(page).evaluate((el) => {
      el.scrollTop = 6000;
    });
    await expect.poll(() => topCell(page).innerText(), { timeout: 8000 }).not.toBe(first);
    expect(await scroller(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    // The page itself never had to move — that was the whole complaint.
    expect(await page.evaluate(() => window.scrollY)).toBe(b.winScroll);

    // A wheel over the rows moves the rows and leaves the page alone. A touch
    // device sends no wheel events, so this is the mouse case.
    if (width >= 640) {
      await scroller(page).evaluate((el) => {
        el.scrollTop = 0;
      });
      const at = await topCell(page).innerText();
      // Over the rows themselves, well clear of the horizontal scrollbar along the
      // bottom edge.
      await page.mouse.move(Math.round(width / 2), b.top + 100);
      // One wheel per attempt, until the rows move. Firefox has been seen to
      // swallow a wheel that arrives in the same instant as the pointer moving
      // there, which a real hand does not do.
      await expect
        .poll(
          async () => {
            await page.mouse.wheel(0, 1200);
            return topCell(page).innerText();
          },
          { timeout: 8000, message: 'the wheel moves the rows' },
        )
        .not.toBe(at);
      expect(await page.evaluate(() => window.scrollY)).toBe(b.winScroll);
    }
  });

  test('the products grid reaches the bottom too', async ({ page }) => {
    await openApp(page, '/products');
    await page.waitForTimeout(400);
    const width = page.viewportSize()?.width ?? 1280;
    // The line of guidance under the table is allowed its own room.
    await expect
      .poll(
        async () => {
          const b = await box(page);
          const target = b.innerHeight - bottomAllowance(width) - 44;
          if (b.bottom > target + 12) return `the table runs ${String(b.bottom - target)}px past the note under it`;
          if (b.bottom < target - 24) return `the table stops ${String(target - b.bottom)}px short`;
          return 'ok';
        },
        { timeout: 10_000, message: 'the products grid reaches the bottom of the window' },
      )
      .toBe('ok');
  });

  test('a closed panel keeps its content off the screen', async ({ page }) => {
    await openApp(page, '/sources');
    const panel = page.getByRole('button', { name: /Import by hand/ });
    await expect(panel).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('input[type="file"]')).toHaveCount(0);
    await panel.click();
    await expect(panel).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('input[type="file"]')).toHaveCount(1);
  });
});
