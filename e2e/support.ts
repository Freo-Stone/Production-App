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

/**
 * Start from a browser that cannot be holding yesterday's build.
 *
 * The suite runs against a rebuilt `dist`, Playwright keeps one browser profile
 * for the whole worker, and the app installs a service worker that precaches the
 * shell. Together those mean a test can be handed an older bundle out of the
 * cache — it then drives code that is no longer on disk, and passes. So: run a
 * throwaway navigation, unregister whatever worker that origin has and drop its
 * caches, and only then load the screen under test.
 *
 * The app still installs its worker while the test runs, so the install path is
 * still exercised. What is not covered is serving a second load out of the
 * cache — which is precisely the thing that made tests lie.
 */
async function startClean(page: Page): Promise<void> {
  await page.addInitScript(() => {
    void navigator.serviceWorker
      ?.getRegistrations?.()
      .then((rs) => rs.forEach((r) => void r.unregister()));
    void window.caches?.keys?.().then((ks) => ks.forEach((k) => void window.caches.delete(k)));
  });
  await page.goto('/');
  await page.evaluate(async () => {
    for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister();
    for (const key of await caches.keys()) await caches.delete(key);
  });
}

export async function openApp(page: Page, route = '/'): Promise<void> {
  await startClean(page);
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
    // Generous timeout: the workbook is parsed on the page's own thread, and a
    // couple of thousand rows while another worker is doing the same is not instant.
    await expect(loads).toHaveCount(count - 1, { timeout: 30_000 });
  }
  await expect(loads).toHaveCount(0);
}

/** Wait until the stock mirror is on screen, so the layout has finished moving. */
export async function waitForStockTable(page: Page): Promise<void> {
  // The parse happens in the page, and these specs load the shop's real export
  // shapes: with two workers running, a few thousand rows can take the better part
  // of fifteen seconds. Waiting is not tolerating a failure — the assertion still
  // fails if the rows never arrive.
  await expect(page.getByRole('button', { name: /^Stock \(/ }), { timeout: 30_000 }).toBeVisible();
  await expect(page.locator('[role="row"]').first(), { timeout: 30_000 }).toBeVisible();
}

/**
 * Open the drop zone.
 *
 * The manual import sits behind a disclosure now: the table is the reason the
 * screen is opened, and a full-size drop zone above it pushed the table off the
 * bottom of the screen. Choosing files is still the app's own way in, so anything
 * that wants the file input has to open the panel first — which is what a person
 * does too.
 */
export async function openImportPanel(page: Page): Promise<void> {
  const trigger = page.getByRole('button', { name: /Import by hand/ });
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
  await expect(page.locator('input[type="file"]')).toBeAttached();
}

/** Open the "Locations counted as stock" line, the same way a person would. */
export async function openLocations(page: Page): Promise<void> {
  const trigger = page.getByRole('button', { name: /Locations counted as stock/ });
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
}

/** Drop both real exports in and load them. */
export async function importBoth(page: Page): Promise<void> {
  await openImportPanel(page);
  await page.locator('input[type="file"]').setInputFiles([FILES.stock, FILES.jobs]);
  await loadAllStaged(page);
}

/**
 * Tick every code the Products screen is showing, through the screen's own controls.
 *
 * Nothing in an import is current: the tick is the shop's decision, and the app will
 * not make it. So any test that wants a planning screen to have rows — the Matrix,
 * the making plan — has to say so first, the way the owner does, by picking the rows
 * and pressing Mark current. A spec that imports and then expects a plan is a spec
 * that quietly tests an empty screen.
 *
 * "Pick all" picks the rows in front of you, which on Products is the open-jobs view
 * — exactly the codes a planning screen can put a row for, so the whole range a board
 * could show is what gets ticked.
 */
export async function markAllCurrent(page: Page): Promise<void> {
  await page.goto('/#/products');
  const pickAll = page.getByRole('button', { name: /^Pick all/ });
  await expect(pickAll).toBeVisible();
  await pickAll.click();
  await page.getByRole('button', { name: 'Mark current' }).click();
  await expect(page.getByRole('button', { name: 'Apply to picked' })).toHaveCount(0);
}

/**
 * Find one code in the Products grid. The filter box is the shop's own way in, so
 * a test that needs one row filters for it instead of scrolling for it.
 */
export function searchProducts(page: Page, term: string): Promise<void> {
  return page.getByPlaceholder('Filter code, description or note…').fill(term);
}

/** One cell of one product's row, addressed by the code and the column's own key. */
export function productCell(page: Page, code: string, column: string): ReturnType<Page['locator']> {
  return page
    .locator('[role="row"]')
    .filter({ has: page.locator('[data-col="code"]', { hasText: new RegExp(`^${code}$`) }) })
    .locator(`[data-col="${column}"]`);
}

/** Switch a code on, so it becomes something the shop says it makes. */
export async function enableProduct(page: Page, code: string): Promise<void> {
  await searchProducts(page, code);
  const box = productCell(page, code, 'enabled').locator('[role="checkbox"]');
  await expect(box).toBeVisible();
  // Press it only when it is off. This helper means "make this code current", and a
  // spec that has already ticked the range (`markAllCurrent`) and then calls it was
  // switching the code *off* instead — which took its row off the plan halfway through
  // a test that was reading that row. The closing assertion is the postcondition, so a
  // code that will not tick still fails the test rather than the next one.
  if ((await box.getAttribute('aria-checked')) !== 'true') await box.click();
  await expect(box).toHaveAttribute('aria-checked', 'true');
}

/** "Made how" — a code cannot be logged until the shop has said how it is made. */
export async function setProductRoute(page: Page, code: string, route: 'manufacture' | 'shotblast'): Promise<void> {
  const select = productCell(page, code, 'route').locator('select');
  await select.selectOption(route);
  await expect(select).toHaveValue(route);
}

/**
 * Import both exports and switch one code on as a made product. That is the whole
 * setup every production screen needs: a real code, from the real exports.
 *
 * `route` is what the shop says it makes it by. Pass `null` to leave it as the
 * export left it — unset — which is the state a code really arrives in, and the
 * state Daily entry has to refuse rather than guess at.
 */
export async function setupMadeProduct(
  page: Page,
  code: string,
  route: 'manufacture' | 'shotblast' | null = 'manufacture',
): Promise<void> {
  await openApp(page, '/sources');
  await importBoth(page);
  await page.goto('/#/products');
  await enableProduct(page, code);
  if (route !== null) await setProductRoute(page, code, route);
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
