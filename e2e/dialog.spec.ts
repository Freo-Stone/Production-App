import { expect, test } from '@playwright/test';

import { openApp } from './support';

/**
 * The dialog has to be laid out against the window and stay out of the typing's way.
 *
 * It used to be rendered where it was invoked — inside the header, which carries a
 * `backdrop-filter`. A filtered ancestor becomes the containing block for
 * `position: fixed`, so the first-run name prompt was centred inside the 47px-tall
 * header strip: its title above the top of the screen, its dim covering only the
 * header, and each keystroke repainting inside a blurred region, which is what the
 * delay between letters was.
 *
 * The name prompt is now the account dialog, and the sign-in screen is a screen — so
 * both get covered here: the dialog's geometry, and typing where no dialog is around.
 */

/** The panel arrives on a spring, so measure it once it has stopped moving: the same
 *  box in two consecutive frames. Reading it mid-animation reported the sheet 20px
 *  below the bottom of a phone viewport, which is where it starts. */
async function waitForDialogToSettle(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForFunction(() => {
    const el = document.querySelector('[role="dialog"]');
    if (!el) return false;
    const box = el.getBoundingClientRect();
    const key = `${box.top.toFixed(2)}:${box.height.toFixed(2)}`;
    const settled = (window as unknown as { __lastBox?: string }).__lastBox === key;
    (window as unknown as { __lastBox?: string }).__lastBox = key;
    return settled;
  });
}

async function openAccountDialog(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: /^Account:/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Your account')).toBeVisible();
  await waitForDialogToSettle(page);
}

test('the account dialog is positioned against the window', async ({ page }) => {
  await openApp(page);
  await openAccountDialog(page);

  const geometry = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) throw new Error('no dialog open');
    const box = dialog.getBoundingClientRect();
    const overlay = dialog.closest('.fixed.inset-0')?.firstElementChild;
    if (!overlay) throw new Error('no overlay behind the dialog');
    const scrim = overlay.getBoundingClientRect();
    const title = dialog.querySelector('h2')?.getBoundingClientRect();
    return {
      top: box.top,
      left: box.left,
      right: window.innerWidth - box.right,
      bottom: window.innerHeight - box.bottom,
      titleHeight: title?.height ?? 0,
      scrimWidth: scrim.width,
      scrimHeight: scrim.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  });

  // Nothing hangs off an edge. Before the fix the panel's top was 44px above the
  // viewport, which cut the title off entirely.
  expect(geometry.top, 'the dialog is not above the top of the window').toBeGreaterThanOrEqual(0);
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeGreaterThanOrEqual(0);
  expect(geometry.bottom).toBeGreaterThanOrEqual(0);
  expect(geometry.titleHeight, 'the title is laid out, not clipped away').toBeGreaterThan(0);

  // The scrim dims the whole window, not the strip the dialog was invoked in.
  expect(geometry.scrimWidth).toBe(geometry.viewportWidth);
  expect(geometry.scrimHeight).toBe(geometry.viewportHeight);
});

test('typing a new passcode is not interrupted by the dialog around it', async ({ page }) => {
  await openApp(page);
  await openAccountDialog(page);

  const box = page.getByRole('dialog').getByLabel('New passcode');
  await box.pressSequentially('Test Person', { delay: 0 });

  await expect(box).toHaveValue('Test Person');
  // Every keystroke used to re-focus the panel, which pulls the caret out of the
  // field: the text arrives, then stops arriving.
  await expect(box, 'the caret is still in the passcode box after eleven keystrokes').toBeFocused();

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // The background scroll lock is given back, so the page scrolls again.
  expect(await page.evaluate(() => document.body.style.overflow), 'scroll lock released').toBe('');

  // Escape closes the dialog without signing anybody out: this device is still
  // someone's signed-in device.
  await expect(page.getByRole('button', { name: /^Account:/ })).toBeVisible();
});

test('escape closes the dialog and gives the page back', async ({ page }) => {
  await openApp(page);
  await openAccountDialog(page);

  const dismissedAt = Date.now();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('');

  // The scrim must stop being the topmost element almost immediately. Exiting on a
  // spring left a transparent full-screen overlay under the finger for ~700ms after
  // dismissal, so the next tap was eaten. The fade is 120ms; 500ms leaves room for a
  // busy runner without being so wide that the old 700ms would slip through.
  const cleared = await page.evaluate(() => {
    const blocked = () => String(document.elementFromPoint(innerWidth / 2, innerHeight - 30)?.className ?? '').includes('bg-black/55');
    return new Promise<number>((resolve) => {
      const started = performance.now();
      const tick = () => (blocked() ? (performance.now() - started > 4000 ? resolve(-1) : requestAnimationFrame(tick)) : resolve(performance.now() - started));
      tick();
    });
  });
  expect(cleared, 'seconds during which the dismissed dialog still swallowed taps').toBeGreaterThanOrEqual(0);
  expect(cleared, 'ms during which the dismissed dialog still swallowed taps').toBeLessThan(500);
  expect(Date.now() - dismissedAt, 'the dialog went away promptly').toBeLessThan(2_000);
});

test('typing on the sign-in screen is not fighting anything', async ({ page }) => {
  await page.goto('/');

  // A fresh context has no accounts, so this is the owner-setup form: the same box the
  // lag was reported against, one screen later in the app's life.
  const name = page.getByLabel('Your name');
  await name.waitFor({ state: 'visible' });
  await name.pressSequentially('Test Person', { delay: 0 });
  await expect(name).toHaveValue('Test Person');
  await expect(name, 'the caret is still in the name box').toBeFocused();

  // The confirm field is where the typing was worst: two boxes and a warning that
  // changes as you type. Keep the focus and the value through all of it.
  const code = page.getByLabel('Passcode', { exact: true });
  await code.pressSequentially('trap door', { delay: 0 });
  await expect(code).toHaveValue('trap door');
  const confirm = page.getByLabel('Type it again');
  await confirm.pressSequentially('trap door', { delay: 0 });
  await expect(confirm).toHaveValue('trap door');
  await expect(confirm, 'the advice under the box did not take the caret').toBeFocused();

  // And the form lets the shop in.
  await page.getByRole('button', { name: /Create the owner/ }).click();
  await expect(page.locator('header').first()).toBeVisible();
});

test('a signed-in device does not ask again after a reload', async ({ page }) => {
  await openApp(page);
  const account = page.getByRole('button', { name: /^Account:/ });
  await expect(account).toBeVisible();

  await page.reload();

  // No sign-in screen, no dialog: the account comes back from this device's own
  // storage and is checked against the accounts on it before being trusted.
  await expect(page.getByText('Who is on this device?')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(account).toBeVisible();

  // Read the name out of the dialog rather than the header chip: on a phone the chip
  // shows an initial only, and the name has to be there somewhere either way.
  await account.click();
  await expect(page.getByRole('dialog').getByText('Test Person — Owner')).toBeVisible();
});
