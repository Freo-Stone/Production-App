import { expect, test, type Page } from '@playwright/test';
import {
  FILES,
  columnWidths,
  loadAllStaged,
  openApp,
  signIn,
  waitForStockTable,
} from './support';

/** Load the stock export and wait for the table to stop moving. */
async function loadStock(page: Page): Promise<void> {
  await page.locator('input[type="file"]').setInputFiles([FILES.stock]);
  await page.getByRole('button', { name: 'Load', exact: true }).first().click();
  await waitForStockTable(page);
}

test.describe('MYOB import', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page, '/sources');
  });

  test('both exports parse, load and fill the tables', async ({ page }) => {
    await page.locator('input[type="file"]').setInputFiles([FILES.stock, FILES.jobs]);

    // Both are recognised from the report inside, never the file name.
    const staged = page.getByRole('listitem');
    await expect(staged).toHaveCount(2);
    await expect(staged.filter({ hasText: 'Item List [Summary]' })).toHaveCount(1);
    await expect(staged.filter({ hasText: 'Sales [Item Detail]' })).toHaveCount(1);

    await loadAllStaged(page);

    // Stock mirror: 2,691 rows. Jobs mirror: 1,553 lines, of which 475 carry the
    // 4/04/2040 placeholder and are held out of the near-term list by default.
    await expect(page.getByRole('button', { name: 'Stock (2,691)' })).toBeVisible();
    await expect(page.locator('[role="row"]').first()).toBeVisible();

    await page.getByRole('button', { name: 'Future jobs (1,078)' }).click();
    await expect(page.locator('[role="row"]').first()).toBeVisible();
    // The freshness tile counts them; `exact` because order numbers contain 475.
    await expect(page.getByText('475', { exact: true })).toBeVisible();
  });

  test('dropping the same export twice replaces the tray row instead of stacking', async ({
    page,
  }) => {
    await page.locator('input[type="file"]').setInputFiles([FILES.stock, FILES.jobs]);
    await expect(page.getByRole('listitem')).toHaveCount(2);

    // A second drop of the same pair is "use this copy", not "I have two files".
    await page.locator('input[type="file"]').setInputFiles([FILES.stock, FILES.jobs]);
    await expect(page.getByRole('listitem')).toHaveCount(2);

    await loadAllStaged(page);
    await expect(page.getByRole('button', { name: 'Stock (2,691)' })).toBeVisible();
  });

  test('a rejected file explains itself instead of failing silently', async ({ page }) => {
    await page.locator('input[type="file"]').setInputFiles('playwright.config.ts');
    await expect(page.getByText(/expected a MYOB/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Load', exact: true })).toHaveCount(0);
  });

  test('clicking a header sorts the table and the choice sticks', async ({ page }) => {
    await loadStock(page);

    const firstRow = page.locator('[role="row"]').first();
    const codeColumn = page.locator('[role="columnheader"]', { hasText: 'Item No.' });

    await codeColumn.click();
    const descending = (await firstRow.innerText()).split('\n')[0] ?? '';
    await codeColumn.click();
    const ascending = (await firstRow.innerText()).split('\n')[0] ?? '';
    expect(descending).not.toBe(ascending);

    // Reload: the layout belongs to this person and must come back.
    await page.reload();
    await signIn(page);
    await expect(firstRow).toContainText(ascending);
  });

  test('columns resize with the pointer and the width survives a reload', async ({ page }) => {
    await loadStock(page);

    const handle = page.locator('[role="separator"]').first();
    // The import pushes the table down, so the handle has to be in view before
    // its box means anything to the mouse.
    await handle.scrollIntoViewIfNeeded();
    const box = await handle.boundingBox();
    expect(box).not.toBeNull();

    const before = await columnWidths(page);
    const startX = box!.x + 4;
    await page.mouse.move(startX, box!.y + 12);
    await page.mouse.down();
    await page.mouse.move(startX + 100, box!.y + 12, { steps: 8 });
    await page.mouse.up();

    // The drag is 100px, so the first column grows by 100px. Asserting the delta
    // rather than an absolute width keeps the test honest if defaults change.
    const after = await columnWidths(page);
    expect(after[0]).toBe(before[0]! + 100);

    await page.reload();
    await signIn(page);
    await expect(page.locator('.dt-head')).toContainText('Item No.');
    await expect
      .poll(async () => (await columnWidths(page))[0], { message: 'saved width comes back' })
      .toBe(before[0]! + 100);
  });

  test('hiding a column from the header menu is remembered', async ({ page }) => {
    await loadStock(page);

    await page.locator('[role="columnheader"]', { hasText: 'Category' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Hide column' }).click();
    await expect(page.locator('[role="columnheader"]', { hasText: 'Category' })).toHaveCount(0);

    await page.reload();
    await signIn(page);
    await expect(page.locator('[role="columnheader"]', { hasText: 'Category' })).toHaveCount(0);
  });

  test('location chips decide what counts as stock', async ({ page }) => {
    await loadStock(page);

    // HQ is on by default; switching it off is a settings write.
    const hq = page.getByRole('button', { name: /^HQ$/ });
    await expect(hq).toBeVisible();
    await hq.click();
    await expect(hq).toHaveAttribute('class', /text-ink3/);
    await page.reload();
    await signIn(page);
    await expect(hq).toHaveAttribute('class', /text-ink3/);
  });
});
