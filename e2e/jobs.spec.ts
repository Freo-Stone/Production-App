import type { Page } from '@playwright/test';
import { expect, test } from './support';
import { importBoth, openApp } from './support';


/**
 * The order book, driven through the real build.
 *
 * This is the screen that answers the question MYOB never answered: a customer is
 * owed 8 m², and do we have it? It reads three things at once — the sales-order
 * export, the stock export and the racks on this device — so the browser tests use
 * the real fixture exports rather than a hand-made table, and every assertion is
 * relational: the count printed on a filter is the number of lines that filter
 * shows, the same figure is on the row twice when a code is promised twice, and a
 * line explains itself when you press it.
 *
 * The real export holds a large share of lines dated 4/04/2040 — a placeholder, not
 * a promise — so those are held out of the near-term views by default. That is
 * asserted here, because a screen that quietly drops two thirds of the book has to
 * say it did.
 */

const rowsOn = (page: Page) => page.locator('.dt-row');

/** The summary a filter prints under the chips: "N of M lines". */
async function filteredCount(page: Page): Promise<number | null> {
  const note = page.locator('[data-jobs-filtered]');
  if ((await note.count()) === 0) return null;
  const text = (await note.textContent()) ?? '';
  const match = /^([\d,]+) of [\d,]+ lines/.exec(text.trim());
  if (!match) throw new Error(`the filter note does not read like a count: ${text}`);
  return Number(match[1].replace(/,/g, ''));
}

async function chipCount(page: Page, selector: string): Promise<number> {
  const text = (await page.locator(selector).textContent()) ?? '';
  const digits = /([\d,]+)/.exec(text.trim());
  if (!digits) throw new Error(`${selector} carries no count: ${text}`);
  return Number(digits[1].replace(/,/g, ''));
}

/**
 * A customer read off a real row, so the search is tested against data that exists
 * rather than a name invented for the test.
 *
 * The rows are read through the grid's own cells, and the first few are tried: what
 * the table puts first in the DOM is its own business — a partially-scrolled row, a
 * spacer, the totals strip — and a test that assumes "the first .dt-row is a data
 * row" fails on the layout rather than on the app.
 */
async function someCustomer(page: Page): Promise<string> {
  const rows = page.locator('.dt-row').filter({ has: page.locator('.dt-cell:nth-child(3)') });
  // Wait for the grid to fill before counting anything: a table that has not drawn
  // its first row yet is not a book with no customers in it. `count()` does not
  // wait, so the wait has to be an assertion.
  await expect(rows.first(), 'the order book has rows on screen').toBeVisible({ timeout: 15_000 });
  const count = await rows.count();
  for (let i = 0; i < Math.min(count, 10); i += 1) {
    const cells = await rows.nth(i).locator('.dt-cell').allTextContents();
    const value = (cells[2] ?? '').trim();
    if (value !== '' && !/^total/i.test(value) && /[a-z]/i.test(value)) return value;
  }
  throw new Error(`no customer in the first ${Math.min(count, 10)} rows of the book`);
}

/** Load both MYOB exports through the Data sources screen, the way the shop does. */
/** Sign in on a clean device, load both exports through Data sources, come back. */
async function withExports(page: Page): Promise<void> {
  await openApp(page, '/sources');
  await importBoth(page);
  await page.goto('/#/jobs');
  await expect(page.getByRole('heading', { name: 'The order book' })).toBeVisible();
}

test.describe('the order book', () => {
  test('says so plainly before the export has ever been read', async ({ page }) => {
    await openApp(page, '/jobs');

    await expect(page.getByRole('heading', { name: 'The order book' })).toBeVisible();
    await expect(page.getByText('No future jobs on this device')).toBeVisible();
    await expect(page.getByText('Sales [Item Detail]')).toBeVisible();
    // The stub is gone: nothing on this route may say it is waiting to be built.
    await expect(page.getByText(/not wired up/i)).toHaveCount(0);

    // Scoped to the page body: the side menu has a Data sources item with the same
    // name, and a test that clicks the menu proves nothing about this screen's offer.
    await page.getByRole('main').getByRole('button', { name: 'Data sources', exact: true }).click();
    await expect(page).toHaveURL(/#\/sources/);
  });

  test('fills up when the MYOB exports are loaded, and says where they came from', async ({ page }) => {
    await withExports(page);

    await expect(page.getByText(/\d[\d,]* open lines/)).toBeVisible();
    await expect(rowsOn(page).first()).toBeVisible();
    // Cover is only meaningful against a stock export, and one has been read.
    // A file loaded seconds ago reads "just now", not "1 min ago". The footnote under
    // the table quotes the same export, so the assertion is on the heading itself.
    await expect(page.locator('.card').first().getByText(/export read (?:just now|\d+ (?:min|h) ago)/)).toBeVisible();
    // Undated lines: held out of the near-term views, counted where they are visible.
    const undated = await chipCount(page, '[data-jobs-far-future]');
    expect(undated, 'the export is full of placeholder-dated lines').toBeGreaterThan(0);
    expect(await filteredCount(page)).toBeNull();
  });

  test('a filter shows exactly the number of lines it claims', async ({ page }) => {
    await withExports(page);

    // The header's open count and the "Everything" chip are the same fact.
    const header = (await page.getByText(/\d[\d,]* open lines/).first().textContent()) ?? '';
    const openLines = Number((/^([\d,]+) open lines/.exec(header.trim())?.[1] ?? '').replace(/,/g, ''));
    expect(Number.isFinite(openLines), `the header does not start with a count: ${header}`).toBe(true);
    expect(await chipCount(page, '[data-jobs-window="all"]')).toBe(openLines);

    for (const key of ['past', 'week', 'fortnight'] as const) {
      const chip = page.locator(`[data-jobs-window="${key}"]`);
      const claimed = await chipCount(page, `[data-jobs-window="${key}"]`);
      await chip.click();
      await expect(page.locator('[data-jobs-filtered]')).toBeVisible();
      expect(await filteredCount(page), `${key} shows what it says on the chip`).toBe(claimed);
    }

    await page.locator('[data-jobs-clear]').click();
    await expect(page.locator('[data-jobs-filtered]')).toHaveCount(0);
  });

  test('the undated lines stay out until they are asked for', async ({ page }) => {
    await withExports(page);

    expect(await filteredCount(page), 'nothing is filtered to begin with').toBeNull();
    const undated = await chipCount(page, '[data-jobs-far-future]');
    const dated = await chipCount(page, '[data-jobs-window="all"]');
    expect(undated, 'the export is full of placeholder-dated lines').toBeGreaterThan(0);

    await page.locator('[data-jobs-far-future]').click();
    await expect(page.getByText('Undated lines are shown')).toBeVisible();
    // Asking for them adds exactly that many lines and nothing else.
    expect(await filteredCount(page)).toBe(dated + undated);

    // And they are not quietly folded into "late": an undated line is not a promise.
    await expect(page.getByText(/line late/)).toHaveCount(0);
  });

  test('pressing a line says where its cover came from', async ({ page }) => {
    await withExports(page);

    await rowsOn(page).first().click();
    const detail = page.locator('[data-jobs-detail]');
    await expect(detail).toBeVisible();
    await expect(detail.getByText('Stock on hand')).toBeVisible();
    await expect(detail.getByText('On the racks')).toBeVisible();
    await expect(detail.getByText('Whole shop')).toBeVisible();
    // The line says who was promised what, in words — not just a date in a column.
    await expect(detail.getByText(/was promised/)).toBeVisible();
    // Reading a line changes nothing: there is no write on this screen at all.
    await expect(detail.getByRole('button', { name: /^Mark/ })).toHaveCount(0);

    await page.getByRole('button', { name: 'Close' }).click();
    await expect(detail).toHaveCount(0);
  });

  test('a search says how much it took out', async ({ page }) => {
    await withExports(page);

    const customer = await someCustomer(page);
    await page.locator('[data-jobs-search]').fill(customer);
    await expect(page.locator('[data-jobs-filtered]')).toBeVisible();
    const shown = await filteredCount(page);
    const claimed = await chipCount(page, '[data-jobs-window="all"]');
    expect(shown).not.toBeNull();
    expect(shown as number).toBeGreaterThan(0);
    expect(shown as number).toBeLessThanOrEqual(claimed);

    await page.locator('[data-jobs-search]').fill('nothing like this at all');
    await expect(page.getByText('No line matches')).toBeVisible();
    expect(await filteredCount(page)).toBe(0);
  });
});

test.describe('the order book on a phone', () => {
  test('is thumb-sized, does not run off the screen, and still explains a line', async ({ page }) => {
    const width = page.viewportSize()?.width ?? 0;
    test.skip(width >= 1024, 'thumb targets are a phone question');

    await withExports(page);

    for (const key of ['past', 'week', 'fortnight', 'all'] as const) {
      const box = await page.locator(`[data-jobs-window="${key}"]`).boundingBox();
      expect(box?.height ?? 0, `${key} is thumb-sized`).toBeGreaterThanOrEqual(44);
    }

    await page.locator('[data-jobs-window="week"]').click();
    await expect(page.locator('[data-jobs-filtered]')).toBeVisible();

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, 'the page does not run sideways off the phone').toBeLessThanOrEqual(1);

    await rowsOn(page).first().click();
    await expect(page.locator('[data-jobs-detail]')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close' })).toBeVisible();
  });
});
