import type { Page } from '@playwright/test';
import { expect, test } from './support';
import { openApp, setupMadeProduct } from './support';

/**
 * The blaster, driven through the real build.
 *
 * A blast is the one production action that creates a record as well as changing
 * one: part-blasting a rack splits it into two batches with two numbers. That is
 * what this file is for — the split, the numbers, and the fact that the blasted
 * half turns up on the cure screen where a person will look for it. The arithmetic
 * behind it is already held by the unit suite.
 */

const CODE = 'A3';

const rows = (page: Page) => page.locator('[data-blast-rack]');

/** Log a shotblast make on Daily entry, the way the floor does it. */
async function logTrays(page: Page, trays: string, backDays = 0): Promise<string> {
  await page.goto('/#/entry');
  for (let i = 0; i < backDays; i += 1) {
    await page.getByRole('button', { name: 'The day before' }).click();
  }
  await page.getByLabel('Product').selectOption(CODE);
  await page.getByLabel('Trays').fill(trays);
  await page.getByRole('button', { name: new RegExp(`Log ${trays} trays`) }).click();
  await page.goto('/#/shotblast');
  await expect(rows(page).first()).toBeVisible();
  const batchNo = await rows(page).first().getAttribute('data-blast-rack');
  if (batchNo === null) throw new Error('the rack has no batch number on screen');
  return batchNo;
}

test.describe('the blaster', () => {
  test('an empty shop says the machine is clear', async ({ page }) => {
    await openApp(page, '/shotblast');
    await expect(page.getByText('The blaster is clear')).toBeVisible();
    await expect(rows(page)).toHaveCount(0);
  });

  test('a shotblast make is in the queue the day it is logged', async ({ page }) => {
    await setupMadeProduct(page, CODE, 'shotblast');
    const batchNo = await logTrays(page, '6');

    const row = page.locator(`[data-blast-rack="${batchNo}"]`);
    await expect(row).toContainText(CODE);
    await expect(row).toContainText('6 trays');
    await expect(row).toContainText('Needs blast');
    // Two days of cure on this shop's default, so nothing is waiting on it yet.
    await expect(row).toContainText('cure due in 2 days');
    await expect(page.getByRole('heading', { name: 'Waiting for the blaster' })).toBeVisible();
    await expect(page.locator('[data-blast-section="cure-done"]')).toHaveCount(0);

    // On a desk, the menu counts what the machine owes: this rack, and only it.
    // (The phone tab bar carries Curing and MYOB rather than the blaster.)
    if ((page.viewportSize()?.width ?? 1280) >= 1024) {
      await expect(page.locator('nav:visible').first().getByRole('button', { name: /Shotblast/ })).toContainText('1');
    }
  });

  test('a rack goes onto the machine and comes off it', async ({ page }) => {
    await setupMadeProduct(page, CODE, 'shotblast');
    const batchNo = await logTrays(page, '8');

    await page.locator(`[data-blast-start="${batchNo}"]`).click();
    const running = page.locator(`[data-blast-rack="${batchNo}"]`);
    await expect(running).toContainText('On the blaster');
    await expect(page.getByRole('heading', { name: 'On the blaster' })).toBeVisible();
    await expect(page.locator(`[data-blast-start="${batchNo}"]`)).toHaveCount(0);

    await running.getByRole('button', { name: "It's done" }).click();
    await expect(rows(page)).toHaveCount(0);
    await expect(page.getByText('The blaster is clear')).toBeVisible();

    // The blasted rack is not gone: it is back on the racks, and because this shop
    // lets the blast stand in for the cure, the cure screen already offers it.
    await page.goto('/#/curing');
    const rack = page.locator(`[data-curing-rack="${batchNo}"]`);
    await expect(rack).toContainText('8 trays');
    await expect(rack).toContainText('off the cure now');

    // And it survives a reload — the blast is a record, not a screen state.
    await page.goto('/#/shotblast');
    await expect(page.getByText('The blaster is clear')).toBeVisible();
  });

  test('part of a rack comes out and the rest waits under a number of its own', async ({ page }) => {
    await setupMadeProduct(page, CODE, 'shotblast');
    const batchNo = await logTrays(page, '8');

    await page.locator(`[data-blast-part="${batchNo}"]`).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(`How much of ${batchNo} came out?`)).toBeVisible();

    await dialog.getByLabel('How many trays went through the blaster').fill('3');
    await expect(dialog).toContainText('3 trays come out blasted and keep');
    await expect(dialog).toContainText('The other 5 become their own rack, still to be blasted.');

    await dialog.getByRole('button', { name: 'Out of the blaster' }).click();

    // The queue holds one rack before this and one after, so the count alone tells
    // you nothing: wait for the screen to let go of the number that went in, then
    // read what is left. Otherwise you are reading the row that was there before.
    await expect(page.locator(`[data-blast-rack="${batchNo}"]`)).toHaveCount(0);
    await expect(rows(page)).toHaveCount(1);
    const remainder = rows(page).first();
    await expect(remainder).toContainText('5 trays');
    const remainderNo = await remainder.getAttribute('data-blast-rack');
    expect(remainderNo).not.toBe(batchNo);
    await expect(remainder).toContainText('Needs blast');

    // The three blasted trays are where a person will look for them: on the racks.
    await page.goto('/#/curing');
    const blasted = page.locator(`[data-curing-rack="${batchNo}"]`);
    await expect(blasted).toContainText('3 trays');

    // Back at the machine, the split is still there and the original is not.
    await page.goto('/#/shotblast');
    await expect(rows(page)).toHaveCount(1);
    await expect(page.locator(`[data-blast-rack="${batchNo}"]`)).toHaveCount(0);
    await expect(page.locator(`[data-blast-rack="${remainderNo}"]`)).toBeVisible();
  });

  test('the dialog will not record a number that is not a count of trays', async ({ page }) => {
    await setupMadeProduct(page, CODE, 'shotblast');
    const batchNo = await logTrays(page, '8');
    const box = page.getByLabel('How many trays went through the blaster');
    const confirm = page.getByRole('button', { name: 'Out of the blaster' });

    await page.locator(`[data-blast-part="${batchNo}"]`).click();
    const dialog = page.getByRole('dialog');
    await expect(confirm).toBeDisabled();

    await box.fill('12');
    await expect(dialog).toContainText('Only 8 trays are on that rack.');
    await expect(confirm).toBeDisabled();

    await box.fill('3');
    await expect(dialog).toContainText('3 trays come out blasted');
    await expect(confirm).toBeEnabled();

    // Backing out records nothing at all.
    await dialog.getByRole('button', { name: 'Leave it alone' }).click();
    await expect(rows(page)).toHaveCount(1);
    await expect(page.locator(`[data-blast-rack="${batchNo}"]`)).toContainText('8 trays');
  });

  test('the queue fits the phone and the buttons fit a thumb', async ({ page }) => {
    const width = page.viewportSize()?.width ?? 1280;
    await setupMadeProduct(page, CODE, 'shotblast');
    const batchNo = await logTrays(page, '6');

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);

    if (width < 640) {
      const start = await page.locator(`[data-blast-start="${batchNo}"]`).boundingBox();
      expect(start?.height ?? 0).toBeGreaterThanOrEqual(44);
      const part = await page.locator(`[data-blast-part="${batchNo}"]`).boundingBox();
      expect(part?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
  });
});
