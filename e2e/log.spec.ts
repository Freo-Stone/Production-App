import type { Page } from '@playwright/test';
import { expect, test } from './support';
import { openApp, setupMadeProduct } from './support';

/**
 * The production log, driven through the real build.
 *
 * This is the first screen that *reads* the ledger. Eighteen places in the app write
 * a line — Daily entry, Curing, the blaster, the MYOB run, Sources when an export is
 * loaded, the sign-in screen — and until now nothing had ever read one back. So these
 * tests are deliberately cross-screen: the lines on this page come from work done on
 * other pages, which is the only way to prove that what the floor did is actually
 * written down somewhere.
 *
 * A fresh device is never empty in a browser, because signing in is itself a ledger
 * line. That is worth asserting rather than working around: the diary really does
 * start at the day the device was set up.
 */

const CODE = 'GL4';

const lines = (page: Page) => page.locator('[data-log-line]');
const today = (page: Page) => page.locator('section.card').filter({ has: page.getByRole('heading', { name: 'Today', exact: true }) });

async function logTrays(page: Page, trays: string): Promise<void> {
  await page.goto('/#/entry');
  await page.getByLabel('Product').selectOption(CODE);
  await page.getByLabel('Trays').fill(trays);
  await page.getByRole('button', { name: new RegExp(`Log ${trays} trays`) }).click();
}

/** A rack logged four days back and taken off the cure, so it has a history. */
async function readyRack(page: Page, trays = '8'): Promise<string> {
  await page.goto('/#/entry');
  for (let i = 0; i < 4; i += 1) {
    await page.getByRole('button', { name: 'The day before' }).click();
  }
  await page.getByLabel('Product').selectOption(CODE);
  await page.getByLabel('Trays').fill(trays);
  await page.getByRole('button', { name: new RegExp(`Log ${trays} trays`) }).click();

  await page.goto('/#/curing');
  const cure = page.locator('[data-curing-rack]').first();
  await expect(cure).toContainText('off the cure now');
  const batchNo = await cure.getAttribute('data-curing-rack');
  if (batchNo === null) throw new Error('the rack has no batch number on screen');
  await page.locator('[data-curing-sweep]').click();
  await expect(page.locator(`[data-curing-offrack="${batchNo}"]`)).toBeVisible();
  return batchNo;
}

test.describe('the production log', () => {
  test('the diary starts at the day the device was set up', async ({ page }) => {
    await openApp(page, '/log');

    await expect(page.getByRole('heading', { name: 'The production log' })).toBeVisible();
    await expect(page.getByText(/lines on this device/)).toBeVisible();
    // Signing in is a ledger line: who first used this tablet is the first thing the
    // shop would want to know about it.
    await expect(today(page)).toContainText(/signed in/);
    await expect(lines(page)).not.toHaveCount(0);
  });

  test('what the floor did today is in the diary, under today', async ({ page }) => {
    await setupMadeProduct(page, CODE);
    await logTrays(page, '8');

    await page.goto('/#/log');
    await expect(today(page)).toContainText(`${CODE} on Line 1`);
    await expect(today(page)).toContainText('8 trays of GL4');
    // The day tells you what it was made of before you read a single line — in
    // sentences on a desktop, in counters on a phone where the sentence is cut off.
    await expect(today(page)).toContainText(/\d+ on the floor|floor \d+/);

    // The export that set the shop up is in here too — nothing that changed the
    // shop's numbers is off the record. Pressed by its own hook: the chip's accessible
    // name carries the count as well, so a name match would be a guess.
    await page.locator('[data-log-family-filter="stock"]').click();
    await expect(today(page).locator('[data-log-family="stock"]')).not.toHaveCount(0);
    await expect(page.getByText(/hidden by the filter/)).toBeVisible();
  });

  test('every screen a rack passed through left a line, and one press reads them all', async ({ page }) => {
    await setupMadeProduct(page, CODE);
    const batchNo = await readyRack(page, '8');

    await page.goto('/#/myob');
    await page.getByRole('button', { name: 'Mark entered' }).click();
    await page.locator('[data-myob-ref]').fill('INV-42');
    await page.getByRole('button', { name: 'They are in MYOB' }).click();
    await expect(page.getByText('Nothing to key this week')).toBeVisible();

    await page.goto('/#/log');
    const rack = today(page).locator('[data-log-line]').filter({ hasText: batchNo });
    await expect(rack.filter({ hasText: 'off the racks' })).toHaveCount(1);
    await expect(rack.filter({ hasText: 'keyed into MYOB' })).toHaveCount(1);
    await expect(rack.filter({ hasText: 'INV-42' })).toHaveCount(1);

    // One rack's whole story, from the line that mentions it.
    await rack.first().getByRole('button', { name: 'This rack' }).click();
    await expect(page).toHaveURL(/rack=/);
    await expect(page.getByRole('heading', { name: 'One rack’s history' })).toBeVisible();
    await expect(page.getByText(new RegExp(`Every line about ${batchNo}`))).toBeVisible();
    await expect(lines(page)).toHaveCount(3);
    // Nothing about any other rack, and nothing left to narrow by.
    await expect(page.locator('[data-log-line]').filter({ hasText: /2026-\d\d-\d\d-\d\d/ })).toHaveCount(3);
    await expect(page.locator('[data-log-family-filter]')).toHaveCount(0);

    await page.getByRole('button', { name: 'Every line' }).click();
    await expect(page.getByRole('heading', { name: 'The production log' })).toBeVisible();
    // Back at the diary: the whole shop's lines again, and the filters with them.
    await expect(page.locator('[data-log-family-filter]')).not.toHaveCount(0);
    await expect(lines(page)).not.toHaveCount(0);
  });

  test('a search finds the rack by the number a person would read', async ({ page }) => {
    await setupMadeProduct(page, CODE);
    const batchNo = await readyRack(page, '6');

    await page.goto('/#/log');
    await expect(today(page)).toBeVisible();
    const before = await lines(page).count();
    expect(before).toBeGreaterThan(3);

    await page.locator('[data-log-query]').fill(batchNo);
    // The two lines this fixture wrote about the rack, and nothing else.
    await expect(lines(page)).toHaveCount(2);

    const shown = await lines(page).allTextContents();
    expect(shown.length).toBe(2);
    for (const text of shown) {
      expect(text, `“${text}” is about the rack searched for`).toContain(batchNo);
    }
    await expect(page.getByText(/hidden by the filter/)).toBeVisible();

    // A number that exists nowhere leaves the honest empty state, not a blank page.
    await page.locator('[data-log-query]').fill('2099-01-01-99');
    await expect(page.getByRole('heading', { name: 'Nothing matches' })).toBeVisible();
    await page.getByRole('button', { name: 'Clear the filters' }).click();
    await expect(page.locator('[data-log-line]')).toHaveCount(before);
  });

  test('only offers to go back further when there really is more to read', async ({ page }) => {
    await setupMadeProduct(page, CODE);
    await readyRack(page, '8');
    await logTrays(page, '4');

    await page.goto('/#/log');
    await expect(today(page)).toBeVisible();
    // Everything this fixture wrote fits inside one page, so there is no "Show
    // earlier lines" button that would do nothing, and no "showing 400 of 9,000"
    // hedge. The screen reads the size of the log rather than assuming.
    const shown = await lines(page).count();
    expect(shown).toBeGreaterThan(3);
    await expect(page.locator('[data-log-earlier]')).toHaveCount(0);
    await expect(page.getByText(/showing \d+ of \d+/)).toHaveCount(0);
    await expect(page.getByText(/^\d+ lines on this device/)).toBeVisible();
  });
});

test.describe('the log on a phone', () => {
  test('the diary fits, and the filters are thumb-sized', async ({ page }) => {
    await setupMadeProduct(page, CODE);
    await readyRack(page, '8');
    await page.goto('/#/log');

    const width = page.viewportSize()?.width ?? 0;
    test.skip(width >= 1024, 'thumb targets are a phone question');

    await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
    // A phone day header counts in counters: the sentence form is cut off mid-word
    // at this width, which is worse than saying less.
    const todayHeader = today(page);
    await expect(todayHeader).toContainText(/floor \d+/);
    await expect(todayHeader).not.toContainText('on the floor');
    // Measured by their own hooks: the Shell's tab bar has a MYOB button too, and a
    // name match would measure the nav instead of the filter.
    for (const key of ['floor', 'myob', 'stock']) {
      const button = page.locator(`[data-log-family-filter="${key}"]`);
      const box = await button.boundingBox();
      expect(box, `${key} is on screen`).not.toBeNull();
      expect(box?.height ?? 0, `${key} is thumb-sized`).toBeGreaterThanOrEqual(44);
      if (box !== null) {
        expect(box.x + box.width, `${key} is inside the screen`).toBeLessThanOrEqual(width + 1);
      }
    }

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);

    // The line text is the point of the screen; it must not be clipped away.
    const line = lines(page).first();
    await expect(line).toContainText('·');
    const box = await line.boundingBox();
    if (box !== null) expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
  });
});
