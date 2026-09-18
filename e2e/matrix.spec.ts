import { expect, test, type Locator, type Page } from '@playwright/test';
import { importBoth, openApp, signIn, waitForStockTable } from './support';

/**
 * The matrix on a real browser, over the shop's real export shapes.
 *
 * Nothing here names a figure from the exports: the board is asserted by what it
 * must always do — one row per current product, a tap that opens something, a
 * horizon that comes back after a reload. The volumes are the shop's business, and
 * this repository is public.
 *
 * The phone project is a different board, deliberately: forty columns sideways on a
 * 390px screen is not a matrix, so a phone gets the product, where it stands, and
 * the next few days. Tests about column counts are therefore desktop tests, and the
 * phone is held to the same decisions in the way a phone can show them.
 */

const isPhone = (): boolean => test.info().project.name === 'phone';

/** Make the whole board current: the range is a decision, so the app ships none. */
async function markAllCurrent(page: Page): Promise<void> {
  await page.goto('/#/products');
  const pickAll = page.getByRole('button', { name: /^Pick all/ });
  await expect(pickAll).toBeVisible();
  await pickAll.click();
  await page.getByRole('button', { name: 'Mark current' }).click();
  await expect(page.getByRole('button', { name: 'Apply to picked' })).toHaveCount(0);
}

async function openBoard(page: Page): Promise<void> {
  await openApp(page, '/sources');
  await importBoth(page);
  await waitForStockTable(page);
  await markAllCurrent(page);
  await page.goto('/#/');
  await expect(page.getByRole('columnheader', { name: 'In stock' })).toBeVisible();
}

/**
 * The key of the day `offsetDays` from today, spelled the way the board spells it.
 *
 * `data-col^="d"` is not a shortcut for this: `description` and `due` start with a
 * d as well, and a description like "ABROLHOS SQUARE 400x400x30mm" carries digits,
 * so a loose selector would happily click the product instead of a day.
 */
function matrixDayKey(offsetDays: number): string {
  const now = new Date();
  return `d${new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays).getTime()}`;
}

/** A selector for the day columns of a board showing `days` of them. */
function dayCellSelector(days: number): string {
  return Array.from({ length: days }, (_v, i) => `.dt-cell[data-col="${matrixDayKey(i)}"]`).join(',');
}

function dayHeaders(page: Page): () => Promise<number> {
  return () => page.locator('[role="columnheader"]', { hasText: /^[A-Z][a-z]{2} \d+$/ }).count();
}

/**
 * Put the biggest demand inside the view at the top of the board.
 *
 * The header is addressed by its column key on purpose: its accessible name changes
 * the moment a sort is applied ("Sorted ascending — click to change"), so a name
 * selector stops matching the instant the click works.
 */
async function sortByDemand(page: Page): Promise<void> {
  const header = page.locator('[role="columnheader"][data-headcol="due"]');
  // One click, then wait for it to land. The sort goes to IndexedDB and comes back
  // through a live query, so reading immediately catches the board before it has
  // moved — and clicking again on the strength of that reading is how a sort gets
  // toggled back to nothing.
  const sorted = () => header.getAttribute('aria-sort').then((v) => v !== 'none');
  await header.click();
  try {
    await expect.poll(sorted, { timeout: 5000, message: 'the sort has been applied' }).toBe(true);
  } catch {
    // The click did not land. On a board still settling, the header can be replaced
    // between hit-testing and dispatch, and the event goes to a node React has
    // already dropped. Press once more: if the sort still does not apply, that is the
    // app's failure and the message below says so.
    await header.click();
    await expect
      .poll(sorted, { timeout: 10_000, message: 'the sort did not apply after two presses' })
      .toBe(true);
  }
  if ((await header.getAttribute('aria-sort')) === 'ascending') await header.click();
  await expect(header).toHaveAttribute('aria-sort', 'descending');
}

/**
 * The top row of the board and the code it carries.
 *
 * The row comes back pinned to that code rather than as "whichever row is first".
 * The board is a live query: under a loaded test runner a late delivery can re-render
 * it between reading the code and clicking it, and a click on `:first` then lands on
 * whatever moved into that place — which reads as a flake in a test about opening the
 * product you were just looking at.
 */
async function topRow(page: Page): Promise<{ code: string; row: Locator }> {
  const first = page.locator('[role="row"]:not(.dt-totals)').first();
  await expect(first).toBeVisible();
  const code = ((await first.locator('[data-col="code"]').textContent()) ?? '').trim();
  if (!code) throw new Error('the board has no rows — nothing was made current');
  const row = page
    .locator('[role="row"]:not(.dt-totals)')
    .filter({ has: page.locator('[data-col="code"]', { hasText: code }) })
    .first();
  return { code, row };
}

test.describe('the matrix', () => {
  test('fills in from the two exports', async ({ page }) => {
    await openBoard(page);

    await expect(page.locator('[role="row"]:not(.dt-totals)').first()).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'In stock' })).toBeVisible();

    if (isPhone()) {
      // A phone board is short by design: the product, where it stands, and the
      // next few days — never forty columns sideways.
      await expect.poll(dayHeaders(page)).toBe(4);
      return;
    }

    // Four weeks by default on a wide screen.
    await expect.poll(dayHeaders(page)).toBe(28);
    await expect(page.getByRole('columnheader', { name: 'To get to target' })).toBeVisible();
    // The two colours a row can wear, and the dot, are explained where they are used.
    await expect(page.getByText('Short', { exact: true })).toBeVisible();
    await expect(page.getByText('Needs curing', { exact: true })).toBeVisible();
    await expect(page.getByText('Past start date')).toBeVisible();
  });

  test('a day cell opens the lines behind the number', async ({ page }) => {
    await openBoard(page);
    let cell: Locator;
    if (isPhone()) {
      // Four days on screen, in rank order: take the first figure the board shows.
      cell = page.locator(`${dayCellSelector(4)} button`, { hasText: /\d/ });
    } else {
      await page.getByRole('button', { name: '6 wks' }).click();
      await sortByDemand(page);
      const { row } = await topRow(page);
      cell = row.locator(`${dayCellSelector(42)} button`, { hasText: /\d/ });
    }
    await expect(cell.first()).toBeVisible();
    await cell.first().click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // The figures a decision needs are in the popup with the lines, not only the
    // customer names the number was made of.
    await expect(dialog.getByText('To get to target')).toBeVisible();
    await expect(dialog.getByText('Incl. curing & blasted')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  test('the row itself opens the whole product', async ({ page }) => {
    await openBoard(page);
    if (!isPhone()) {
      await page.getByRole('button', { name: '6 wks' }).click();
      await sortByDemand(page);
    }

    const { code, row } = await topRow(page);
    await row.locator('[data-col="code"] button').click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('To get to target')).toBeVisible();
    if (!isPhone()) {
      // The row popup is the whole product at a glance: the days inside the view are
      // listed with how many lines sit on each.
      await expect(dialog.getByText(/1 line|\d+ lines/).first()).toBeVisible();
    }

    // And the way into the product's own settings from where the decision was made.
    await dialog.getByRole('button', { name: 'Open in Products' }).click();
    await expect(page).toHaveURL(new RegExp(`#/products\\?code=${code}`));
    await expect(page.getByRole('dialog').last().getByText(code).first()).toBeVisible();
  });

  test('the horizon is chosen, and it comes back next time', async ({ page }) => {
    await openBoard(page);

    await page.getByRole('button', { name: '1 wk' }).click();
    await expect(page.getByRole('button', { name: '1 wk' })).toHaveAttribute('aria-pressed', 'true');
    if (!isPhone()) await expect.poll(dayHeaders(page)).toBe(7);

    // A view belongs to the person who changed it, so a reload is not a reset.
    await page.reload();
    await signIn(page);
    await expect(page.getByRole('columnheader', { name: 'In stock' })).toBeVisible();
    await expect(page.getByRole('button', { name: '1 wk' })).toHaveAttribute('aria-pressed', 'true');
    if (!isPhone()) await expect.poll(dayHeaders(page)).toBe(7);
    if (isPhone()) return;

    await page.getByRole('button', { name: '6 wks' }).click();
    await expect.poll(dayHeaders(page)).toBe(42);
  });

  test('an empty board says what it is waiting for', async ({ page }) => {
    // A device that has never seen an export: the board is empty, and it says what
    // it is waiting for instead of showing a grid of nothing.
    await openApp(page, '/');

    await expect(page.getByText('Nothing imported yet')).toBeVisible();
    await page.getByRole('button', { name: 'Go to Data sources' }).click();
    await expect(page).toHaveURL(/#\/sources/);
  });
});
