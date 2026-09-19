import type { Page } from '@playwright/test';
import {
  enableProduct,
  expect,
  importBoth,
  markAllCurrent,
  openApp,
  searchProducts,
  setProductRoute,
  test,
  waitForStockTable,
} from './support';

/**
 * The making plan, driven through the real build.
 *
 * The schedule is the screen that turns the order book into work, so these tests run
 * on the real MYOB exports: the fixture's report period ends 17/09/2026, which means
 * the shop genuinely has promises whose start day has gone, and the numbers on screen
 * are the shop's, not the test's.
 *
 * Three things are checked over and over, because they are the three ways this screen
 * could lie: that a chip's count is the number of rows the chip shows (the grid is
 * virtualised, so rows are counted through the screen's own "N of M rows" note rather
 * than by what happens to be painted), that a row tells you whether anybody has
 * planned it, and that writing a plan line changes the plan and nothing else — the
 * order book keeps saying what is owed, because a plan is not stock.
 */

const rowsOn = (page: Page) => page.locator('.dt-row');

/**
 * Both exports through Data sources, then in to the screen the test is about. The
 * heading is passed in because the last test has to start on the order book and walk
 * back, and a helper that only ever expects one heading cannot be used for that.
 */
async function withExports(page: Page, route = '/schedule', heading = 'The making plan'): Promise<void> {
  await openApp(page, '/sources');
  await importBoth(page);
  await waitForStockTable(page);
  // A code is not a make until the shop ticks it, and the plan is built from the tick.
  // Ticking them all is the shop's own first-run step; which codes are short stays the
  // export's business, so nothing here hard-codes a code or a quantity.
  await markAllCurrent(page);
  await page.goto(`/#${route}`);
  await expect(page.getByRole('heading', { name: heading })).toBeVisible();
}

async function chipCount(page: Page, bucket: string): Promise<number> {
  const chip = page.locator(`[data-schedule-bucket="${bucket}"]`);
  await expect(chip).toBeVisible();
  const text = (await chip.textContent()) ?? '';
  const digits = /([\d,]+)/.exec(text.trim());
  if (!digits) throw new Error(`the ${bucket} chip carries no count: ${text}`);
  return Number(digits[1].replace(/,/g, ''));
}

/** The screen's own row count while filtering: "N of M rows". */
async function filteredCount(page: Page): Promise<number> {
  const note = page.locator('[data-schedule-filtered]');
  await expect(note).toBeVisible();
  const text = (await note.textContent()) ?? '';
  const match = /^([\d,]+) of [\d,]+ rows/.exec(text.trim());
  if (!match) throw new Error(`the filter note does not read like a count: ${text}`);
  return Number(match[1].replace(/,/g, ''));
}

/**
 * A code the plan says has to be made, read off the screen.
 *
 * Which codes are short is the export's business, not the test's, so the tests act on
 * whatever the plan puts in front of them. The wait has to be an assertion: a grid
 * that has not drawn its first row yet is not a plan with nothing on it, and
 * `count()` does not wait.
 */
async function someRowCode(page: Page): Promise<string> {
  const codes = page.locator('.dt-row .dt-cell[data-col="code"]');
  await expect(codes.first(), 'the plan has rows on screen').toBeVisible({ timeout: 15_000 });
  const count = Math.min(await codes.count(), 10);
  for (let i = 0; i < count; i += 1) {
    const value = (await codes.nth(i).textContent())?.trim() ?? '';
    if (/^[A-Z0-9-]{2,}$/.test(value)) return value;
  }
  throw new Error(`no item code in the first ${count} rows of the plan`);
}

/** Press the row for a code and wait for the card under the table to open. */
async function openRowFor(page: Page, code: string): Promise<void> {
  const row = page.locator('.dt-row').filter({ has: page.locator(`.dt-cell[data-col="code"][title="${code}"]`) });
  await expect(row.first(), `a plan row for ${code}`).toBeVisible({ timeout: 15_000 });
  await row.first().click();
  await expect(page.locator('[data-schedule-detail]')).toBeVisible();
}

async function searchThePlan(page: Page, term: string): Promise<void> {
  await page.locator('[data-schedule-search]').fill(term);
  await expect(page.locator('[data-schedule-filtered]')).toBeVisible();
}

test.describe('the making plan', () => {
  test('says so plainly on a device that has never read the order book', async ({ page }) => {
    await openApp(page, '/schedule');

    await expect(page.getByRole('heading', { name: 'The making plan' })).toBeVisible();
    await expect(page.getByText('No promises to plan against')).toBeVisible();
    await expect(page.getByText('Sales [Item Detail]')).toBeVisible();
    // Every screen in the app is built now: nothing may say it is waiting to be wired up.
    await expect(page.getByText(/not wired up/i)).toHaveCount(0);

    await page.getByRole('main').getByRole('button', { name: 'Data sources', exact: true }).click();
    await expect(page).toHaveURL(/#\/sources/);
  });

  test('shows the plan and gives each pile the count it really holds', async ({ page }) => {
    await withExports(page);

    await expect(rowsOn(page).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/rows · .* codes ·/).first()).toBeVisible();
    // Before anything is written, the whole plan is promises with nothing behind them.
    const nothingPlanned = await chipCount(page, 'all');
    expect(await chipCount(page, 'behind')).toBeLessThanOrEqual(nothingPlanned);

    for (const bucket of ['behind', 'week', 'later', 'undated'] as const) {
      const onChip = await chipCount(page, bucket);
      await page.locator(`[data-schedule-bucket="${bucket}"]`).click();
      expect(await filteredCount(page), `the ${bucket} pile`).toBe(onChip);
      await page.locator('[data-schedule-clear]').click();
      await expect(page.locator('[data-schedule-filtered]')).toHaveCount(0);
    }
  });

  test('says on every row whether anybody has planned it yet', async ({ page }) => {
    await withExports(page);
    const code = await someRowCode(page);

    await openRowFor(page, code);
    await expect(page.locator('[data-schedule-detail]')).toContainText('Nothing has been written down for this yet');
    const status = page
      .locator('.dt-row')
      .filter({ has: page.locator(`.dt-cell[data-col="code"][title="${code}"]`) })
      .first()
      .locator('.dt-cell[data-col="status"]');
    await expect(status).toHaveText('not yet');
  });

  test('explains where a start date comes from, and what it is made of', async ({ page }) => {
    await withExports(page);
    const code = await someRowCode(page);

    await openRowFor(page, code);
    const when = page.locator('[data-schedule-detail-when]');
    await expect(when).toContainText('has to have started by');
    const lead = page.locator('[data-schedule-detail-lead]');
    await expect(lead).toContainText('Lead time');
    await expect(lead).toContainText('days of cure');
    // And the rule that made it, spelled out under the table.
    await expect(page.getByText(/same arithmetic the Matrix tones use/)).toBeVisible();
  });

  test('refuses to plan a code the shop has not said how it is made', async ({ page }) => {
    await withExports(page);
    const code = await someRowCode(page);

    await openRowFor(page, code);
    const add = page.locator('[data-schedule-add]');
    if ((await add.count()) === 0) {
      // A code the shop does not make at all. The screen says so instead of offering
      // a button that would only fail.
      await expect(page.locator('[data-schedule-detail]')).toContainText('no cure time or route yet');
      return;
    }

    await add.click();
    await expect(page.getByText(/has no route set/)).toBeVisible();
    // Nothing was written: a refusal is not a half-write.
    await expect(page.locator('.dt-cell[data-col="status"]').filter({ hasText: 'planned' })).toHaveCount(0);
  });

  test('puts a promise on the plan, takes it off again, and uncovers the promise', async ({ page }) => {
    const isPhone = (await page.viewportSize())?.width !== undefined && (await page.viewportSize())!.width < 1024;
    await withExports(page);
    const code = await someRowCode(page);

    // The shop says how it makes the code — the plan will not guess a lead time.
    await page.goto('/#/products');
    await searchProducts(page, code);
    await enableProduct(page, code);
    await setProductRoute(page, code, 'manufacture');
    await page.goto('/#/schedule');
    await searchThePlan(page, code);
    await openRowFor(page, code);

    const add = page.locator('[data-schedule-add]');
    await expect(add).toBeVisible();
    if (isPhone) {
      // Gloved hands: the press target has to be a thumb target.
      const box = await add.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    await add.click();
    await expect(page.getByText(`${code} is on the plan`)).toBeVisible();

    const status = page
      .locator('.dt-row')
      .filter({ has: page.locator(`.dt-cell[data-col="code"][title="${code}"]`) })
      .first()
      .locator('.dt-cell[data-col="status"]');
    await expect(status).toHaveText('planned');

    // Take it off, and the promise comes back — the order never went away.
    await openRowFor(page, code);
    await page.getByRole('button', { name: 'Take it off the plan' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const confirm = dialog.getByRole('button', { name: 'Take it off' });
    await expect(confirm).toBeDisabled();
    await dialog.getByRole('textbox').fill('Customer took the order back');
    await expect(confirm).toBeEnabled();
    await confirm.click();

    await expect(status).toHaveText('not yet');
    await expect(page.getByText('Take it off the plan')).toHaveCount(0);
  });

  test('a plan line is not stock: the order book still says what is owed', async ({ page }) => {
    await withExports(page, '/jobs', 'The order book');
    const owed = page.getByText(/\d[\d,]* still owed/);
    await expect(owed).toBeVisible();
    const before = (await owed.textContent()) ?? '';

    await page.goto('/#/schedule');
    const code = await someRowCode(page);
    await page.goto('/#/products');
    await searchProducts(page, code);
    await enableProduct(page, code);
    await setProductRoute(page, code, 'manufacture');
    await page.goto('/#/schedule');
    await searchThePlan(page, code);
    await openRowFor(page, code);
    await page.locator('[data-schedule-add]').click();
    await expect(page.getByText(`${code} is on the plan`)).toBeVisible();

    await page.goto('/#/jobs');
    await expect(page.getByText(/\d[\d,]* still owed/)).toHaveText(before);
  });
});
