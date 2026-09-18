import { expect, test, openApp } from './support';

/**
 * Connecting a device to the shop's repository.
 *
 * Everything here is about a promise the rest of the app depends on: a token
 * pasted into this screen stays on this device. The unit tests prove the state
 * document never carries it; these prove the screen behaves on a real browser,
 * with a real reload, and that a refusal from GitHub arrives as a sentence rather
 * than a spinner that stops.
 */

const GH = 'https://api.github.com/repos/**';

test('the shop repository is already filled in on a fresh device', async ({ page }) => {
  await openApp(page, '/settings');

  await expect(page.getByLabel('Owner')).toHaveValue('Freo-Stone');
  await expect(page.getByLabel('Repository')).toHaveValue('Production-App-Data');
  await expect(page.getByLabel('Branch')).toHaveValue('main');
  await expect(page.getByText('Not set')).toBeVisible();
});

test('a token survives a reload and stays off the settings that sync', async ({ page }) => {
  await openApp(page, '/settings');

  await page.getByLabel('Token').fill('github_pat_persisted');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  // The tile reads what is stored, so this waits for the write to land rather
  // than for the keystroke to appear — the difference between a test and a race.
  await expect(page.getByText('On this device')).toBeVisible();

  await page.reload();
  await expect(page.getByLabel('Token')).toHaveValue('github_pat_persisted');
});

test('GitHub says no, and the reason arrives as a sentence', async ({ page }) => {
  await page.route(GH, (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'Bad credentials' }),
    }),
  );
  await openApp(page, '/settings');

  await page.getByLabel('Token').fill('github_pat_expired');
  await page.getByRole('button', { name: 'Test connection' }).click();

  await expect(page.getByText(/Token rejected \(401\)/)).toBeVisible();
});

test('a token that cannot write is caught by testing the write', async ({ page }) => {
  // A browser cannot read GitHub's `x-oauth-scopes` response header: it is not a
  // CORS-exposed header, so a cross-origin fetch sees an empty set no matter what
  // the server sent. Reading scopes is therefore not an option from this app, and
  // the only honest write check is to attempt a write — the probe. This is the
  // case that matters too: a fine-grained token with Contents: Read only.
  await page.route(GH, (route) =>
    route.request().method() === 'PUT'
      ? route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'Resource not accessible by personal access token' }),
        })
      : route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ full_name: 'Freo-Stone/Production-App-Data' }),
        }),
  );
  await openApp(page, '/settings');

  await page.getByLabel('Token').fill('github_pat_read_only');
  await page.getByRole('switch', { name: 'Test writing too' }).click();
  await page.getByRole('button', { name: 'Test connection' }).click();

  await expect(page.getByText(/Token cannot write to Freo-Stone\/Production-App-Data \(HTTP 403\)/)).toBeVisible();
});

test('a dead connection is called a dead connection', async ({ page, context }) => {
  await openApp(page, '/settings');
  await page.getByLabel('Token').fill('github_pat_offline');

  await context.setOffline(true);
  await page.getByRole('button', { name: 'Test connection' }).click();

  await expect(page.getByText(/Could not reach GitHub from this device/)).toBeVisible();
  await context.setOffline(false);
});

test('clearing the token leaves the repository alone', async ({ page }) => {
  await openApp(page, '/settings');
  await page.getByLabel('Token').fill('github_pat_borrowed');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('On this device')).toBeVisible();

  await page.getByRole('button', { name: 'Clear the token' }).click();
  await expect(page.getByText('Not set')).toBeVisible();
  await expect(page.getByLabel('Token')).toHaveValue('');
  await expect(page.getByLabel('Repository')).toHaveValue('Production-App-Data');

  await page.reload();
  await expect(page.getByText('Not set')).toBeVisible();
});

test('a public repository is refused before a single byte is written', async ({ page }) => {
  // The app is served from a public repository, so its own name is the most
  // likely wrong answer to type into the data-repository field — and the wrong
  // answer here publishes the shop's order book permanently. So it is refused,
  // and refused before the write probe is even attempted.
  const calls: string[] = [];
  page.on('request', (request) => {
    if (request.url().startsWith('https://api.github.com/')) {
      calls.push(`${request.method()} ${new URL(request.url()).pathname}`);
    }
  });
  await page.route(GH, (route) =>
    route.fulfill({
      status: 200,
      body: JSON.stringify({ full_name: 'Freo-Stone/Production-App', private: false }),
    }),
  );

  await openApp(page, '/settings');
  await page.getByLabel('Token').fill('github_pat_wrong_repository');
  await page.getByRole('switch', { name: 'Test writing too' }).click();
  await page.getByRole('button', { name: 'Test connection' }).click();

  await expect(page.getByText(/PUBLIC repository/)).toBeVisible();
  expect(calls.filter((call) => call.startsWith('PUT')), `writes attempted: ${calls.join(', ')}`).toEqual([]);
});
