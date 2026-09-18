import { expect, test } from '@playwright/test';
import { FILES, loadAllStaged, openApp, openImportPanel, signIn, waitForStockTable } from './support';

test.describe('shell', () => {
  // These are wide-screen assertions: below the layout breakpoint the rail is
  // replaced by the bottom tabs, and the two navs are not interchangeable.
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name === 'phone', 'the rail is the wide layout');
  });

  test('the rail navigates and the header follows the route', async ({ page }) => {
    await openApp(page);

    const rail = page.locator('nav').first();
    await expect(rail.getByRole('button', { name: 'Matrix' })).toBeVisible();
    await rail.getByRole('button', { name: 'Daily entry' }).click();
    await expect(page).toHaveURL(/#\/entry/);
    // The page title lives in the header h1; the screen body has its own headings.
    await expect(page.locator('h1')).toHaveText('Daily entry');

    await rail.getByRole('button', { name: 'Products' }).click();
    await expect(page).toHaveURL(/#\/products/);
  });

  test('a collapsed rail still reaches every screen', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: 'Collapse menu' }).click();
    // Asked of the rail, not of the page: the board behind it offers a
    // "Go to Data sources" button of its own when there is nothing imported yet,
    // and this test is about whether the collapsed rail can be reached.
    const rail = page.getByRole('navigation');
    await expect(rail.getByRole('button', { name: 'Data sources' })).toBeVisible();
    await rail.getByRole('button', { name: 'Data sources' }).click();
    await expect(page).toHaveURL(/#\/sources/);
  });

  test('the menu is words, not pictures', async ({ page }) => {
    // Asked for outright: *"remove the emojis from the menu"*. The entries are the
    // words now, on the rail, in the collapsed rail and in the bottom tabs — so a
    // picture cannot come back into any of them by accident.
    await openApp(page);

    const SCREENS = /Matrix|Jobs|Schedule|Entry|Log|Curing|Blast|MYOB|Products|Data sources|Settings|People|More/;
    const entries = page.locator('nav').first().getByRole('button', { name: SCREENS });
    expect(await entries.count()).toBeGreaterThanOrEqual(4);
    for (const entry of await entries.all()) {
      expect(await entry.locator('svg').count()).toBe(0);
    }

    // The phone's More sheet is the same list, and the same rule.
    const more = page.getByRole('button', { name: 'More', exact: true });
    if (await more.count()) {
      await more.click();
      const sheet = page.getByRole('dialog');
      await expect(sheet.getByRole('button', { name: /Production log/ })).toBeVisible();
      expect(await sheet.locator('svg').count()).toBe(0);
    }
  });

  test('the theme flips and stays flipped after a reload', async ({ page }) => {
    await openApp(page);
    const before = await page.locator('html').getAttribute('data-theme');
    await page.getByRole('button', { name: /Theme:/ }).click();
    const after = await page.locator('html').getAttribute('data-theme');
    expect(after).not.toBe(before);

    await page.reload();
    await signIn(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', after!);
  });

  test('first run points at the import screen', async ({ page }) => {
    await openApp(page);
    const banner = page.getByText('Nothing set up yet');
    await expect(banner).toBeVisible();
    // Dismissing sticks for the session, even across a reload.
    await page.getByRole('button', { name: 'Dismiss' }).first().click();
    await expect(page.getByText('Nothing set up yet')).toHaveCount(0);
    await page.reload();
    await signIn(page);
    await expect(page.getByText('Nothing set up yet')).toHaveCount(0);
  });

  test('an unknown route returns to the matrix instead of a dead end', async ({ page }) => {
    await page.goto('/#/not-a-screen');
    await signIn(page);
    await expect(page).toHaveURL(/#\/$/);
  });
});

test.describe('phone layout', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('bottom tabs carry the floor screens and More carries the rest', async ({ page }) => {
    await openApp(page);

    const tabs = page.locator('nav').last();
    await expect(tabs.getByText('Entry')).toBeVisible();
    await expect(tabs.getByText('Curing')).toBeVisible();
    await expect(tabs.getByText('MYOB')).toBeVisible();

    await tabs.getByRole('button', { name: 'More' }).click();
    const sheet = page.getByRole('dialog');
    await expect(sheet.getByText('Production log')).toBeVisible();
    await sheet.getByRole('button', { name: /Settings/ }).click();
    await expect(page).toHaveURL(/#\/settings/);
  });

  test('the import drop zone is reachable with one thumb', async ({ page }) => {
    await openApp(page, '/sources');
    // The tray is behind a line now: one press, and the drop zone must land inside
    // thumb reach rather than below a wall of furniture. (A click, not a tap: the
    // desktop project has no touch support, and the reach is what is being measured.)
    const trigger = page.getByRole('button', { name: /Import by hand/ });
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const zone = page.getByText('Drop the two MYOB exports here');
    await expect(zone).toBeVisible();
    const box = await zone.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeLessThan(page.viewportSize()?.height ?? 844);
    // The file input stays reachable for the OS file picker.
    await expect(page.locator('input[type="file"]')).toBeAttached();
  });

  test('a table does not force the page sideways', async ({ page }) => {
    await openApp(page, '/sources');
    await openImportPanel(page);
    await page.locator('input[type="file"]').setInputFiles([FILES.stock]);
    // Through the app's own path, with the shared wait: the parse runs in the page
    // and this suite runs two workers, so "the rows are here" needs the same
    // patience everywhere or it fails where the machine is busiest.
    await loadAllStaged(page);
    await waitForStockTable(page);

    // Only the grid itself may scroll sideways, never the document. Polled because
    // the screen re-measures itself after the rows arrive, and named on failure:
    // "it was wider" is not something anybody can act on.
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const over = document.documentElement.scrollWidth - window.innerWidth;
            if (over <= 1) return 'ok';
            const culprits: string[] = [];
            for (const el of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
              const b = el.getBoundingClientRect();
              if (b.right > window.innerWidth + 1 && b.width > 0) {
                culprits.push(`${el.tagName.toLowerCase()}.${(el.className ?? '').toString().split(' ')[0]}`);
                if (culprits.length === 3) break;
              }
            }
            return `${String(over)}px wider — ${culprits.join(', ') || 'nothing named'}`;
          }),
        { timeout: 5000, message: 'the document stays as wide as the window' },
      )
      .toBe('ok');
  });
});
