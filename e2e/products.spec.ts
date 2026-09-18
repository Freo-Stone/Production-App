import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from './support';
import { importBoth, openApp } from './support';

/**
 * Product settings, driven through the real build.
 *
 * The exports hand over a couple of thousand codes and no idea which ones are
 * made here. This is the screen where that gets answered, so the checks are the
 * ones that matter on the floor: a tick that sticks, a figure that survives a
 * reload, an order that stays where it was dragged, and a CSV that carries the
 * whole set of decisions out of the browser.
 */
const search = (page: Page, term: string) =>
  page.getByPlaceholder('Filter code, description or note…').fill(term);

/**
 * One cell, addressed by row code and column key so a column reorder cannot
 * mislead it. The row is matched by the exact text of its code cell — a substring
 * match would pick C34 when asked for C3.
 */
const cell = (page: Page, code: string, column: string) =>
  page
    .locator('[role="row"]')
    .filter({ has: page.locator('[data-col="code"]', { hasText: new RegExp(`^${code}$`) }) })
    .locator(`[data-col="${column}"]`);

/**
 * Type into a cell the way a person does: click, select what was there, type the
 * new figure, then leave with Tab. Two things make this fiddly on purpose — a
 * cell only commits when focus leaves it, and Playwright's own fill() assigns
 * `input.value` behind React's back, which the change tracker never notices. So
 * this goes through the keyboard, and Tab is the part that saves it.
 */
const typeInto = async (page: Page, code: string, column: string, value: string): Promise<void> => {
  const input = cell(page, code, column).locator('input');
  await input.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type(value);
  await page.keyboard.press('Tab');
};

const codes = (page: Page) =>
  page.locator('[data-col="code"]').evaluateAll((cs) => cs.map((c) => (c.textContent ?? '').trim()));

test.describe('products', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page, '/sources');
    await importBoth(page);
    await page.goto('/#/products');
    await expect(page.locator('[role="row"]').first()).toBeVisible();
  });

  test('a code is not current until someone says so, and the tick survives a reload', async ({ page }) => {
    await search(page, 'GL4');
    const current = cell(page, 'GL4', 'enabled').locator('[role="checkbox"]');
    await expect(current).toHaveAttribute('aria-checked', 'false');
    await current.click();
    await expect(current).toHaveAttribute('aria-checked', 'true');

    await page.reload();
    await expect(page.locator('[role="row"]').first()).toBeVisible();
    await search(page, 'GL4');
    await expect(cell(page, 'GL4', 'enabled').locator('[role="checkbox"]')).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  test('the figures typed into the grid are the ones the plan will use', async ({ page }) => {
    await search(page, 'GL4');
    await typeInto(page, 'GL4', 'target', '2900');
    await typeInto(page, 'GL4', 'trayYield', '0.72');
    // Route is a decision, never inferred from the MYOB category.
    await cell(page, 'GL4', 'route').locator('select').selectOption('shotblast');

    // A cell's figure comes back from the database, so seeing it here means the
    // write landed. Without this the reload would race the last transaction.
    await expect(cell(page, 'GL4', 'target').locator('input')).toHaveValue('2900');
    await expect(cell(page, 'GL4', 'trayYield').locator('input')).toHaveValue('0.72');

    await page.reload();
    await expect(page.locator('[role="row"]').first()).toBeVisible();
    await search(page, 'GL4');
    await expect(cell(page, 'GL4', 'target').locator('input')).toHaveValue('2900');
    await expect(cell(page, 'GL4', 'trayYield').locator('input')).toHaveValue('0.72');
    await expect(cell(page, 'GL4', 'route').locator('select')).toHaveValue('shotblast');
  });

  test('picking rows edits the whole selection at once', async ({ page }) => {
    await search(page, 'C3');
    const picked = (await codes(page)).slice(0, 3);
    expect(picked.length).toBe(3);

    for (const code of picked) await cell(page, code, 'pick').locator('[role="checkbox"]').click();
    await expect(page.getByText(`${picked.length} picked`)).toBeVisible();

    // One decision, applied to every ticked row.
    // getByLabel already returns the control; chaining another select lookup
    // would search *inside* it.
    await page.getByLabel('Set the route of the picked products').selectOption('shotblast');
    await page.getByRole('button', { name: 'Apply to picked' }).click();
    await expect(page.getByRole('button', { name: 'Apply to picked' })).toHaveCount(0);

    for (const code of picked) {
      await expect(cell(page, code, 'route').locator('select')).toHaveValue('shotblast');
    }
  });

  test('a dragged row lands where it was dropped, and stays there', async ({ page }) => {
    await search(page, 'C3');
    await page.getByRole('button', { name: 'Drag order' }).click();
    const handles = page.locator('[aria-label^="Reorder"]');
    await expect(handles.first()).toBeVisible();

    const before = await codes(page);
    expect(before.length).toBeGreaterThanOrEqual(3);

    const from = (await handles.first().boundingBox())!;
    const to = (await handles.nth(2).boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
    await page.mouse.up();

    // Dropping the top row onto the third pushes the two above it up one place.
    const after = [before[1], before[2], before[0], ...before.slice(3)];
    // The write is async and the grid re-sorts from the new rank, so poll for the
    // finished order instead of peeking one tick after mouse.up.
    await expect.poll(() => codes(page), { timeout: 10_000 }).toEqual(after);

    await page.reload();
    await expect(page.locator('[role="row"]').first()).toBeVisible();
    await search(page, 'C3');
    await expect.poll(() => codes(page), { timeout: 10_000 }).toEqual(after);
  });

  test('the order can be changed without a mouse', async ({ page }) => {
    // The handle is a button, so it can be picked up with Space and walked down
    // the list — the same move, for anyone not using a trackpad.
    await search(page, 'C3');
    await page.getByRole('button', { name: 'Drag order' }).click();
    const before = await codes(page);
    expect(before.length).toBeGreaterThanOrEqual(3);

    // dnd-kit announces (for screen readers) which row the drag is over, so that
    // is what to wait on rather than a fixed pause.
    const live = page.locator('[id^="DndLiveRegion"]');
    await page.locator('[aria-label^="Reorder"]').first().focus();
    await page.keyboard.press('Space');
    // Either wording proves the sensor took the row: a desktop announces the
    // pick-up, a throttled phone has already run collision detection and says
    // which row it is over — itself, so far.
    await expect(live).toContainText('C3', { timeout: 5_000 });

    /**
     * Walk the dragged row down one place, believing it only when dnd-kit says it
     * is over the row we expected. The first arrow key after a pick-up can arrive
     * while the droppable rectangles are still being measured, and is then
     * swallowed — the announcement keeps naming the row it started on. Pressing
     * again is what a person does; `expect` retries the read, so a slow
     * announcement never causes a second, overshooting press.
     */
    const stepDown = async (expected: string): Promise<void> => {
      for (let press = 1; press <= 3; press += 1) {
        await page.keyboard.press('ArrowDown');
        try {
          await expect(live).toContainText(`over droppable area ${expected}`, { timeout: 2_000 });
          return;
        } catch {
          // Swallowed; try again.
        }
      }
      throw new Error(`still not over ${expected}: "${await live.innerText()}"`);
    };

    await stepDown(before[1]);
    await stepDown(before[2]);
    await page.keyboard.press('Space');

    const after = [before[1], before[2], before[0], ...before.slice(3)];
    await expect.poll(() => codes(page), { timeout: 10_000 }).toEqual(after);
  });

  test('the settings round-trip out of the app as CSV', async ({ page }) => {
    await search(page, 'GL4');
    await cell(page, 'GL4', 'enabled').locator('[role="checkbox"]').click();
    await typeInto(page, 'GL4', 'target', '1234');
    // The CSV is built from the rows on screen, so wait until both writes are back
    // from the database instead of exporting half-finished settings.
    await expect(cell(page, 'GL4', 'enabled').locator('[role="checkbox"]')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(cell(page, 'GL4', 'target').locator('input')).toHaveValue('1234');

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export CSV' }).click(),
    ]);
    expect(download.suggestedFilename()).toBe('freo-products.csv');

    const lines = readFileSync((await download.path())!, 'utf8').split('\r\n');
    expect(lines[0]).toBe('code,description,enabled,route,unit,baseline10000,trayYield,target,cureDays,notes');
    const row = lines.find((l) => l.startsWith('GL4,'));
    expect(row).toBeTruthy();
    expect(row).toContain('yes');
    expect(row).toContain('1234');
  });
});
