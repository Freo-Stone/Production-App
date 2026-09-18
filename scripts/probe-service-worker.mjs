// Checks the two service-worker behaviours that have both already gone wrong here.
//
//     node scripts/probe-service-worker.mjs <url>
//
// 1. The app must not reload itself. With `registerType: 'autoUpdate'` the worker
//    claims the page it just installed, and the old `controlling` handler reloaded
//    on that — so about a second after opening, the page reloaded and a half-typed
//    name vanished. The marker below is set on the window and must still be there.
//
// 2. An update must still be *offered*, and applied when asked for. The policy is
//    the same in both directions: nobody's keystrokes get thrown away by a
//    background process, but a new version does reach the shop. This really does
//    build twice, because only a changed bundle changes the worker.
import { execSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

import { chromium } from '@playwright/test';

const url = process.argv[2] ?? 'http://127.0.0.1:4173/';
const target = 'src/main.tsx';

const fail = (message) => {
  console.error(`probe-service-worker: ${message}`);
  process.exitCode = 1;
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

// ── 1. the page keeps itself open ─────────────────────────────────────────────
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(1_500);
await page.reload({ waitUntil: 'load' }); // from here the installed worker controls
await page.evaluate(() => {
  window.__probeMarker = 'here';
});
await page.waitForTimeout(3_000);
const survived = await page.evaluate(() => window.__probeMarker === 'here');
console.log(`${survived ? 'ok  ' : 'FAIL'}  the app did not reload itself within 3s of loading`);
if (!survived) fail('the page reloaded itself — the worker claimed the client and something reloaded on it');

const toastCount = await page.getByText('New version available').count();
console.log(`${toastCount === 0 ? 'ok  ' : 'FAIL'}  no update toast on a normal load (found ${toastCount})`);
if (toastCount !== 0) fail('an update was offered on a load where nothing changed');

// ── 2. an update is offered, and applied on request ───────────────────────────
const original = readFileSync(target, 'utf8');
try {
  appendFileSync(target, `\nconsole.info('probe-service-worker: a new version');\n`);
  execSync('pnpm run build', { stdio: 'ignore' });
  console.log('     (built a changed bundle — that is what makes a new version)');

  await page.reload({ waitUntil: 'load' });
  const offered = await page
    .getByText('New version available')
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  console.log(`${offered ? 'ok  ' : 'FAIL'}  a new version was offered instead of applied`);
  if (!offered) fail('no update toast — the worker is applying updates by itself again');

  if (offered) {
    await page.evaluate(() => {
      window.__probeMarker = 'here';
    });
    await page.getByRole('button', { name: 'Reload', exact: true }).click();
    await page.waitForTimeout(1_500);
    const reloaded = (await page.evaluate(() => window.__probeMarker)) !== 'here';
    console.log(`${reloaded ? 'ok  ' : 'FAIL'}  tapping Reload reloaded the page`);
    if (!reloaded) fail('the Reload button did not reload');
  }
} finally {
  writeFileSync(target, original);
  execSync('pnpm run build', { stdio: 'ignore' });
  console.log('     (restored the source and rebuilt)');
}

await browser.close();
console.log(process.exitCode ? 'probe-service-worker: FAILED' : 'probe-service-worker: all checks passed');
