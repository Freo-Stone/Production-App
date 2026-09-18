// Profiles the page while typing and reports what the CPU spent each keystroke on.
//
//     node scripts/probe-typing.mjs <url> <modal|settings> <width> <height> <cpu-throttle>
//
// Absolute millisecond numbers from a headless browser are not worth much: it
// composites in software, so everything looks slower than it is. What is worth
// something is the *shape* of the work — which functions the samples land in, and
// how a keystroke splits between script and rendering. That is what told me whether
// the name box was slow because of React, because of the CSS behind it, or because
// of the machine.
import { chromium } from '@playwright/test';

const [, , url, which, w, h, throttle] = process.argv;
const TARGETS = {
  modal: 'input[placeholder="e.g. Sam"]',
  settings: 'input[placeholder^="github_pat"]',
};
const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: +w, height: +h } });
const cdp = await page.context().newCDPSession(page);
if (+throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: +throttle });

await page.goto(url, { waitUntil: 'networkidle' });
if (which === 'settings') await page.goto(`${url}#/settings`, { waitUntil: 'networkidle' });
await page.waitForSelector(TARGETS[which], { timeout: 10_000 });

// Event Timing: what the browser itself says each keystroke cost, split into
// script (processing) and everything else (rendering, waiting for a frame).
await page.evaluate(() => {
  window.__events = [];
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      window.__events.push({
        name: e.name,
        duration: e.duration,
        processing: e.processingEnd - e.processingStart,
        rest: e.duration - (e.processingEnd - e.startTime),
      });
    }
  }).observe({ type: 'event', durationThreshold: 1 });
});

await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
await cdp.send('Profiler.start');

const input = page.locator(TARGETS[which]);
for (const ch of CHARS) await input.press(ch);

const { profile } = await cdp.send('Profiler.stop');
const events = await page.evaluate(() => window.__events);

const byNode = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map();
for (const id of profile.samples) {
  const n = byNode.get(id);
  if (!n) continue;
  const f = n.callFrame;
  const name = `${f.functionName || '(anonymous)'}  ${(f.url || '').split('/').pop()}:${f.lineNumber + 1}`;
  self.set(name, (self.get(name) ?? 0) + 1);
}
const total = profile.samples.length;
const wall = (profile.endTime - profile.startTime) / 1000;
console.log(`\n${which} at ${w}x${h} cpu×${throttle}: ${CHARS.length} keystrokes, ${total} samples, ${wall.toFixed(0)}ms wall`);
for (const [name, count] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`  ${((count / total) * 100).toFixed(1).padStart(5)}%  ${name}`);
}
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
for (const name of ['keydown', 'keypress', 'input']) {
  const e = events.filter((x) => x.name === name);
  if (!e.length) continue;
  console.log(
    `  ${name.padEnd(8)} n=${String(e.length).padEnd(3)} median ${median(e.map((x) => x.duration)).toFixed(1).padStart(6)}ms` +
      `  script ${median(e.map((x) => x.processing)).toFixed(1).padStart(6)}ms` +
      `  render/wait ${median(e.map((x) => x.rest)).toFixed(1).padStart(6)}ms`,
  );
}
await browser.close();
