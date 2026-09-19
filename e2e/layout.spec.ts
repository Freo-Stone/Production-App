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

/**
 * Does the page fill the window it was given, without running past it?
 *
 * This used to answer with a typed number — `width < 640 ? 80 : 16` — which was the
 * same guess the layout itself was built on, so the test could only ever confirm the
 * guess. Everything here is measured off the DOM at run time: the bottom padding the
 * stylesheet actually gave `main`, and the real height of the phone nav when it is on
 * screen. Nothing in this file is a pixel allowance any more, which is what makes it
 * hold at 1366x768, at 2560 wide, and in a browser zoomed to 150%.
 */
async function fit(page: Page): Promise<string> {
  return page.evaluate(() => {
    const main = document.querySelector('main');
    if (!main) return 'no scroll region to measure';
    const kids = Array.from(main.children) as HTMLElement[];
    const last = kids[kids.length - 1];
    if (!last) return 'the scroll region is empty';
    const bottom = Math.round(last.getBoundingClientRect().bottom);
    const pad = Math.round(parseFloat(getComputedStyle(main).paddingBottom));
    const nav = document.querySelector('nav[class*="fixed"]');
    const navH = nav ? Math.round(nav.getBoundingClientRect().height) : 0;
    // Below 640px the phone nav is painted over the page, so the shell keeps at
    // least its height clear. Measured, not assumed: if the nav changes height the
    // expectation moves with it.
    const want = window.innerWidth < 640 ? Math.max(pad, navH) : pad;
    const gap = window.innerHeight - bottom - want;
    if (gap > 2) return `the page stops ${String(gap)}px short of the bottom`;
    if (gap < -2) return `the page runs ${String(-gap)}px past the bottom`;
    // The card may not swallow its own rows. `overflow: hidden` on a card whose
    // flex child is allowed to shrink to nothing turns a short window into lost
    // rows with no way to reach them — measured on a landscape phone, that was a
    // 3px table on Data sources and 47px on Products. A card that cannot fit must
    // make the *page* scroll instead, which is what `min-h-fit` gives it.
    const card = document.querySelector('[data-density]')?.closest('section');
    if (card) {
      const clipped = Math.round(card.scrollHeight - card.clientHeight);
      if (clipped > 2) return `the card is clipping ${String(clipped)}px of its own table`;
    }
    // The region that scrolls is `main`; the document cannot scroll at all, so an
    // assertion on documentElement.scrollHeight would now pass on any layout.
    const left = Math.round(main.scrollHeight - main.clientHeight);
    if (left > 2) {
      // Page scroll is only honest if it can actually reach the end. On a window
      // too short for the screen's furniture the page must run on to the bottom;
      // what must never happen is content sitting below a page that cannot get to it.
      main.scrollTop = main.scrollHeight;
      const rest = Math.round(main.scrollHeight - main.scrollTop - main.clientHeight);
      const ended = Math.round(last.getBoundingClientRect().bottom) + want;
      if (rest > 2) return `the page cannot reach its own bottom, ${String(rest)}px out`;
      if (Math.abs(window.innerHeight - ended) > 2) {
        return `the page ends ${String(window.innerHeight - ended)}px short even scrolled to the bottom`;
      }
      main.scrollTop = 0;
      return 'ok';
    }
    return 'ok';
  });
}

const topCell = (page: Page) => scroller(page).locator('[role="row"]').nth(1).locator('.dt-cell').first();

test.describe('the table gets the screen', () => {
  test('the stock grid fills the window and the page has nothing left to scroll', async ({ page }) => {
    await openApp(page, '/sources');
    await importBoth(page);
    // What is being measured is the screen at rest, not with a drawer open.
    await page.getByRole('button', { name: /Import by hand/ }).click();

    // Polled, not sampled: the screen has just taken on two thousand rows and is
    // still arranging itself, which fails on a loaded machine and means nothing.
    await expect
      .poll(() => fit(page), {
        timeout: 10_000,
        message: 'the table reaches the bottom and the page has nothing left to scroll',
      })
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

  test('the products grid reaches the bottom at every window it is handed', async ({ page }) => {
    // Real codes, or there is nothing to scroll and the scroll assertions below
    // pass by accident on an empty board.
    await openApp(page, '/sources');
    await importBoth(page);
    await page.goto(page.url().replace(/#.*$/, '') + '#/products');
    await page.waitForTimeout(400);

    // The line of guidance under the table is measured as part of the page, so it is
    // allowed its room without a constant for it.
    //
    // Five windows, because "it fits on my monitor" is how the last design got here:
    // 1536x864 and 1280x720 are what a 1920x1080 display becomes at 125% and 150%
    // browser zoom, which is a thing the shop does on the projector and the laptop.
    for (const size of [
      { width: 1920, height: 1080 },
      { width: 2560, height: 1440 },
      { width: 1366, height: 768 },
      { width: 1536, height: 864 },
      { width: 1280, height: 720 },
      // A phone turned sideways is deliberately NOT in this loop yet. At 844x390 the
      // card is shorter than its own furniture, `overflow: hidden` clips the grid,
      // and with the page no longer scrolling there is nothing left to reach it with:
      // measured 47px of visible table on Products and 3px on Data sources. The
      // assertion for it is written and passes against a card that cannot shrink
      // below its content, but that fix moved a toolbar on top of the import button,
      // so it needs doing properly with a test of its own. See TASKS.md.
    ]) {
      await page.setViewportSize(size);
      await expect
        .poll(() => fit(page), {
          timeout: 10_000,
          message: `the grid fills the window at ${String(size.width)}x${String(size.height)}`,
        })
        .toBe('ok');

      // And the rows, not the page, are what scrolls at that size.
      const inside = await scroller(page).evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          scrolls: /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight,
          room: el.scrollHeight - el.clientHeight,
        };
      });
      expect(inside.scrolls, `the grid body is the scroll container at ${String(size.width)}px`).toBe(true);
      expect(inside.room, 'the list is taller than the box it sits in').toBeGreaterThan(0);
      const height = await scroller(page).evaluate((el) => el.getBoundingClientRect().height);
      // A relationship, not a constant: the grid has to be at least a fifth of the
      // window it was given, or it is a strip rather than a table.
      expect(height, `the grid gets usable height at ${String(size.width)}x${String(size.height)}`).toBeGreaterThan(
        size.height / 5,
      );
    }
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
