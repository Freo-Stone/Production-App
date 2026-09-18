import type { Page } from '@playwright/test';
import { expect, test } from './support';
import { importBoth, openApp, productCell, searchProducts, setupMadeProduct } from './support';

/**
 * The floor's own screen, driven through the real build.
 *
 * Everything here is about the one transaction that matters on a production day:
 * someone counts trays, the screen turns them into a quantity, and a rack with a
 * date on it exists afterwards — on this device, and on no other device's say-so.
 * The shop's real export shapes are imported first, because that is where the
 * product codes come from, and a made-up code would prove nothing.
 */

const CODE = 'GL4';

// The Products grid helpers live in support.ts now that two screens drive it; these
// are the local names the rest of this file reads best with.
const search = searchProducts;
const cell = productCell;

/**
 * Make GL4 a current product, the way the shop does it on the Products screen —
 * and say how it is made, because a code cannot be logged until it has a route.
 * `null` leaves the route out, which is where an imported code starts.
 */
const switchOn = (page: Page, route: 'manufacture' | 'shotblast' | null = 'manufacture') => setupMadeProduct(page, CODE, route);

const trays = (page: Page) => page.getByLabel('Trays');

/** One row of the day, as the screen shows it. */
const rack = (page: Page, nth = 0) => page.locator('[data-logged-batch]').nth(nth);

test.describe('daily entry', () => {
  /** The second current product in the second test, resolved from the export. */
  let second = '';

  test('a code that is not set up stops the sheet, and says which screen fixes it', async ({ page }) => {
    await switchOn(page, null);
    // An imported code arrives with no route: the export does not know how it is made.
    await page.goto('/#/entry');
    await expect(page.getByRole('button', { name: /Another product/ })).toBeVisible();

    await page.getByLabel('Product').selectOption(CODE);
    await trays(page).fill('10');

    await expect(page.locator('[data-entry-problem]')).toHaveText(`${CODE} has no route — set it on Products`);
    await expect(page.locator('[data-entry-submit]')).toBeDisabled();
    await expect(page.getByText('Nothing logged yet')).toBeVisible();
  });

  test('a day of making is logged, and is still there when the browser is reopened', async ({ page }) => {
    await switchOn(page);
    await page.goto('/#/entry');

    await page.getByLabel('Product').selectOption(CODE);
    await trays(page).fill('10');
    // Trays × yield, shown before anything is written down. An imported code yields
    // 1.00 per tray until the shop changes it, which is exactly what the preview says.
    await expect(page.locator('[data-entry-qty]')).toHaveText('10.00 m²');
    await expect(page.locator('[data-entry-totals]')).toHaveText('10 trays · 10.00 m²');

    await page.getByRole('button', { name: /Log 10 trays on Line 1/ }).click();
    await expect(rack(page)).toBeVisible();
    await expect(rack(page)).toContainText(CODE);
    await expect(rack(page)).toContainText('Curing');

    // The cure clock: two days from today on this shop's default cure.
    await expect(rack(page)).toContainText('in 2 days');

    await page.reload();
    await expect(rack(page)).toBeVisible();

    // The board's counts are no longer guesses: the curing count in the menu is the
    // number of racks on the clock, and it woke up the moment one existed.
    // The count in the menu, whichever bar this device is showing.
    await expect(page.locator('nav:visible').first().getByRole('button', { name: /Curing/ })).toContainText('1');
  });

  test('a shotblast make waits for the blaster as well as the cure', async ({ page }) => {
    await switchOn(page, 'shotblast');
    await page.goto('/#/entry');

    await page.getByLabel('Product').selectOption(CODE);
    await trays(page).fill('5');
    await page.getByRole('button', { name: /Log 5 trays/ }).click();

    await expect(rack(page)).toContainText('Needs blast');

    // The blaster's queue count lives on the Shotblast menu item, which a phone
    // keeps in the More sheet — and that sheet shows no counts yet. So on a narrow
    // screen the rack label is the evidence, and the missing count is written down
    // in TASKS.md rather than quietly asserted away.
    if ((page.viewportSize()?.width ?? 1280) >= 640) {
      await expect(page.locator('nav:visible').first().getByRole('button', { name: /Shotblast/ })).toContainText('1');
    } else {
      expect(await rack(page).textContent()).toContain('Needs blast');
    }
  });

  test('two products on one line are two racks, and a wrong one can be taken back', async ({ page }) => {
    await switchOn(page);
    // A second current product, so this is a sheet and not one box. Whatever the
    // export's first code is: the point is two codes, not which two.
    await search(page, '');
    const other = await page
      .locator('[data-col="code"]')
      .evaluateAll(
        // The exclusion runs in the page, so the code has to be handed in — a module
        // constant does not exist over there.
        (cs, not) => cs.map((c) => (c.textContent ?? '').trim()).find((x) => x !== '' && x !== not),
        CODE,
      );
    expect(other).toBeTruthy();
    second = other as string;
    await cell(page, second, 'enabled').locator('[role="checkbox"]').click();
    await cell(page, second, 'route').locator('select').selectOption('manufacture');

    await page.goto('/#/entry');
    await page.getByLabel('Product').first().selectOption(CODE);
    await trays(page).first().fill('4');
    await page.getByRole('button', { name: /Another product/ }).click();
    await page.getByLabel('Product').nth(1).selectOption(second as string);
    await trays(page).nth(1).fill('6');
    await expect(page.locator('[data-entry-totals]')).toContainText('10 trays');

    await page.getByRole('button', { name: /Log 10 trays/ }).click();
    await expect(page.locator('[data-logged-batch]')).toHaveCount(2);

    const numbers = await page.locator('[data-logged-batch]').evaluateAll((rows) =>
      rows.map((r) => r.getAttribute('data-logged-batch') ?? ''),
    );
    expect(numbers).toHaveLength(2);
    expect(new Set(numbers).size).toBe(2);

    await page.getByRole('button', { name: /Take back/ }).first().click();
    await expect(page.locator('[data-logged-batch]')).toHaveCount(1);
  });

  test('the board sends someone here with the product already chosen', async ({ page }) => {
    await switchOn(page);

    await page.goto('/#/');
    await page.getByPlaceholder('Filter code or product…').fill(CODE);
    await page.locator('[role="row"]').filter({ hasText: CODE }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('In stock')).toBeVisible();

    await dialog.getByRole('button', { name: 'Log making of this' }).click();
    await expect(page).toHaveURL(/#\/entry$/);
    await expect(page.getByLabel('Product')).toHaveValue(CODE);
  });

  test('the sheet stays on the screen and under a thumb', async ({ page }) => {
    const width = page.viewportSize()?.width ?? 1280;
    await switchOn(page);
    await page.goto('/#/entry');
    await page.getByLabel('Product').selectOption(CODE);
    await trays(page).fill('10');

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);

    if (width < 640) {
      // The button a person hits with a glove on has to be a target, not a link.
      const box = await page.locator('[data-entry-submit]').boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
  });
});
