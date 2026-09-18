import { expect, test } from '@playwright/test';
import { openApp, signIn } from './support';

test.describe('shell', () => {
  // These are wide-screen assertions: below the layout breakpoint the rail is
  // replaced by the bottom tabs, and the two navs are not interchangeable.
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name === 'phone', 'the rail is the wide layout');
  });

  test('the rail navigates and the header follows the route', async ({ page }) => {
    await openApp(page);

    const rail = page.locator('nav').first();
    await expect(rail.getByRole('button', { name: 'Matrix' })).toBeVisible();
    await rail.getByRole('button', { name: 'Daily entry' }).click();
    await expect(page).toHaveURL(/#\/entry/);
    // The page title lives in the header h1; the screen body has its own headings.
    await expect(page.locator('h1')).toHaveText('Daily entry');

    await rail.getByRole('button', { name: 'Products' }).click();
    await expect(page).toHaveURL(/#\/products/);
  });

  test('a collapsed rail still reaches every screen', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: 'Collapse menu' }).click();
    await expect(page.getByRole('button', { name: 'Data sources' })).toBeVisible();
    await page.getByRole('button', { name: 'Data sources' }).click();
    await expect(page).toHaveURL(/#\/sources/);
  });

  test('the theme flips and stays flipped after a reload', async ({ page }) => {
    await openApp(page);
    const before = await page.locator('html').getAttribute('data-theme');
    await page.getByRole('button', { name: /Theme:/ }).click();
    const after = await page.locator('html').getAttribute('data-theme');
    expect(after).not.toBe(before);

    await page.reload();
    await signIn(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', after!);
  });

  test('first run points at the import screen', async ({ page }) => {
    await openApp(page);
    const banner = page.getByText('Nothing set up yet');
    await expect(banner).toBeVisible();
    // Dismissing sticks for the session, even across a reload.
    await page.getByRole('button', { name: 'Dismiss' }).first().click();
    await expect(page.getByText('Nothing set up yet')).toHaveCount(0);
    await page.reload();
    await signIn(page);
    await expect(page.getByText('Nothing set up yet')).toHaveCount(0);
  });

  test('an unknown route returns to the matrix instead of a dead end', async ({ page }) => {
    await page.goto('/#/not-a-screen');
    await signIn(page);
    await expect(page).toHaveURL(/#\/$/);
  });
});

test.describe('phone layout', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('bottom tabs carry the floor screens and More carries the rest', async ({ page }) => {
    await openApp(page);

    const tabs = page.locator('nav').last();
    await expect(tabs.getByText('Entry')).toBeVisible();
    await expect(tabs.getByText('Curing')).toBeVisible();
    await expect(tabs.getByText('MYOB')).toBeVisible();

    await tabs.getByRole('button', { name: 'More' }).click();
    const sheet = page.getByRole('dialog');
    await expect(sheet.getByText('Production log')).toBeVisible();
    await sheet.getByRole('button', { name: /Settings/ }).click();
    await expect(page).toHaveURL(/#\/settings/);
  });

  test('the import drop zone is reachable with one thumb', async ({ page }) => {
    await openApp(page, '/sources');
    await expect(page.getByText('Drop the two MYOB exports here')).toBeVisible();
    // The file input stays reachable for the OS file picker.
    await expect(page.locator('input[type="file"]')).toBeAttached();
  });

  test('a table does not force the page sideways', async ({ page }) => {
    await openApp(page, '/sources');
    await page.locator('input[type="file"]').setInputFiles([
      'test/fixtures/real/location.xlsx',
    ]);
    await page.getByRole('button', { name: 'Load' }).first().click();
    await expect(page.locator('[role="row"]').first()).toBeVisible();

    const docWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const viewport = page.viewportSize()?.width ?? 390;
    // Only the grid itself may scroll sideways, never the document.
    expect(docWidth).toBeLessThanOrEqual(viewport + 1);
  });
});
