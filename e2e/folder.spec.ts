import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { type Page } from '@playwright/test';
import { expect, test, FILES, openApp, signIn, waitForStockTable } from './support';

/**
 * The folder on the computer that runs MYOB.
 *
 * A real browser's folder picker cannot be driven from the outside — it is a
 * permission dialog belonging to the operating system, and Playwright has no handle
 * on it. So the picker itself is replaced with one that hands the app a folder made
 * of the real MYOB workbooks, and everything *after* that answer is the real thing:
 * the File System Access calls the app makes, the workbook parse, the local import,
 * the GitHub request, the ledger line.
 *
 * The repository is answered by this file rather than by GitHub, for the same reason
 * the sync tests do: a test must not write to the shop's real data. It answers the
 * way GitHub does, including the git blob sha of whatever it is sent, because that
 * number is what the app compares against next minute.
 *
 * What is *not* provable here, and is said out loud in `docs/folder-watch.md`: the
 * permission dialog itself, the browser restart that costs one click, and OneDrive's
 * cloud-only files. Those need the shop's own machine.
 */

const GH = 'https://api.github.com/repos/**';

interface Put {
  path: string;
  message: string;
  /** The sha the app claimed the file had, or `undefined` when it thought there was none. */
  claimed: string | undefined;
  bytes: number;
}

/** `git hash-object`, because GitHub's `sha` is a git blob sha and nothing else. */
function blobSha(bytes: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`blob ${bytes.length}\u0000`, 'utf8');
  hash.update(bytes);
  return hash.digest('hex');
}

/**
 * The folder picker, replaced before any app code runs.
 *
 * `deny` is the person pressing Escape: an `AbortError`, which the app treats as
 * "nothing happened" rather than as a fault.
 */
async function stubFolder(page: Page, files: Array<{ name: string; path: string }>, deny = false): Promise<void> {
  const payload = files.map((f) => ({
    name: f.name,
    b64: readFileSync(f.path).toString('base64'),
    // Today, always. A fixture checked into git has a two-year-old write time, and
    // the app is right to refuse to send a workbook that old.
    modifiedAt: Date.now(),
  }));
  await page.addInitScript(
    ({ entries, cancelled }) => {
      const win = window as unknown as { __folderPicks: number; showDirectoryPicker: () => Promise<unknown> };
      win.__folderPicks = 0;
      win.showDirectoryPicker = async () => {
        win.__folderPicks += 1;
        if (cancelled) throw new DOMException('The user selected no folder.', 'AbortError');
        const handles = entries.map((entry: { name: string; b64: string; modifiedAt: number }) => {
          const bytes = Uint8Array.from(atob(entry.b64), (c) => c.charCodeAt(0));
          const file = new File([bytes], entry.name, {
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            lastModified: entry.modifiedAt,
          });
          return {
            kind: 'file',
            name: entry.name,
            async getFile() {
              return file;
            },
          };
        });
        return {
          kind: 'directory',
          name: 'MYOB exports',
          async *values() {
            for (const handle of handles) yield handle;
          },
          async queryPermission() {
            return 'granted';
          },
          async requestPermission() {
            return 'granted';
          },
        };
      };
    },
    { entries: payload, cancelled: deny },
  );
}

/** A repository that behaves like GitHub's Contents API for the two workbook paths. */
async function stubGithub(page: Page): Promise<{ puts: Put[] }> {
  const served = new Map<string, { sha: string; content: string }>();
  const puts: Put[] = [];
  await page.route(GH, (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const match = /^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/.exec(url.pathname);
    if (match == null) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"full_name":"Freo-Stone/Production-App-Data"}' });
    }
    const path = decodeURIComponent(match[1] ?? '');
    if (request.method() === 'PUT') {
      const body = JSON.parse(request.postData() ?? '{}') as { content?: string; message?: string; sha?: string };
      const bytes = Buffer.from(body.content ?? '', 'base64');
      const sha = blobSha(bytes);
      served.set(path, { sha, content: body.content ?? '' });
      puts.push({ path, message: body.message ?? '', claimed: body.sha, bytes: bytes.byteLength });
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ content: { name: path.split('/').pop(), path, sha }, commit: { sha: `commit-${sha}` } }),
      });
    }
    const found = served.get(path);
    if (found == null) {
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{"message":"Not Found"}' });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        name: path.split('/').pop(),
        path,
        sha: found.sha,
        type: 'file',
        encoding: 'base64',
        content: found.content,
      }),
    });
  });
  return { puts };
}

/** Give this device a token without testing the token screen again. */
async function giveToken(page: Page): Promise<void> {
  await page.getByLabel('Token').fill('github_pat_folder_test');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('On this device')).toBeVisible();
}

test('a computer with the folder sends it out, and uses it itself', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'only Chrome and Edge can be shown a folder');
  await stubFolder(page, [
    { name: 'location.xlsx', path: FILES.stock },
    { name: 'future.xlsx', path: FILES.jobs },
  ]);
  const { puts } = await stubGithub(page);

  await openApp(page, '/settings');
  await signIn(page);
  await giveToken(page);

  // Set up where a device is connected to anything: Settings, beside the repository
  // and the token. The line on Data sources only appears once there is something to
  // say, because that screen's room belongs to its table.
  const watch = page.locator('[data-folder-watch]');
  // Quiet: the chip and the attribute sit on the same element, not a nested one.
  await expect(page.locator('[data-folder-watch][data-folder-state="none"]')).toBeVisible();
  await expect(watch.getByText('No folder yet')).toBeVisible();
  await page.getByRole('button', { name: 'Choose the folder' }).click();

  await expect(watch.locator('[data-folder-state="ready"]')).toBeVisible();
  await expect(watch.getByText('MYOB exports')).toBeVisible();
  await expect(watch.getByText('Watching', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Look now' }).click();
  await expect(page.getByText('Sent to the shop')).toBeVisible();

  // Both workbooks reached the repository, with the bytes the fixtures hold.
  await expect.poll(() => puts.length).toBe(2);
  expect(puts.map((p) => p.path).sort()).toEqual(['exports/future.xlsx', 'exports/location.xlsx']);
  const stockPut = puts.find((p) => p.path === 'exports/location.xlsx');
  expect(stockPut?.bytes).toBe(readFileSync(FILES.stock).byteLength);
  // The message names the file, the machine and the rows, because "which PC did this
  // number come out of" is the first question when two screens disagree.
  expect(stockPut?.message).toContain('location.xlsx');
  expect(stockPut?.message).toContain('rows');
  // Nothing was there before, so the app said so instead of guessing a sha.
  expect(stockPut?.claimed).toBeUndefined();

  // Both files say they went out, on the line and in the panel.
  await watch.getByRole('button', { name: 'Details' }).click();
  await expect(page.locator('[data-folder-kind="location"]')).toContainText('Sent');
  await expect(page.locator('[data-folder-kind="future"]')).toContainText('Sent');

  // No navigation from here: the stubbed handle is a plain object, and a real
  // `FileSystemDirectoryHandle` is the only thing that survives a page reload in
  // IndexedDB. Reloading would forget the folder for a reason that has nothing to
  // do with the app, and the test would be measuring its own stub.

  // The machine that sent the file has it too, without waiting for the pull.
  await openApp(page, '/sources');
  await waitForStockTable(page);

  // And the shop's log says which computer did it. The line is the detail, not the
  // label: `ledgerLine` prints the detail whenever there is one, which is the whole
  // reason this one names the machine and the row counts.
  await openApp(page, '/log');
  const line = page.locator('[data-log-line]').filter({ hasText: /published exports\/location\.xlsx/ });
  await expect(line.first()).toBeVisible();
  await expect(line.first()).toContainText('rows');
});

test('the minute after, there is nothing to send', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'only Chrome and Edge can be shown a folder');
  await stubFolder(page, [
    { name: 'location.xlsx', path: FILES.stock },
    { name: 'future.xlsx', path: FILES.jobs },
  ]);
  const { puts } = await stubGithub(page);

  await openApp(page, '/settings');
  await signIn(page);
  await giveToken(page);
  await page.getByRole('button', { name: 'Choose the folder' }).click();
  await expect(page.locator('[data-folder-state="ready"]')).toBeVisible();
  await page.getByRole('button', { name: 'Look now' }).click();
  await expect.poll(() => puts.length).toBe(2);

  // The same folder, again. Committing identical bytes would put a second copy of a
  // multi-megabyte workbook in the history for good, so this is the important test.
  await page.getByRole('button', { name: 'Look now' }).click();
  await page.locator('[data-folder-watch]').getByRole('button', { name: 'Details' }).click();
  await expect(page.locator('[data-folder-kind="location"]')).toContainText('Nothing new');
  await expect(puts).toHaveLength(2);
});

test('closing the picker changes nothing', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'only Chrome and Edge can be shown a folder');
  await stubFolder(page, [{ name: 'location.xlsx', path: FILES.stock }], true);
  const { puts } = await stubGithub(page);

  await openApp(page, '/settings');
  await signIn(page);
  await giveToken(page);
  await page.getByRole('button', { name: 'Choose the folder' }).click();

  // Escape is not an error. The line stays where it was, and no message is shouted.
  await expect(page.locator('[data-folder-watch][data-folder-state="none"]')).toBeVisible();
  await expect(page.getByText('Could not', { exact: false })).toHaveCount(0);
  await expect(puts).toHaveLength(0);
});

test('a browser that cannot see a folder says so, and changes nothing else', async ({ page, browserName }) => {
  test.skip(browserName === 'chromium', 'chromium can open a folder; this test is about the browsers that cannot');
  // Settings, because that is where the feature is found: the data screen says
  // nothing at all until the watch exists.
  await openApp(page, '/settings');
  await signIn(page);

  const watch = page.locator('[data-folder-watch]');
  await expect(page.locator('[data-folder-watch][data-folder-state="unsupported"]')).toBeVisible();
  await expect(watch.getByText('Cannot watch folders')).toBeVisible();
  await watch.getByRole('button', { name: 'Details' }).click();
  // Named by the part only the explanation carries: the chip's own tooltip also
  // mentions Chrome, and a test that matches two things proves nothing.
  await expect(page.getByText('Firefox and Safari will not let any website see a disk')).toBeVisible();
  // No dead controls for a thing this browser cannot do.
  await expect(page.getByRole('button', { name: 'Choose the folder' })).toHaveCount(0);
});
