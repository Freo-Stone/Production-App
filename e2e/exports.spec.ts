import { expect, test, type Locator, type Page } from '@playwright/test';
import { openApp } from './support';

/**
 * The exports arriving on their own. What a browser can prove here is the screen's
 * half — that the shop is told how the files arrive, what has arrived, and why a
 * check did nothing — because the fetch itself needs a repository and a token, and
 * those are not things a test suite may hold. The fetching, the sha comparison and
 * the retry-after-a-bad-file rule are covered in `test/data.exportSync.test.ts`.
 */

function autoCard(page: Page): Locator {
  return page.locator('section.card').filter({ has: page.getByRole('heading', { name: 'Automatic import' }) });
}

test.describe('automatic export import', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page, '/sources');
  });

  test('the shop is told how the files arrive and what has arrived', async ({ page }) => {
    const card = autoCard(page);
    await expect(card).toBeVisible();
    await expect(card.getByText('about every 15 min')).toBeVisible();

    // Both paths, each on its own row, so a mirror writing to the wrong name is
    // visible rather than mysterious.
    await expect(card.locator('[data-export-kind="location"]')).toBeVisible();
    await expect(card.locator('[data-export-kind="future"]')).toBeVisible();
    const paths = card.getByLabel('Path in the repository');
    await expect(paths.nth(0)).toHaveValue('exports/location.xlsx');
    await expect(paths.nth(1)).toHaveValue('exports/future.xlsx');

    // A device that has never checked says so, per file, instead of looking broken.
    await expect(card.locator('[data-export-kind="location"]')).toContainText('Not checked');
    await expect(card.locator('[data-export-kind="future"]')).toContainText('Not checked');
    await expect(card.locator('[data-export-kind="future"]')).toContainText('not checked yet');
  });

  test('a check with nothing to reach says so, instead of spinning for ever', async ({ page }) => {
    await autoCard(page).getByRole('button', { name: 'Check now' }).click();
    // Scoped to the toast host: the card's own footnote talks about the repository
    // token too, and an assertion that cannot tell the two apart proves nothing.
    await expect(page.locator('[data-toaster]')).toContainText('this device has no repository token');
  });

  test('the interval and the switch are kept, not just drawn', async ({ page }) => {
    const card = autoCard(page);
    await card.getByLabel('How often').selectOption('60');
    await expect(card.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    await card.getByRole('switch').click();

    // The switch only moves once the write has come back through Settings, so this
    // is the round trip rather than a widget remembering its own click.
    await expect(card.getByRole('switch')).toHaveAttribute('aria-checked', 'false');

    await page.reload({ waitUntil: 'load' });
    const again = autoCard(page);
    await expect(again).toBeVisible();
    await expect(again.getByLabel('How often')).toHaveValue('60');
    await expect(again.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    // Off is said out loud rather than implied: the subtitle changes to what
    // happens instead.
    await expect(again.getByText('imported by hand')).toBeVisible();
  });

  test('a path can be pointed at wherever the mirror writes', async ({ page }) => {
    const card = autoCard(page);
    await card.getByLabel('Path in the repository').first().fill('exports/stock this week.xlsx');
    await card.getByRole('button', { name: 'Check now' }).click();
    await expect(page.locator('[data-toaster]')).toContainText('this device has no repository token');

    await page.reload({ waitUntil: 'load' });
    await expect(autoCard(page).getByLabel('Path in the repository').first()).toHaveValue('exports/stock this week.xlsx');
  });
});
