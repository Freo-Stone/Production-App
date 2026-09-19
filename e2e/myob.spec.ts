import type { Page } from '@playwright/test';
import { expect, test } from './support';
import { openApp, setupMadeProduct } from './support';

/**
 * The weekly MYOB run, driven through the real build.
 *
 * The point of this screen is that two different things — what gets copied out and
 * what gets marked entered — describe the same racks. In a browser that can be
 * proved end to end: a rack logged on Daily entry, taken off the cure, listed in
 * the run, copied out on one line with its brother, and then taken back out again
 * because somebody keyed the wrong thing. The clipboard is deliberately forced to
 * fail in one test: a press that silently does nothing on a shop floor tablet is
 * the failure this screen has to survive.
 */

const CODE = 'GL4';

const rows = (page: Page) => page.locator('[data-myob-rack]');
const rowFor = (page: Page, batchNo: string) => page.locator(`[data-myob-rack="${batchNo}"]`);
const lineFor = (page: Page, code: string) => page.locator(`[data-myob-line="${code}"]`);
const keyedRows = (page: Page) => page.locator('[data-myob-keyed]');

/** Quantity in a row, as displayed. */
async function rowQty(page: Page, batchNo: string): Promise<number> {
  const text = await rowFor(page, batchNo).textContent();
  const found = /([\d.,]+)\s*m²/.exec(text ?? '');
  if (found === null || found[1] === undefined) throw new Error(`no quantity shown on ${batchNo}: ${text}`);
  return Number.parseFloat(found[1].replace(',', '.'));
}

/**
 * Make a rack on Daily entry, four days back so its cure is done, take it off the
 * cure, and stand on the MYOB screen with it in the run. This is the whole route a
 * rack travels to get here, which is exactly what is worth re-proving.
 */
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
  // One press takes every rack that is due, which is how the floor does it. After it
  // the rack is on the ready pile — the MYOB queue's whole raw material.
  await page.locator('[data-curing-sweep]').click();
  await expect(page.locator(`[data-curing-offrack="${batchNo}"]`)).toBeVisible();

  await page.goto('/#/myob');
  await expect(rowFor(page, batchNo)).toBeVisible();
  return batchNo;
}

test.describe('the MYOB run', () => {
  test('an empty shop says there is nothing to key', async ({ page }) => {
    await openApp(page, '/myob');
    await expect(page.getByText('Nothing to key this week')).toBeVisible();
    await expect(rows(page)).toHaveCount(0);
  });

  test('a rack that came off the cure is in the run, with its entry day in words', async ({ page }) => {
    await setupMadeProduct(page, CODE);
    const batchNo = await readyRack(page, '8');

    await expect(page.getByText(/is the day the shop keys stock into MYOB/)).toBeVisible();
    const row = rowFor(page, batchNo);
    await expect(row).toContainText(CODE);
    await expect(row).toContainText('8 trays');
    // It has been off the cure for two days, and the row says when it came ready —
    // that is what tells the person keying it that this is not today's making.
    await expect(row).toContainText(/ready (yesterday|2 days ago)/);
    // The run heading names the day of the week, not just a date — a bare
    // 18/09/2026 does not tell you whether that run has been keyed already. Which label
    // it earns depends on the day the suite runs: the day after the shop's entry day,
    // Friday's run is overdue, and saying so is the screen doing its job. So the label
    // is allowed to be any of the four, and the weekday has to be there whichever it is.
    await expect(page.locator('[data-myob-run]').first()).toContainText(
      /(This run|Next run|Overdue|In \d+ weeks) — (Mon|Tue|Wed|Thu|Fri|Sat|Sun)/,
    );

    // One line for the code, and it carries the quantity of the rack.
    await expect(lineFor(page, CODE)).toBeVisible();
    expect(await lineFor(page, CODE).locator('td').nth(2).textContent()).toContain('8.00');

    // Desktop only: the menu tab is not on a phone, and its badge is a
    // desktop affordance. The count is the queue, not a guess.
    if ((page.viewportSize()?.width ?? 1280) >= 1024) {
      await expect(page.locator('nav').first().getByRole('button', { name: /MYOB/ })).toContainText('1');
    }
  });

  test('two racks of one code copy out as one line', async ({ page }) => {
    await setupMadeProduct(page, CODE);
    const first = await readyRack(page, '8');
    const second = await readyRack(page, '5');

    const mine = await rowQty(page, first);
    const yours = await rowQty(page, second);
    await expect(lineFor(page, CODE)).toHaveCount(1);
    expect(await lineFor(page, CODE).locator('td').nth(2).textContent()).toContain((mine + yours).toFixed(2));
    // One code, one line: this is the shape MYOB wants, and it is why the copy-out
    // is not simply the rack list printed out.
    await expect(page.getByText('1 line from 2 racks')).toBeVisible();
    await expect(page.getByText('Keyed, not in the export yet')).toHaveCount(0);
  });

  test('unticking a rack takes it out of the copy-out and the count', async ({ page }) => {
    await setupMadeProduct(page, CODE);
    const first = await readyRack(page, '8');
    const second = await readyRack(page, '5');

    await rowFor(page, second).getByRole('checkbox').click();
    await expect(rowFor(page, second)).toHaveAttribute('data-myob-picked', 'no');
    await expect(page.getByText('1 left out')).toBeVisible();
    await expect(page.getByText('1 of 2 racks ticked')).toBeVisible();
    expect(await lineFor(page, CODE).locator('td').nth(2).textContent()).toContain((await rowQty(page, first)).toFixed(2));
    await expect(page.getByText('1 line from 1 rack')).toBeVisible();
  });

  test('keying the run in moves it to the pile that is waiting for an export, and back', async ({ page }) => {
    await setupMadeProduct(page, CODE);
    const first = await readyRack(page, '8');
    const second = await readyRack(page, '5');

    await page.getByRole('button', { name: 'Mark entered' }).click();
    await expect(page.getByRole('dialog')).toContainText('Mark 2 racks entered');
    await expect(page.getByRole('dialog')).toContainText('does not type anything in for you');
    await page.getByPlaceholder('INV-0000').fill('INV-42');
    await page.getByRole('button', { name: 'They are in MYOB' }).click();

    await expect(page.getByText('2 racks keyed into MYOB')).toBeVisible();
    await expect(page.getByText('Nothing to key this week')).toBeVisible();
    await expect(keyedRows(page)).toHaveCount(2);
    const keyed = page.locator(`[data-myob-keyed="${first}"]`);
    await expect(keyed).toContainText('ref INV-42');
    await expect(keyed).toContainText('run ');

    // Keying goes wrong. One press puts the rack back where it came from.
    await keyed.getByRole('button', { name: 'It was not keyed' }).click();
    await expect(page.getByText('is back in the queue')).toBeVisible();
    await expect(rowFor(page, first)).toBeVisible();
    await expect(keyedRows(page)).toHaveCount(1);
    await expect(rowFor(page, second)).toHaveCount(0);
  });

  test('a clipboard that will not co-operate still leaves the text on the screen', async ({ page }) => {
    // Both routes the app can copy by are closed off, which is the situation on a
    // tablet that has lost focus or a browser served over plain http.
    await page.addInitScript(() => {
      Object.defineProperty(window.navigator, 'clipboard', {
        value: { writeText: () => Promise.reject(new Error('denied')) },
        configurable: true,
      });
      document.execCommand = () => false;
    });
    await setupMadeProduct(page, CODE);
    await readyRack(page, '8');

    await page.getByRole('button', { name: 'Copy for MYOB' }).click();
    await expect(page.getByText('The browser would not let the app copy')).toBeVisible();
    const box = page.locator('[data-myob-copytext]');
    await expect(box).toBeVisible();
    await expect(box).toContainText('Item No.');
    await expect(box).toContainText(CODE);
  });

  test('the run can be written out as a CSV file', async ({ page }) => {
    await setupMadeProduct(page, CODE);
    await readyRack(page, '8');

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'CSV', exact: true }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^freo-myob-run-\d{4}-\d{2}-\d{2}\.csv$/);
  });

});

test.describe('the run on a phone', () => {
  test('the buttons are thumb-sized and the dialog stays on the screen', async ({ page }) => {
    await setupMadeProduct(page, CODE);
    await readyRack(page, '8');

    const width = page.viewportSize()?.width ?? 0;
    test.skip(width >= 1024, 'thumb targets are a phone question');

    for (const name of ['Copy for MYOB', 'CSV', 'Mark entered']) {
      const button = page.getByRole('button', { name });
      const box = await button.boundingBox();
      expect(box, `${name} is on screen`).not.toBeNull();
      expect(box?.height ?? 0, `${name} is thumb-sized`).toBeGreaterThanOrEqual(44);
      // The card header used to clip the third button mid-word on a phone. Nothing
      // of a button a person has to press may be off the side of the screen.
      if (box !== null) {
        expect(box.x + box.width, `${name} is inside the screen`).toBeLessThanOrEqual(width + 1);
      }
    }

    // Nothing may hang off the side of the screen: the copy-out table scrolls
    // inside its own frame rather than stretching the page.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);

    await page.getByRole('button', { name: 'Mark entered' }).click();
    await page.waitForTimeout(700); // the sheet springs up; measure it at rest
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    const height = page.viewportSize()?.height ?? 0;
    expect(box).not.toBeNull();
    if (box !== null) {
      expect(box.y).toBeGreaterThanOrEqual(-1);
      expect(box.y + box.height, 'the dialog fits above the bottom of the screen').toBeLessThanOrEqual(height + 1);
    }
    await expect(dialog.getByRole('button', { name: 'They are in MYOB' })).toBeVisible();
  });
});
