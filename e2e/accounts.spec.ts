import { expect, test } from '@playwright/test';

import { openApp, signIn, signOut } from './support';

/**
 * Logins, roles and devices, driven the way a person drives them.
 *
 * These tests deliberately go through the screens rather than seeding IndexedDB: the
 * point of the feature is that the owner can hand out a login on one machine and the
 * next machine behaves differently, and that only survives if it is done through the
 * same buttons the shop uses.
 */

const OWNER = { name: 'Test Person', passcode: 'shop floor' };
const VIEWER = { name: 'Test Viewer', passcode: 'read only pass' };

async function addPerson(
  page: import('@playwright/test').Page,
  person: { name: string; passcode: string },
  role: 'maker' | 'viewer',
): Promise<void> {
  await page.getByRole('button', { name: /^Account:/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: /People and devices/ }).click();
  await expect(page.getByRole('button', { name: 'Add a person' })).toBeVisible();

  await page.getByRole('button', { name: 'Add a person' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill(person.name);
  await dialog.getByLabel('Role').selectOption(role);
  await dialog.getByLabel('Passcode').fill(person.passcode);
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();

  // The dialog closes and the row is in the table.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('row').filter({ hasText: person.name })).toBeVisible();
}

test('the first account on a device is the shop owner, and signs itself in', async ({ page }) => {
  await openApp(page);

  // The name in the header is the account, not something typed into a box.
  await expect(page.getByRole('button', { name: /^Account:/ })).toBeVisible();

  await page.getByRole('button', { name: /^Account:/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Test Person — Owner')).toBeVisible();
  await expect(dialog.getByText(/device stays signed in/)).toBeVisible();
});

test('a wrong passcode keeps the device out, and says so', async ({ page }) => {
  await openApp(page);
  await signOut(page);

  await page.getByRole('button', { name: /Test Person/ }).click();
  const code = page.getByLabel('Passcode', { exact: true });
  await code.fill('not the shop floor');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByRole('status')).toContainText('That passcode is not right for Test Person');
  await expect(page.getByRole('button', { name: /^Account:/ })).toHaveCount(0);

  // A reload is not a way round it.
  await page.reload();
  await expect(page.getByRole('button', { name: /^Account:/ })).toHaveCount(0);
});

test('the owner hands out a login, and that login gets a smaller app', async ({ page }) => {
  await openApp(page);
  await addPerson(page, VIEWER, 'viewer');
  await signOut(page);

  await signIn(page, VIEWER.name, VIEWER.passcode);

  // A viewer is not offered the screens they cannot use. Present-or-absent in the DOM,
  // not merely hidden: on a phone these live in the More sheet, which the rail does not
  // share.
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'People', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Data', exact: true })).toHaveCount(0);

  // A viewer's own role is on screen, so it is obvious whose app this is.
  await page.getByRole('button', { name: /^Account:/ }).click();
  await expect(page.getByRole('dialog').getByText('Test Viewer — Viewer')).toBeVisible();
  // And no way to manage anybody else from here.
  await expect(page.getByRole('dialog').getByRole('button', { name: /People and devices/ })).toHaveCount(0);
});

test('a viewer who types the settings address gets a refusal, not the screen', async ({ page }) => {
  await openApp(page);
  await addPerson(page, VIEWER, 'viewer');
  await signOut(page);
  await signIn(page, VIEWER.name, VIEWER.passcode);

  await page.goto('/#/settings');
  await expect(page.getByText('Not this screen')).toBeVisible();
  await expect(page.getByText(/does not change how the shop is set up/)).toBeVisible();
  // Nothing of the settings screen is in the document, so there is nothing to click.
  await expect(page.getByRole('button', { name: /Save/ })).toHaveCount(0);

  await page.goto('/#/people');
  await expect(page.getByText('Not this screen')).toBeVisible();
});

test('a viewer reads the products board and cannot change it', async ({ page }) => {
  await openApp(page);
  await addPerson(page, VIEWER, 'viewer');
  await signOut(page);
  await signIn(page, VIEWER.name, VIEWER.passcode);

  await openApp(page, '/products');
  await expect(page.getByText('Read only')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Import CSV' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Pick all/ })).toHaveCount(0);
  // The grid itself has nothing to tick or type into: the pick column is gone and the
  // editable cells draw the same text an unedited cell shows a writer.
  await expect(page.getByRole('checkbox')).toHaveCount(0);

  // Reading still works: the board is the reason a viewer has a login.
  await expect(page.getByRole('button', { name: 'Export CSV' })).toBeVisible();
});

test('a maker gets the work screens back', async ({ page }) => {
  await openApp(page);
  await addPerson(page, { name: 'Test Maker', passcode: 'mixing bench' }, 'maker');
  await signOut(page);
  await signIn(page, 'Test Maker', 'mixing bench');

  // Products is open to a maker, so none of the read-only treatment applies.
  await openApp(page, '/products');
  await expect(page.getByText('Read only')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Import CSV' })).toBeVisible();

  // Settings and People are still the owner's.
  await expect(page.getByRole('button', { name: 'People', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toHaveCount(0);
});

test('the owner changes their own passcode and the old one stops working', async ({ page }) => {
  await openApp(page);

  await page.getByRole('button', { name: /^Account:/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('New passcode').fill('second shift');
  await dialog.getByLabel('Type it again').fill('second shift');
  await dialog.getByRole('button', { name: 'Change passcode' }).click();

  await expect(page.getByRole('dialog')).toHaveCount(0);

  await signOut(page);
  await page.getByRole('button', { name: /Test Person/ }).click();
  await page.getByLabel('Passcode', { exact: true }).fill(OWNER.passcode);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('status')).toContainText('That passcode is not right');

  await page.getByLabel('Passcode', { exact: true }).fill('second shift');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: /^Account:/ })).toBeVisible();
});

test('the owner takes this device off the list and is signed out at once', async ({ page }) => {
  await openApp(page);
  await openApp(page, '/people');

  const row = page.getByRole('row').filter({ hasText: 'This device' });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: /Take This device off the list/ }).click();

  // Revoking the machine you are standing at fires yourself, immediately: there is no
  // other honest reading of "take this device off the list".
  await expect(page.getByText('Who is on this device?')).toBeVisible();

  // And it cannot sign back in — the refusal is on the device, from the shared list.
  await page.getByRole('button', { name: /Test Person/ }).click();
  await page.getByLabel('Passcode', { exact: true }).fill(OWNER.passcode);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('status')).toContainText('taken off the shop list');
});
