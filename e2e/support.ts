import { expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';

export const FILES = {
  stock: resolve('test/fixtures/real/location.xlsx'),
  jobs: resolve('test/fixtures/real/future.xlsx'),
};

/**
 * Get past the sign-in screen.
 *
 * A fresh browser context has no accounts, so the first call creates the shop's owner
 * and signs in on the spot. Later calls in the same context find the person list and
 * sign in as whoever is asked for — which is how the tests sign in as a viewer without
 * pretending to be one.
 *
 * The passcode is hashed on the device at the app's real cost, so every wait here is
 * on a condition, never on a fixed pause: a wrong guess of the timing is a timeout with
 * a name, not a mystery.
 */
export async function signIn(
  page: Page,
  name = 'Test Person',
  passcode = 'shop floor',
): Promise<void> {
  const setup = page.getByRole('heading', { name: 'Set up the shop' });
  const list = page.getByText('Who is on this device?');

  if (await setup.waitFor({ state: 'visible', timeout: 3_000 }).then(() => true).catch(() => false)) {
    await page.getByLabel('Your name').fill(name);
    await page.getByLabel('Passcode', { exact: true }).fill(passcode);
    await page.getByLabel('Type it again').fill(passcode);
    await page.getByRole('button', { name: /Create the owner/ }).click();
    await expect(page.locator('header').first()).toBeVisible();
    return;
  }

  if (await list.waitFor({ state: 'visible', timeout: 3_000 }).then(() => true).catch(() => false)) {
    await page.getByRole('button', { name: new RegExp(name) }).click();
    const code = page.getByLabel('Passcode', { exact: true });
    await code.waitFor({ state: 'visible' });
    await code.fill(passcode);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('header').first()).toBeVisible();
    return;
  }

  // Neither screen: already signed in. Assert the board is actually there rather than
  // returning quietly, so a test that expected a sign-in fails where it happened.
  await expect(page.locator('header').first()).toBeVisible();
}

/** Signs out through the header menu, so the menu itself is part of the coverage. */
export async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Account:/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Your account')).toBeVisible();
  await dialog.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByText('Who is on this device?')).toBeVisible();
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
