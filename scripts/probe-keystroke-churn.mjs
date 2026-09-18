// Counts how much the page *touches the document* per keystroke.
//
//     node scripts/probe-keystroke-churn.mjs <url> <modal|settings> [width] [height]
//
// Typing one character should cost one React render of the small subtree around the
// input. It should not cost a document-wide scroll-lock flip or a focus change: both
// throw away layout for the whole page, and on a big display that is what "there is
// a delay between every letter" turns out to be. Focus churn also silently steals
// the caret. Counting these is what makes the difference measurable rather than
// something to squint at.
import { chromium } from '@playwright/test';

const [, , url, which, w = '2880', h = '1440'] = process.argv;
const TARGETS = {
  modal: 'input[placeholder="e.g. Sam"]',
  settings: 'input[placeholder^="github_pat"]',
};
const CHARS = 'ABCDEFGHIJKLMNOPQRST'.split('');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: +w, height: +h } });
await page.goto(url, { waitUntil: 'load' });
if (which === 'settings') { await page.goto(`${url}#/settings`, { waitUntil: 'load' }); await page.waitForTimeout(600); }
await page.waitForSelector(TARGETS[which], { timeout: 15_000 });
await page.waitForTimeout(400);

await page.evaluate(() => {
  const counters = { focus: 0, overflow: 0, listeners: 0, reflows: 0 };
  window.__counters = counters;

  const focus = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function patched(...args) {
    counters.focus += 1;
    return focus.apply(this, args);
  };

  const overflow = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, 'overflow');
  Object.defineProperty(document.body.style, 'overflow', {
    configurable: true,
    get() {
      return overflow.get.call(this);
    },
    set(value) {
      counters.overflow += 1;
      overflow.set.call(this, value);
    },
  });

  const add = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function patched(type, ...rest) {
    if (type === 'keydown') counters.listeners += 1;
    return add.call(this, type, ...rest);
  };

  // Reading offsetHeight means layout had been thrown away and had to be rebuilt.
  const oh = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      counters.reflows += 1;
      return oh.get.call(this);
    },
  });
});

const input = page.locator(TARGETS[which]);
await input.press('Shift'); // let anything from mount settle before measuring
const before = await page.evaluate(() => ({ ...window.__counters }));
for (const ch of CHARS) await input.press(ch);
const after = await page.evaluate(() => ({ ...window.__counters }));
const value = await input.inputValue();
const delta = Object.fromEntries(Object.keys(after).map((k) => [k, after[k] - before[k]]));
const focused = await page.evaluate(() => {
  const a = document.activeElement;
  if (!a) return 'nothing';
  const ph = a.getAttribute('placeholder');
  return `${a.tagName.toLowerCase()}${ph ? `[placeholder=${ph}]` : `[class=${String(a.className).slice(0, 24)}]`}`;
});

console.log(`${which} at ${w}x${h}: ${CHARS.length} keystrokes, field holds "${value}"`);
console.log(`  focus() calls            ${delta.focus}`);
console.log(`  body overflow writes     ${delta.overflow}`);
console.log(`  keydown listeners added  ${delta.listeners}`);
console.log(`  forced-layout reads      ${delta.reflows}`);
console.log(`  focus ends on            ${focused}`);
await browser.close();
