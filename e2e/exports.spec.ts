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

  test('the line says how the files arrive and what each one did', async ({ page }) => {
    const bar = autoBar(page);
    await expect(bar).toBeVisible();
    await expect(bar.getByText('every 15 min')).toBeVisible();

    // Both files, each with its own answer, so a mirror writing to the wrong name
    // is visible rather than mysterious.
    await expect(bar.locator('[data-export-kind="location"]')).toBeVisible();
    await expect(bar.locator('[data-export-kind="future"]')).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Check now' })).toBeVisible();

    // A device that has never checked says so, per file, instead of looking broken.
    await expect(bar.locator('[data-export-kind="location"]')).toContainText('Not checked');
    await expect(bar.locator('[data-export-kind="future"]')).toContainText('Not checked');
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
    // The line names the file it is talking about, so the change is visible before
    // anything is opened.
    await expect(autoBar(page).locator('[data-export-kind="location"]')).toContainText('stock this week.xlsx');
    const again = await openDetails(page);
    await expect(again.getByLabel('Path in the repository').first()).toHaveValue('exports/stock this week.xlsx');
  });
});
