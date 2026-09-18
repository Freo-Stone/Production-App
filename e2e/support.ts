import { expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';

export const FILES = {
  stock: resolve('test/fixtures/real/location.xlsx'),
  jobs: resolve('test/fixtures/real/future.xlsx'),
};

/**
 * First run asks who is at the keyboard.
 *
 * The answer decides only which saved table layout belongs to this browser —
 * there are no roles and no passwords in this app.
 */
export async function signIn(page: Page, name = 'Test'): Promise<void> {
  const dialog = page.getByRole('dialog');
  const who = dialog.getByText('Who is using this?');
  // One-shot `isVisible()` was a flake: on a busy machine the dialog mounts a
  // beat after boot, the peek returned false, and the test carried on with a
  // modal sitting in front of it. Bounded wait, then a real fill.
  if (!(await who.waitFor({ state: 'visible', timeout: 3_000 }).then(() => true).catch(() => false))) {
    return;
  }
  const box = dialog.getByRole('textbox');
  await box.waitFor({ state: 'visible' });
  await box.fill(name);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);
}

export async function openApp(page: Page, route = '/'): Promise<void> {
  await page.goto(`/#${route}`);
  await signIn(page);
}

/** Click every staged file's Load button, whatever is sitting in the tray. */
export async function loadAllStaged(page: Page): Promise<void> {
  // `exact` matters: the service worker update toast offers a "Reload" button,
  // and a substring match would click into that instead of the staged file.
  const loads = page.getByRole('button', { name: 'Load', exact: true });
  await expect(loads).not.toHaveCount(0);
  for (let guard = 4; guard > 0; guard--) {
    const count = await loads.count();
    if (count === 0) return;
    await loads.first().click();
    // One tray row per Load: a staged file that comes back is a real bug, so the
    // count is asserted after every click rather than at the end.
    await expect(loads).toHaveCount(count - 1);
  }
  await expect(loads).toHaveCount(0);
}

/** Wait until the stock mirror is on screen, so the layout has finished moving. */
export async function waitForStockTable(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: /^Stock \(/ })).toBeVisible();
  await expect(page.locator('[role="row"]').first()).toBeVisible();
}

/** Drop both real exports in and load them. */
export async function importBoth(page: Page): Promise<void> {
  await page.locator('input[type="file"]').setInputFiles([FILES.stock, FILES.jobs]);
  await loadAllStaged(page);
}

/** Column widths of the grid header, as numbers. */
export async function columnWidths(page: Page): Promise<number[]> {
  return page
    .locator('.dt-head')
    .evaluate((el) =>
      (el as HTMLElement).style.gridTemplateColumns
        .split(' ')
        .map((w) => Number.parseInt(w, 10))
        .filter((n) => Number.isFinite(n)),
    );
}

export { expect, test };
