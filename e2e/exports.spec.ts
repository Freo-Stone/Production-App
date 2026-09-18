import { expect, test, type Locator, type Page } from '@playwright/test';
import { openApp } from './support';

/**
 * The exports arriving on their own. What a browser can prove here is the screen's
 * half — that the shop is told how the files arrive, what has arrived, and why a
 * check did nothing — because the fetch itself needs a repository and a token, and
 * those are not things a test suite may hold. The fetching, the sha comparison and
 * the retry-after-a-bad-file rule are covered in `test/data.exportSync.test.ts`.
 */

/** The one line the screen shows about automatic import. */
function autoBar(page: Page): Locator {
  return page.locator('[data-auto-import]');
}

/** The half that is hidden by default: paths, interval, the fuller per-file lines. */
async function openDetails(page: Page): Promise<Locator> {
  const bar = autoBar(page);
  const details = page.locator('[data-export-details]');
  if ((await bar.getByRole('button', { name: 'Details' }).getAttribute('aria-expanded')) !== 'true') {
    await bar.getByRole('button', { name: 'Details' }).click();
  }
  await expect(details).toBeVisible();
  return details;
}

test.describe('automatic export import', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page, '/sources');
  });

  // What one device can show is one device's state. The suite cannot hold a real
  // token, so what it can prove here is the device a shop owner actually lands on:
  // switched on, online, and never handed a token. The chips each file gets — the
  // imported one, the failed one, the missing one — are proven in
  // `test/ui.autoImport.test.tsx`, which can hand the line whatever states it likes.
  test('a device that cannot check says why, and takes him where it is fixed', async ({ page }) => {
    const bar = autoBar(page);
    await expect(bar).toBeVisible();
    await expect(bar.getByText('every 15 min')).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Check now' })).toBeVisible();

    const blocker = bar.locator('[data-auto-import-blocker]');
    await expect(blocker).toBeVisible();
    await expect(blocker).toContainText('this device has no repository token');

    // The two per-file chips step aside. On a device that has never checked and
    // cannot check, "Not checked" twice is the same sentence said badly — and the
    // line they used to wrap onto is room the stock table wants back.
    await expect(bar.locator('[data-export-kind="location"]')).toHaveCount(0);
    await expect(bar.locator('[data-export-kind="future"]')).toHaveCount(0);

    // The reason is a way out, not a complaint.
    await blocker.getByRole('button').click();
    await expect(page).toHaveURL(/#\/settings/);
  });

  test('the reason says what a device with a token does not have to read', async ({ page }) => {
    // The other half of the same coin: the sentence is about the device, so it is
    // said once, and it does not shadow anything the drawer has to say.
    const details = await openDetails(page);
    await expect(details).toContainText('Test connection');
    await expect(details).toContainText('Each device needs its own');
    await expect(details.getByLabel('Path in the repository')).toHaveCount(2);
  });

  test('details hold the paths, and both are on screen to be read', async ({ page }) => {
    const details = await openDetails(page);
    const paths = details.getByLabel('Path in the repository');
    await expect(paths.nth(0)).toHaveValue('exports/location.xlsx');
    await expect(paths.nth(1)).toHaveValue('exports/future.xlsx');
    // The fuller line for each file: what it was, not just that it was.
    await expect(details.getByText('Stock export', { exact: true })).toBeVisible();
    await expect(details.getByText('Future jobs', { exact: true })).toBeVisible();
  });

  test('a check with nothing to reach says so, instead of spinning for ever', async ({ page }) => {
    await autoBar(page).getByRole('button', { name: 'Check now' }).click();
    // Scoped to the toast host: the bar's own footnote talks about the repository
    // token too, and an assertion that cannot tell the two apart proves nothing.
    await expect(page.locator('[data-toaster]')).toContainText('this device has no repository token');
  });

  test('the interval and the switch are kept, not just drawn', async ({ page }) => {
    const bar = autoBar(page);
    const details = await openDetails(page);
    await details.getByLabel('How often').selectOption('60');
    await expect(bar.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    await bar.getByRole('switch').click();

    // The switch only moves once the write has come back through Settings, so this
    // is the round trip rather than a widget remembering its own click.
    await expect(bar.getByRole('switch')).toHaveAttribute('aria-checked', 'false');

    await page.reload({ waitUntil: 'load' });
    const again = autoBar(page);
    await expect(again).toBeVisible();
    await expect(again.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    // Off is said out loud rather than implied, and it says what happens instead.
    await expect(again.getByText('imported by hand')).toBeVisible();

    // The interval is kept through the off period, not forgotten by it.
    const kept = await openDetails(page);
    await expect(kept.getByLabel('How often')).toHaveValue('60');
    await again.getByRole('switch').click();
    await expect(again.getByText('every 60 min')).toBeVisible();
  });

  test('a path can be pointed at wherever the mirror writes', async ({ page }) => {
    const bar = autoBar(page);
    const details = await openDetails(page);
    await details.getByLabel('Path in the repository').first().fill('exports/stock this week.xlsx');
    await bar.getByRole('button', { name: 'Check now' }).click();
    await expect(page.locator('[data-toaster]')).toContainText('this device has no repository token');

    await page.reload({ waitUntil: 'load' });
    // The path is the thing that survived, which is what a hand-off to the mirror
    // needs to be sure of. This device cannot check, so the file's own chip is not
    // on the line — the reason is — but the drawer still names what it would read.
    const again = await openDetails(page);
    await expect(again.getByLabel('Path in the repository').first()).toHaveValue('exports/stock this week.xlsx');
  });
});
