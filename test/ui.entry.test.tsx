// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cureDueAt } from '@/core/batches';
import { DEFAULT_LINES, DEFAULT_SETTINGS } from '@/core/defaults';
import type { Product } from '@/core/types';
import { batchesOnDay } from '@/data/batchRepo';
import { db, saveSettings } from '@/data/db';
import { Entry } from '@/screens/Entry';
import { signInForTests } from './support/who';
import { buttonNamed, byText, click, render, settle, typeInto, waitUntil, type Rendered } from './support/render';

/**
 * The entry sheet in the DOM.
 *
 * What matters here is the moment a count of trays becomes a rack: the quantity the
 * floor sees before pressing the button has to be the quantity that lands in the
 * day, and a row that cannot be logged has to stop the button rather than be
 * quietly dropped. Nothing in this file trusts the screen's own arithmetic — the
 * day is read back out of the database and compared.
 */

function product(code: string, over: Partial<Product> = {}): Product {
  return {
    code,
    description: `${code} paver`,
    enabled: true,
    route: 'manufacture',
    usesBaseline10000: false,
    unit: 'm2',
    trayYield: 2,
    target: 100,
    cureDays: 2,
    notes: '',
    rank: 1000,
    seenInJobs: true,
    updatedAt: 1,
    ...over,
  };
}

async function reset(): Promise<void> {
  signInForTests('maker');
  window.location.hash = '#/entry';
  localStorage.removeItem('freo.entry.line');
  await Promise.all([db.batches.clear(), db.products.clear(), db.events.clear(), db.lines.clear(), db.meta.clear()]);
  await saveSettings(structuredClone(DEFAULT_SETTINGS));
  await db.products.bulkAdd([
    product('S3'),
    product('S4', { trayYield: 0.5, rank: 2000 }),
    product('S7', { route: 'unset', rank: 3000 }),
    product('S8', { trayYield: 0, rank: 4000 }),
    product('ZZ', { enabled: false, rank: 5000 }),
  ]);
  await db.lines.bulkAdd(DEFAULT_LINES.map((l) => ({ ...l, updatedAt: 1 })));
}

// One Entry at a time. The screen clears the `?code=` a jump arrives with, so a
// previous test's screen left mounted would strip it out of the address before the
// one under test reads it — and the failure would look like a broken screen.
let mounted: Rendered | null = null;

async function open(): Promise<Rendered> {
  mounted?.unmount();
  const view = render(<Entry />);
  mounted = view;
  await settle();
  return view;
}

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

/** A product picker is a `select`, so it changes through its own event. */
function pickProduct(host: HTMLElement, code: string, which = 0): void {
  const select = host.querySelectorAll<HTMLSelectElement>('select[aria-label="Product"]')[which];
  if (!select) throw new Error(`no product picker at position ${which}`);
  select.value = code;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

function traysField(host: HTMLElement, which = 0): HTMLInputElement {
  const input = host.querySelectorAll<HTMLInputElement>('input[aria-label="Trays"]')[which];
  if (!input) throw new Error(`no trays field at position ${which}`);
  return input;
}

async function logDay(host: HTMLElement): Promise<void> {
  const button = host.querySelector<HTMLButtonElement>('[data-entry-submit]');
  if (!button) throw new Error('no log button');
  click(button);
  await settle();
}

describe('logging the day', () => {
  beforeEach(reset);

  it('shows the quantity the trays make before anything is written down', async () => {
    const { host } = await open();
    pickProduct(host, 'S3');
    await settle();
    typeInto(traysField(host), '10');
    await settle();

    // Trays × this product's yield. The floor reads the same number it is about to
    // put into MYOB, so the two can be compared where they are typed.
    expect(host.querySelector('[data-entry-qty]')?.textContent).toBe('20.00 m²');
    expect(host.querySelector('[data-entry-totals]')?.textContent).toBe('10 trays · 20.00 m²');
    expect(host.querySelector<HTMLButtonElement>('[data-entry-submit]')?.textContent).toContain('Log 10 trays on Line 1');
  });

  it('writes the rack into the day, on the cure clock, and clears the sheet', async () => {
    const { host } = await open();
    pickProduct(host, 'S3');
    typeInto(traysField(host), '10');
    await logDay(host);

    await waitUntil(() => host.querySelectorAll('[data-logged-batch]').length === 1, 'the rack to appear');
    const [written] = await batchesOnDay(Date.now());
    const row = host.querySelector('[data-logged-batch]');
    expect(row?.getAttribute('data-logged-batch')).toBe(written?.batchNo);
    expect(row?.textContent).toContain('S3');
    expect(row?.textContent).toContain('10 trays');
    expect(row?.textContent).toContain('20.00 m²');
    expect(row?.textContent).toContain('Curing');

    const [batch] = await batchesOnDay(Date.now());
    expect(batch).toMatchObject({ code: 'S3', trays: 10, qty: 20, stage: 'curing', lineId: 'line-1' });
    expect(batch?.cureDueAt).toBe(cureDueAt(batch!.madeAt, 2));

    // The sheet is empty again: the list below is the record now, and a leftover
    // row is a row someone logs twice.
    expect(traysField(host).value).toBe('');
    expect(host.querySelector('[data-entry-totals]')?.textContent).toBe('Nothing counted yet');
  });

  it('logs several products on one line as separate racks, numbered in order', async () => {
    const { host } = await open();
    pickProduct(host, 'S3');
    typeInto(traysField(host), '10');
    click(buttonNamed(host, 'Another product'));
    await settle();
    pickProduct(host, 'S4', 1);
    typeInto(traysField(host, 1), '4');
    await settle();

    expect(host.querySelectorAll('[data-entry-problem]')).toHaveLength(0);
    await logDay(host);
    await waitUntil(() => host.querySelectorAll('[data-logged-batch]').length === 2, 'two racks');

    const day = await batchesOnDay(Date.now());
    expect(day.map((b) => b.code).sort()).toEqual(['S3', 'S4']);
    expect(day.map((b) => b.qty).sort((a, b) => a - b)).toEqual([2, 20]);
  });

  it('stops the button when a row cannot be logged, and says which one', async () => {
    const { host } = await open();
    pickProduct(host, 'S8'); // no tray yield
    typeInto(traysField(host), '5');
    await settle();

    expect(host.querySelector('[data-entry-problem]')?.textContent).toBe('S8 has no tray yield — set it on Products');
    expect(host.querySelector<HTMLButtonElement>('[data-entry-submit]')?.disabled).toBe(true);
    expect(await batchesOnDay(Date.now())).toEqual([]);
  });

  it('sends a shotblast make to the blaster’s queue, still on the cure clock', async () => {
    await db.products.put(product('B2', { route: 'shotblast', rank: 6000 }));
    const { host } = await open();
    pickProduct(host, 'B2');
    typeInto(traysField(host), '3');
    await logDay(host);

    await waitUntil(() => host.querySelectorAll('[data-logged-batch]').length === 1, 'the rack');
    expect(host.querySelector('[data-logged-batch]')?.textContent).toContain('Needs blast');
  });

  it('keeps the line this device was last on', async () => {
    const first = await open();
    click(first.host.querySelector<HTMLButtonElement>('[data-entry-line="line-2"]')!);
    await settle();
    first.unmount();

    const again = await open();
    expect(again.host.querySelector<HTMLButtonElement>('[data-entry-line="line-2"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(again.host.querySelector('[data-entry-submit]')?.textContent).toContain('on Line 2');
  });

  it('arrives with the product already chosen when the board sends someone here', async () => {
    window.location.hash = '#/entry?code=S4';
    const { host } = await open();
    expect(host.querySelector<HTMLSelectElement>('select[aria-label="Product"]')?.value).toBe('S4');
    // The address is cleaned so the bookmark does not keep offering S4 next week.
    expect(window.location.hash).toBe('#/entry');
  });
});

describe('the day as a record', () => {
  beforeEach(reset);

  it('takes a rack back while it has gone nowhere', async () => {
    const { host } = await open();
    pickProduct(host, 'S3');
    typeInto(traysField(host), '10');
    await logDay(host);
    await waitUntil(() => host.querySelectorAll('[data-logged-batch]').length === 1, 'the rack');

    click(host.querySelector<HTMLButtonElement>('[data-undo-batch]')!);
    await settle();

    expect(host.querySelectorAll('[data-logged-batch]')).toHaveLength(0);
    expect(byText(host, 'Nothing logged yet')).toBeTruthy();
    expect(await batchesOnDay(Date.now())).toEqual([]);
    expect(await db.events.where('action').equals('batch.undo').count()).toBe(1);
  });

  it('refuses to take back one that has been blasted, and keeps it on the list', async () => {
    const { host } = await open();
    pickProduct(host, 'S3');
    typeInto(traysField(host), '10');
    await logDay(host);
    await waitUntil(() => host.querySelectorAll('[data-logged-batch]').length === 1, 'the rack');

    const [batch] = await batchesOnDay(Date.now());
    await db.batches.put({ ...batch!, blastedQty: 1, blastedAt: Date.now() });
    await settle();

    expect(host.querySelectorAll('[data-undo-batch]')).toHaveLength(0);
    expect(byText(host, 'past taking back')).toBeTruthy();
    expect(host.querySelectorAll('[data-logged-batch]')).toHaveLength(1);
  });

  it('shows only its own line’s making, and counts the rest of the shop', async () => {
    const { host } = await open();
    pickProduct(host, 'S3');
    typeInto(traysField(host), '10');
    await logDay(host);

    click(host.querySelector<HTMLButtonElement>('[data-entry-line="line-2"]')!);
    await settle();
    expect(host.querySelectorAll('[data-logged-batch]')).toHaveLength(0);
    expect(byText(host, '1 across the shop')).toBeTruthy();
  });

  it('reads back a day logged yesterday, and says it is being written up late', async () => {
    const { host } = await open();
    click(host.querySelector<HTMLButtonElement>('[aria-label="The day before"]')!);
    await settle();

    expect(host.querySelector('[data-entry-backdate]')).toBeTruthy();
    pickProduct(host, 'S3');
    typeInto(traysField(host), '6');
    await logDay(host);

    await waitUntil(() => host.querySelectorAll('[data-logged-batch]').length === 1, 'the rack');
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const logged = await batchesOnDay(yesterday.getTime());
    expect(logged).toHaveLength(1);
    // Nothing was logged against a day that has not happened.
    expect(await batchesOnDay(Date.now())).toEqual([]);
  });
});

describe('a viewer reading the floor', () => {
  beforeEach(reset);

  it('shows what was logged but will not log it', async () => {
    const maker = await open();
    pickProduct(maker.host, 'S3');
    typeInto(traysField(maker.host), '10');
    await logDay(maker.host);
    await waitUntil(() => maker.host.querySelectorAll('[data-logged-batch]').length === 1, 'the rack');
    maker.unmount();
    mounted = null;
    signInForTests('viewer');

    const view = await open();
    expect(view.host.querySelectorAll('[data-logged-batch]')).toHaveLength(1);
    expect(view.host.querySelector<HTMLButtonElement>('[data-entry-submit]')?.disabled).toBe(true);
    expect(view.host.querySelectorAll('[data-undo-batch]')).toHaveLength(0);
    expect(byText(view.host, 'Logging it takes a maker or owner sign-in')).toBeTruthy();
  });
});

describe('when there is nothing to log yet', () => {
  it('says which screen to fix, instead of showing an empty picker', async () => {
    signInForTests('maker');
    await db.products.bulkPut((await db.products.toArray()).map((p) => ({ ...p, enabled: false })));
    const { host } = await open();
    expect(byText(host, 'No product codes are yours yet')).toBeTruthy();
    expect(host.querySelector('[data-entry-submit]')).toBeNull();
  });
});
