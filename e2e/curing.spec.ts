import type { Page } from '@playwright/test';
import { expect, test } from './support';
import { openApp, setupMadeProduct } from './support';

/**
 * The cure racks, driven through the real build.
 *
 * The two things worth proving in a browser are the two a person does with their
 * hands: taking a rack off the cure, and writing one off with a reason. Everything
 * else on the screen is arithmetic that the unit tests already hold — but the
 * order racks appear in, and the refusal to offer a button for a rack that still
 * owes a blast, are things you can only see by looking.
 */

const CODE = 'GL4';

const rows = (page: Page) => page.locator('[data-curing-rack]');
const firstRow = (page: Page) => rows(page).first();

/**
 * Log a day's making the way the floor does it — on Daily entry — and come back to
 * the racks to look at what was made. `backDays` is the back-dated sheet a night
 * shift writes up the next morning, and it is also the only honest way to get a
 * rack that has finished curing without waiting four days.
 */
async function logTrays(page: Page, trays: string, backDays = 0): Promise<string> {
  await page.goto('/#/entry');
  for (let i = 0; i < backDays; i += 1) {
    await page.getByRole('button', { name: 'The day before' }).click();
  }
  await page.getByLabel('Product').selectOption(CODE);
  await page.getByLabel('Trays').fill(trays);
  await page.getByRole('button', { name: new RegExp(`Log ${trays} trays`) }).click();
  await page.goto('/#/curing');
  await expect(rows(page).first()).toBeVisible();
  const batchNo = await rows(page).first().getAttribute('data-curing-rack');
  if (batchNo === null) throw new Error('the rack has no batch number on screen');
  return batchNo;
}

test.describe('the cure racks', () => {
  test('an empty shop says so, and does not invent a rack', async ({ page }) => {
    await openApp(page, '/curing');
    await expect(page.getByText('No racks on the clock')).toBeVisible();
    await expect(rows(page)).toHaveCount(0);
  });

  test('a day logged on the floor is on the racks with the day it comes off', async ({ page }) => {
    await setupMadeProduct(page, CODE);
    const batchNo = await logTrays(page, '10');

    const row = page.locator(`[data-curing-rack="${batchNo}"]`);
    await expect(row).toContainText(CODE);
    await expect(row).toContainText('10 trays');
    // Two days of cure on this shop's default, so it is not anyone's problem today.
    await expect(row).toContainText('due in 2 days');
    await expect(row.getByRole('button', { name: 'Take it off' })).toHaveCount(0);
    await expect(page.getByText('Later this week')).toBeVisible();

    // The menu count is the number of racks on the clock, not a guess.
    await expect(page.locator('nav:visible').first().getByRole('button', { name: /Curing/ })).toContainText('1');
  });

  test('a rack that has come off the cure is offered, and one press moves the lot', async ({ page }) => {
    await setupMadeProduct(page, CODE);
    const batchNo = await logTrays(page, '8', 4);

    // Four days old on a two-day cure: it is done, and nobody has moved it.
    await expect(page.locator(`[data-curing-rack="${batchNo}"]`)).toContainText('off the cure now');
    const offer = page.locator('[data-curing-offer]');
    await expect(offer).toContainText('1 rack has come off the cure');
    await expect(offer.getByText(/oldest has sat there 2 days/)).toBeVisible();

    await page.locator('[data-curing-sweep]').click();
    await expect(rows(page)).toHaveCount(0);

    // It did not vanish. It is on the ready pile, which the MYOB queue works
    // through — and it stays on this screen, because a rack nobody can see is a
    // rack nobody can put back.
    const offRow = page.locator(`[data-curing-offrack="${batchNo}"]`);
    await expect(offRow).toContainText('8 trays');
    await expect(page.locator('nav:visible').first().getByRole('button', { name: /MYOB/ })).toContainText('1');

    await page.reload();
    await expect(offRow).toBeVisible();

    // One press puts it back on the cure, and the ready pile lets go of it.
    await page.locator(`[data-curing-putback="${batchNo}"]`).click();
    await expect(rows(page)).toHaveCount(1);
    await expect(page.locator(`[data-curing-rack="${batchNo}"]`)).toContainText('off the cure now');
    await expect(page.locator('nav:visible').first().getByRole('button', { name: /MYOB/ })).not.toContainText('1');
  });

  test('a write-off is refused without a reason, and written down with one', async ({ page }) => {
    await setupMadeProduct(page, CODE);
    const batchNo = await logTrays(page, '5', 4);

    const dialog = page.getByRole('dialog');
    await page.locator(`[data-curing-writeoff="${batchNo}"]`).click();
    await expect(dialog.getByText(`Write ${batchNo} off`)).toBeVisible();

    // No reason, no write-off. The button says so before anyone has to be told.
    const confirm = dialog.getByRole('button', { name: 'Write it off' });
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel('Why this rack is being written off').fill('Cracked in the sling');
    await expect(confirm).toBeEnabled();
    await confirm.click();

    await expect(rows(page)).toHaveCount(0);
    await page.reload();
    await expect(page.getByText('No racks on the clock')).toBeVisible();
    // A write-off empties the racks; it does not put anything on the ready pile, so
    // the menu counts stay where they were.
    await expect(page.locator('nav:visible').first().getByRole('button', { name: /Curing/ })).not.toContainText('1');
  });

  test('a shotblast make waits for the blaster instead of being offered as ready', async ({ page }) => {
    await setupMadeProduct(page, CODE, 'shotblast');
    const batchNo = await logTrays(page, '5', 4);

    const row = page.locator(`[data-curing-rack="${batchNo}"]`);
    // Its cure is long over, and it is still not usable. That is the whole point.
    await expect(page.getByText('Waits for something')).toBeVisible();
    await expect(row).toContainText('Needs blast');
    await expect(row.getByRole('button', { name: 'Take it off' })).toHaveCount(0);
    await expect(row.locator('[data-curing-problem]')).toContainText('still has 5 to go through the blaster');
    await expect(page.locator('[data-curing-sweep]')).toHaveCount(0);
    await expect(page.getByText('Nothing is due')).toBeVisible();
  });
});
