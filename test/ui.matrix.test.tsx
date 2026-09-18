// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { JobRow, Product, StockRow } from '@/core/types';
import { DEFAULT_SETTINGS } from '@/core/defaults';
import { addDays, dayStart } from '@/core/dates';
import { db, replaceJobsSnapshot, replaceStockSnapshot, seedIfEmpty } from '@/data/db';
import { Matrix } from '@/screens/Matrix';
import { signInForTests } from './support/who';
import { byText, click, render, rows, type Rendered, typeInto } from './support/render';

/**
 * The board in the DOM.
 *
 * `test/core.matrix.test.ts` owns the arithmetic; this file is about what the
 * board *does*: which products get a row, what a colour is attached to, what a tap
 * opens, and what the screen says when there is nothing to show. The figures are
 * synthetic — the shop's own export volumes are not this file's business, and this
 * repository is public.
 */

// The board's horizon is anchored to today on the device's own clock, so the
// fixture is anchored to the same thing: a fixed date would fall out of the window
// the moment the board asked "what is today?".
const NOW = dayStart(Date.now());

function product(code: string, over: Partial<Product> = {}): Product {
  return {
    code,
    description: `${code} paver`,
    enabled: true,
    route: 'manufacture',
    usesBaseline10000: false,
    unit: 'm2',
    trayYield: 1.44,
    target: 100,
    cureDays: 2,
    notes: '',
    rank: code === 'A2' ? 1000 : 2000,
    seenInJobs: true,
    updatedAt: 1,
    ...over,
  };
}

function stock(code: string, qty: number): StockRow {
  return { code, location: 'HQ', qtyOnHandRaw: qty, category: 'Paving' };
}

function job(code: string, qty: number, promised: number, customer: string, orderNo: string): JobRow {
  return {
    id: `${code}|${orderNo}`,
    itemCode: code,
    itemDescription: `${code} paver`,
    customer,
    orderNo,
    orderDate: null,
    promisedDate: promised,
    qty,
    shipVia: 'Pickup',
    salesperson: 'Test Person',
    rank: 1,
  };
}

const DIAGNOSTICS = {
  sheetName: 'Sheet1',
  reportTitle: 'test',
  headerRow: 1,
  rowsRead: 1,
  rowsUsed: 1,
  totalRowsSkipped: 0,
  groupRowsSkipped: 0,
  unparsed: [],
};

async function reset(): Promise<void> {
  signInForTests();
  await Promise.all([
    db.products.clear(),
    db.batches.clear(),
    db.events.clear(),
    db.views.clear(),
    db.stockSnapshots.clear(),
    db.stockRows.clear(),
    db.jobsSnapshots.clear(),
    db.jobRows.clear(),
  ]);
  await seedIfEmpty();
}

/** Live queries settle on their own clock; give them a few ticks each time. */
async function paint(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function seed(opts: {
  products?: Product[];
  stock?: StockRow[];
  jobs?: JobRow[];
} = {}): Promise<void> {
  if (opts.products?.length) await db.products.bulkAdd(opts.products);
  if (opts.stock?.length) {
    await replaceStockSnapshot({
      id: 'stock-1',
      capturedAt: NOW,
      source: 'test',
      rows: opts.stock,
      diagnostics: DIAGNOSTICS,
    });
  }
  if (opts.jobs?.length) {
    await replaceJobsSnapshot({
      id: 'jobs-1',
      capturedAt: NOW,
      source: 'test',
      periodFrom: null,
      periodTo: null,
      rows: opts.jobs,
      diagnostics: DIAGNOSTICS,
    });
  }
}

async function renderMatrix(): Promise<Rendered> {
  const h = render(<Matrix />);
  await paint();
  return h;
}

function rowFor(host: HTMLElement, code: string): HTMLElement {
  const row = rows(host).find(
    (r) => r.querySelector<HTMLElement>('[data-col="code"]')?.textContent?.trim() === code,
  );
  if (!row) throw new Error(`no row for ${code}. Screen: ${host.textContent?.slice(0, 400)}`);
  return row;
}

function dayCell(host: HTMLElement, code: string, day: number): HTMLElement {
  const cell = rowFor(host, code).querySelector<HTMLElement>(`[data-col="d${day}"]`);
  if (!cell) throw new Error(`no cell for ${code} on ${new Date(day).toDateString()}`);
  return cell;
}

function dialog(host: HTMLElement): HTMLElement {
  const panel = host.ownerDocument?.querySelector<HTMLElement>('[role="dialog"]');
  if (!panel) throw new Error('no dialog open');
  return panel;
}

describe('the matrix', () => {
  beforeEach(reset);

  it('points at the exports when nothing has been imported', async () => {
    const h = await renderMatrix();
    expect(byText(h.host, 'Nothing imported yet')).toBeTruthy();
    h.unmount();
  });

  it('points at Products when the range is empty', async () => {
    await seed({
      products: [product('A2', { enabled: false })],
      stock: [stock('A2', 10)],
    });
    const h = await renderMatrix();
    expect(byText(h.host, 'No products are in the current range')).toBeTruthy();
    h.unmount();
  });

  it('shows one row per current product with the figures beside it', async () => {
    await seed({
      products: [product('A2'), product('G3')],
      stock: [stock('A2', 60), stock('G3', 400)],
    });
    const h = await renderMatrix();

    expect(rows(h.host)).toHaveLength(2);
    expect(dayCell(h.host, 'A2', dayStart(NOW)).parentElement).toBeTruthy();
    const stockCell = rowFor(h.host, 'A2').querySelector<HTMLElement>('[data-col="stock"]');
    expect(stockCell?.textContent).toContain('60');
    // The horizon is four weeks by default: 28 day columns on top of the eight
    // describing the product. Which ones are on screen is a per-user view.
    const dayHeaders = h.headerLabels().filter((label) => /^\w{3} \d+$/.test(label));
    expect(dayHeaders.length).toBe(28);
    h.unmount();
  });

  it('paints a short row red and one that only needs curing green', async () => {
    await seed({
      products: [product('A2'), product('G3')],
      stock: [stock('A2', 60), stock('G3', 60)],
    });
    await db.batches.add({
      id: 'b-1',
      batchNo: '2026-09-16-01',
      code: 'G3',
      lineId: 'line-1',
      trays: 28,
      qty: 40,
      qtyOverridden: false,
      routeSnapshot: 'manufacture',
      stage: 'curing',
      madeAt: NOW - 86_400_000,
      cureDaysSnapshot: 2,
      cureDueAt: NOW + 86_400_000,
      blastedQty: 0,
      blastedAt: null,
      myobRunDate: null,
      enteredAt: null,
      enteredRef: '',
      operator: 'Test Maker',
      note: '',
      rank: 1000,
      parentBatchId: null,
      updatedAt: 1,
    });
    const h = await renderMatrix();

    expect(rowFor(h.host, 'A2').querySelector('[data-col="stock"] .text-short')).toBeTruthy();
    expect(rowFor(h.host, 'G3').querySelector('[data-col="incl"] .text-curing')).toBeTruthy();
    h.unmount();
  });

  it('puts what is promised on a day in that day’s cell', async () => {
    const day3 = addDays(dayStart(NOW), 3);
    await seed({
      products: [product('A2')],
      stock: [stock('A2', 60)],
      jobs: [job('A2', 28.8, day3, 'Test Customer', 'SO-11'), job('A2', 14.4, day3, 'Other Buyer', 'SO-12')],
    });
    const h = await renderMatrix();

    expect(dayCell(h.host, 'A2', day3).textContent).toContain('43.2');
    const due = rowFor(h.host, 'A2').querySelector('[data-col="due"]');
    expect(due?.textContent).toContain('43.2');
    h.unmount();
  });

  it('opens the jobs behind a cell when it is tapped', async () => {
    const day3 = addDays(dayStart(NOW), 3);
    await seed({
      products: [product('A2')],
      stock: [stock('A2', 60)],
      jobs: [job('A2', 28.8, day3, 'Test Customer', 'SO-11'), job('A2', 14.4, day3, 'Other Buyer', 'SO-12')],
    });
    const h = await renderMatrix();

    const button = dayCell(h.host, 'A2', day3).querySelector('button');
    if (!button) throw new Error('a day cell is not tappable');
    click(button);
    await paint();

    const panel = dialog(h.host);
    expect(panel.textContent).toContain('Test Customer');
    expect(panel.textContent).toContain('Other Buyer');
    expect(panel.textContent).toContain('SO-11');
    // The figures a decision needs, not just the lines.
    expect(panel.textContent).toContain('To get to target');
    h.unmount();
  });

  it('says so when a promise is past the last day a make could start', async () => {
    await seed({
      products: [product('A2', { cureDays: 14 })],
      stock: [stock('A2', 0)],
      jobs: [job('A2', 40, dayStart(NOW), 'Test Customer', 'SO-21')],
    });
    const h = await renderMatrix();

    const cell = dayCell(h.host, 'A2', dayStart(NOW));
    expect(cell.querySelector('.text-warn')?.textContent).toBe('!');
    h.unmount();
  });

  it('hides everything that is not short, and says so when nothing is', async () => {
    await seed({
      products: [product('A2'), product('G3', { target: 0 })],
      stock: [stock('A2', 60), stock('G3', 500)],
    });
    const h = await renderMatrix();
    expect(rows(h.host)).toHaveLength(2);

    click(h.host.querySelectorAll<HTMLButtonElement>('[role="switch"]')[0]!);
    await paint();
    expect(rows(h.host)).toHaveLength(1);
    expect(rowFor(h.host, 'A2')).toBeTruthy();

    // An empty board is an answer, not a blank screen: it says which filter did it.
    click(h.host.querySelectorAll<HTMLButtonElement>('[role="switch"]')[0]!);
    await paint();
    typeInto(h.host.querySelector<HTMLInputElement>('input[placeholder^="Filter code"]')!, 'zzz');
    await paint();
    expect(byText(h.host, 'Nothing matches this filter')).toBeTruthy();
    h.unmount();
  });

  it('narrowing the horizon to a week takes the board down to seven days', async () => {
    await seed({ products: [product('A2')], stock: [stock('A2', 60)] });
    const h = await renderMatrix();

    click(byText(h.host, '1 wk'));
    await paint();

    const dayHeaders = h.headerLabels().filter((label) => /^\w{3} \d+$/.test(label));
    expect(dayHeaders.length).toBe(7);
    // The choice is a view, so it belongs to the person who made it and comes back
    // on the next load — the shop's default is still four weeks.
    const saved = await db.views.toArray();
    expect(saved.some((v) => v.horizonWeeks === 1)).toBe(true);
    expect(DEFAULT_SETTINGS.planning.defaultHorizonWeeks).toBe(4);
    h.unmount();
  });

  it('on a phone the board keeps its days', async () => {
    // The phone board is a short list of columns, and that list is matched against
    // the columns key for key. When the list was written with a date string and the
    // columns carried a day stamp, a phone got the products and not one day — a
    // board of everything except the part a person came to read.
    const day3 = addDays(dayStart(Date.now()), 3);
    await seed({
      products: [product('A2')],
      stock: [stock('A2', 60)],
      jobs: [job('A2', 12, day3, 'Test Customer', 'SO-31')],
    });

    const real = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes('max-width'),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;

    try {
      const h = await renderMatrix();
      const dayHeaders = h.headerLabels().filter((label) => /^\w{3} \d+$/.test(label));
      expect(dayHeaders).toHaveLength(4);
      // `data-col^="d"` would be wrong here: `description` starts with a d too.
      const dayCells = new Set(
        [...h.host.querySelectorAll<HTMLElement>('.dt-cell[data-col]')]
          .map((c) => c.dataset['col'] ?? '')
          .filter((key) => /^d\d+$/.test(key)),
      );
      expect(dayCells.size).toBe(4);
      // The four are the next four days, not four arbitrary ones.
      expect(dayCells.has(`d${day3}`)).toBe(true);
      h.unmount();
    } finally {
      window.matchMedia = real;
    }
  });

  it('pins the product columns so the days can scroll under them', async () => {
    await seed({ products: [product('A2')], stock: [stock('A2', 60)] });
    const h = await renderMatrix();

    const pinned = [...rowFor(h.host, 'A2').querySelectorAll<HTMLElement>('[data-pinned="true"]')].map(
      (c) => c.dataset['col'],
    );
    expect(pinned).toEqual(['code', 'description']);
    // Everything after them scrolls, which is the point of pinning them.
    const day = rowFor(h.host, 'A2').querySelector<HTMLElement>(`[data-col="d${dayStart(NOW)}"]`);
    expect(day?.dataset['pinned']).not.toBe('true');
    h.unmount();
  });
});
