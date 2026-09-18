import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  FILES,
  columnWidths,
  loadAllStaged,
  openApp,
  openImportPanel,
  openLocations,
  signIn,
  waitForStockTable,
} from './support';

/**
 * Wait until the click has travelled through the view store and back, and say
 * which way the arrow ended up.
 */
async function firstSettled(column: Locator): Promise<string | null> {
  await expect
    .poll(() => column.getAttribute('aria-sort'), { timeout: 4000 })
    .not.toBe('none');
  return column.getAttribute('aria-sort');
}

/** Load the stock export and wait for the table to stop moving. */
async function loadStock(page: Page): Promise<void> {
  await openImportPanel(page);
  await page.locator('input[type="file"]').setInputFiles([FILES.stock]);
  await page.getByRole('button', { name: 'Load', exact: true }).first().click();
  await waitForStockTable(page);
}

test.describe('MYOB import', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page, '/sources');
  });

  test('both exports parse, load and fill the tables', async ({ page }) => {
    await openImportPanel(page);
    await page.locator('input[type="file"]').setInputFiles([FILES.stock, FILES.jobs]);

    // Both are recognised from the report inside, never the file name.
    const staged = page.getByRole('listitem');
    await expect(staged).toHaveCount(2);
    await expect(staged.filter({ hasText: 'Item List [Summary]' })).toHaveCount(1);
    await expect(staged.filter({ hasText: 'Sales [Item Detail]' })).toHaveCount(1);

    await loadAllStaged(page);

    // How much landed is said by the tab over the table — there is no summary band
    // above it any more. The number belongs to the shop's export, so it is read off
    // the screen rather than written into this file.
    const countOn = async (label: string): Promise<number> => {
      const text = await page.getByRole('button', { name: new RegExp(`^${label} \\(`) }).innerText();
      return Number(text.replace(/[^0-9]/g, ''));
    };

    await expect(page.getByRole('button', { name: /^Stock \(/ })).toBeVisible();
    await expect(page.locator('[role="row"]').first()).toBeVisible();
    expect(await countOn('Stock')).toBeGreaterThan(0);

    const hidden = await countOn('Future jobs');
    expect(hidden).toBeGreaterThan(0);

    await page.getByRole('button', { name: /^Future jobs \(/ }).click();
    await expect(page.locator('[role="row"]').first()).toBeVisible();

    // Placeholder promise dates (a year like 4/04/2040 means "no date yet") are held
    // out of the near-term list by default and the switch puts them back, so the
    // same tab reports more lines with the switch on. Proven as a change: counting
    // them here would hard-code the export's contents.
    await page.getByRole('switch', { name: /Include placeholder dates/ }).click();
    await expect
      .poll(() => countOn('Future jobs'), { timeout: 15_000, message: 'the placeholder lines come back' })
      .toBeGreaterThan(hidden);
  });

  test('dropping the same export twice replaces the tray row instead of stacking', async ({
    page,
  }) => {
    await openImportPanel(page);
    await page.locator('input[type="file"]').setInputFiles([FILES.stock, FILES.jobs]);
    await expect(page.getByRole('listitem')).toHaveCount(2);

    // A second drop of the same pair is "use this copy", not "I have two files".
    await openImportPanel(page);
    await page.locator('input[type="file"]').setInputFiles([FILES.stock, FILES.jobs]);
    await expect(page.getByRole('listitem')).toHaveCount(2);

    await loadAllStaged(page);
    // The tab is labelled with however many rows landed; the export's volume is not
    // this file's business.
    await expect(page.getByRole('button', { name: /^Stock \([\d,]+\)$/ })).toBeVisible();
  });

  test('a rejected file explains itself instead of failing silently', async ({ page }) => {
    await openImportPanel(page);
    await page.locator('input[type="file"]').setInputFiles('playwright.config.ts');
    await expect(page.getByText(/expected a MYOB/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Load', exact: true })).toHaveCount(0);
  });

  test('clicking a header sorts the table and the choice sticks', async ({ page }) => {
    await loadStock(page);

    const firstRow = page.locator('[role="row"]').first();
    const codeColumn = page.locator('[role="columnheader"]', { hasText: 'Item No.' });

    // The view is written to IndexedDB and comes back through a live query, so the
    // arrow — not the row read immediately after the click — is what says the click
    // has landed. Reading the row too early used to capture the previous order and
    // then lose the assertion after the reload, where the truth finally arrived.
    const topCode = () => firstRow.innerText().then((t) => t.split('\n')[0] ?? '');

    await codeColumn.click();
    const firstArrow = await firstSettled(codeColumn);
    const firstOrder = await topCode();

    await codeColumn.click();
    await expect.poll(() => codeColumn.getAttribute('aria-sort'), { timeout: 4000 }).not.toBe(firstArrow);
    const secondArrow = await codeColumn.getAttribute('aria-sort');
    const secondOrder = await topCode();
    expect(secondOrder).not.toBe(firstOrder);

    // Reload: the layout belongs to this person and must come back, arrow and all.
    await page.reload();
    await signIn(page);
    // The export is parsed again in the page after a reload, and with two workers
    // that is not a five-second job. Every assertion below is about a table, so the
    // wait belongs here rather than in each of them: see waitForStockTable.
    await waitForStockTable(page);
    await expect(codeColumn).toHaveAttribute('aria-sort', secondArrow ?? '');
    await expect(firstRow).toContainText(secondOrder);
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
    // rather than an absolute width keeps the test honest if defaults change. And
    // polled, because the width goes to IndexedDB and comes back through a live
    // query: reading once right after the pointer is up used to catch the old
    // width on a loaded machine and report a drag that never happened.
    await expect
      .poll(async () => (await columnWidths(page))[0], { timeout: 8000, message: 'the dragged width is applied' })
      .toBe(before[0]! + 100);

    await page.reload();
    await signIn(page);
    // The export is parsed again in the page after a reload, and with two workers
    // that is not a five-second job. Every assertion below is about a table, so the
    // wait belongs here rather than in each of them: see waitForStockTable.
    await waitForStockTable(page);
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
    // The export is parsed again in the page after a reload, and with two workers
    // that is not a five-second job. Every assertion below is about a table, so the
    // wait belongs here rather than in each of them: see waitForStockTable.
    await waitForStockTable(page);
    await expect(page.locator('[role="columnheader"]', { hasText: 'Category' })).toHaveCount(0);
  });

  test('location chips decide what counts as stock', async ({ page }) => {
    await loadStock(page);

    // The groups live behind their own line now, because the table underneath is
    // what the screen is for.
    await openLocations(page);

    // HQ is on by default; switching it off is a settings write.
    const hq = page.getByRole('button', { name: /^HQ$/ });
    await expect(hq).toBeVisible();
    await hq.click();
    await expect(hq).toHaveAttribute('class', /text-ink3/);
    await page.reload();
    await signIn(page);
    // The export is parsed again in the page after a reload, and with two workers
    // that is not a five-second job. Every assertion below is about a table, so the
    // wait belongs here rather than in each of them: see waitForStockTable.
    await waitForStockTable(page);
    // The line comes back closed, so the answer is read where it is kept: open it.
    await openLocations(page);
    await expect(hq).toHaveAttribute('class', /text-ink3/);
  });
});
