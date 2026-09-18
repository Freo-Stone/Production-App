import { expect, test } from '@playwright/test';

/**
 * The dialog has to be laid out against the window and stay out of the typing's way.
 *
 * It used to be rendered where it was invoked — inside the header, which carries a
 * `backdrop-filter`. A filtered ancestor becomes the containing block for
 * `position: fixed`, so the first-run name prompt was centred inside the 47px-tall
 * header strip: its title above the top of the screen, its dim covering only the
 * header, and each keystroke repainting inside a blurred region, which is what the
 * delay between letters was.
 */

test('the first-run dialog is positioned against the window', async ({ page }) => {
  await page.goto('/');

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Who is using this?')).toBeVisible();

  // The panel arrives on a spring, so measure it once it has stopped moving: the
  // same box in two consecutive frames. Reading it mid-animation reported the sheet
  // 20px below the bottom of a phone viewport, which is where it starts.
  await page.waitForFunction(() => {
    const el = document.querySelector('[role="dialog"]');
    if (!el) return false;
    const box = el.getBoundingClientRect();
    const key = `${box.top.toFixed(2)}:${box.height.toFixed(2)}`;
    const settled = (window as unknown as { __lastBox?: string }).__lastBox === key;
    (window as unknown as { __lastBox?: string }).__lastBox = key;
    return settled;
  });

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

test('typing a name is not interrupted by the dialog around it', async ({ page }) => {
  await page.goto('/');

  const box = page.getByRole('dialog').getByRole('textbox');
  await box.waitFor({ state: 'visible' });
  await box.pressSequentially('Test Person', { delay: 0 });

  await expect(box).toHaveValue('Test Person');
  // Every keystroke used to re-focus the panel, which pulls the caret out of the
  // field: the text arrives, then stops arriving.
  await expect(box, 'the caret is still in the name box after eleven keystrokes').toBeFocused();

  // Enter is the fast path out of the box.
  await box.press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('header').first()).toContainText('Test Person');

  // The background scroll lock is given back, so the page scrolls again.
  expect(await page.evaluate(() => document.body.style.overflow), 'scroll lock released').toBe('');

  // A saved name is remembered, so nobody is asked twice.
  await page.reload();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('escape closes the dialog and gives the page back', async ({ page }) => {
  await page.goto('/');
  const box = page.getByRole('dialog').getByRole('textbox');
  await box.waitFor({ state: 'visible' });
  await box.pressSequentially('Sam');

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

  // Escape dismisses without saving, so a reload asks again — a name is the one
  // thing the app cannot guess, and this browser has not told it yet.
  await page.reload();
  await expect(page.getByRole('dialog').getByText('Who is using this?')).toBeVisible();
});
