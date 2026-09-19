// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LINES, DEFAULT_SETTINGS } from '@/core/defaults';
import { dayStart } from '@/core/dates';
import type { Batch, JobsSnapshot, JobRow, Product, StockRow, StockSnapshot } from '@/core/types';
import { db, replaceJobsSnapshot, replaceStockSnapshot, saveSettings } from '@/data/db';
import { Curing } from '@/screens/Curing';
import { Entry } from '@/screens/Entry';
import { FutureJobs } from '@/screens/FutureJobs';
import { Matrix } from '@/screens/Matrix';
import { Schedule } from '@/screens/Schedule';
import { setMediaWidth } from './setup';
import { signInForTests } from './support/who';
import { byText, click, render, rows, settle, type Rendered } from './support/render';

/**
 * The current range, screen by screen.
 *
 * `test/core.currentRange.test.ts` proves the predicate and the row builders. This
 * file proves the part only a screen can get wrong: on every screen the rows a person
 * sees are the same rows every figure on that screen is reduced over, and the two
 * places that must *not* cut their rows — the order book, and the racks holding work
 * already made — keep everything and mark the exception instead.
 *
 * The failure mode this is written against is the old one: each screen deciding for
 * itself what "a product we make" means, and one shop ending up with five numbers.
 */

/**
 * The clock is pinned, and not for tidiness. Every row set here is decided against
 * "today": a promise three days out belongs on this week's plan, the same promise is
 * behind on a Thursday, and a board built from a fixed date falls out of the horizon
 * as soon as the device's date moves past it. Same Wednesday as
 * `test/ui.myob.test.tsx`: 16 September 2026, 11am Perth — midweek, entry day ahead.
 */
const CLOCK = Date.parse('2026-09-16T11:00:00+08:00');
const TODAY = dayStart(CLOCK);
const DAY = 86_400_000;

/** A promised date `days` from today, at midday so no boundary is ambiguous. */
const promisedOn = (days: number): number => TODAY + days * DAY + 12 * 3_600_000;

function product(code: string, over: Partial<Product> = {}): Product {
  return {
    code,
    description: `${code} limestone`,
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

function job(orderNo: string, code: string, over: Partial<JobRow> = {}): JobRow {
  return {
    id: `${code}|${orderNo}`,
    itemCode: code,
    itemDescription: `${code} limestone`,
    customer: 'Bunnings',
    orderNo,
    orderDate: promisedOn(-20),
    promisedDate: promisedOn(4),
    qty: 8,
    shipVia: 'DELIVER',
    salesperson: 'Karen',
    rank: 1,
    ...over,
  };
}

function stockRow(code: string, qty: number): StockRow {
  return { code, location: 'HQ', qtyOnHandRaw: qty, category: 'Stone' };
}

function rack(over: Partial<Batch> = {}): Batch {
  const madeAt = TODAY - 2 * DAY;
  return {
    id: 'b-1',
    batchNo: '2026-09-14-01',
    code: 'OLD',
    lineId: 'line-1',
    trays: 3,
    qty: 6,
    qtyOverridden: false,
    routeSnapshot: 'manufacture',
    stage: 'curing',
    madeAt,
    cureDaysSnapshot: 2,
    cureDueAt: madeAt + 2 * DAY,
    blastedQty: 0,
    blastedAt: null,
    myobRunDate: null,
    enteredAt: null,
    enteredRef: '',
    operator: 'Test Person',
    note: '',
    rank: 1000,
    parentBatchId: null,
    updatedAt: 1,
    ...over,
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

interface Seed {
  products?: Product[];
  jobs?: JobRow[];
  stock?: StockRow[];
  batches?: Batch[];
}

async function clear(): Promise<void> {
  await Promise.all([
    db.products.clear(),
    db.batches.clear(),
    db.lines.clear(),
    db.events.clear(),
    db.views.clear(),
    db.meta.clear(),
    db.planItems.clear(),
    db.stockSnapshots.clear(),
    db.stockRows.clear(),
    db.jobsSnapshots.clear(),
    db.jobRows.clear(),
  ]);
  localStorage.removeItem('freo.entry.line');
  await saveSettings(structuredClone(DEFAULT_SETTINGS));
  await db.lines.bulkAdd(DEFAULT_LINES.map((l) => ({ ...l, updatedAt: 1 })));
}

async function seed(options: Seed): Promise<void> {
  if (options.products?.length) await db.products.bulkAdd(options.products);
  if (options.batches?.length) await db.batches.bulkAdd(options.batches);
  if (options.stock?.length) {
    const capture: StockSnapshot = {
      id: 'stock-1',
      capturedAt: TODAY - DAY,
      source: 'location.xlsx',
      rows: options.stock,
      diagnostics: DIAGNOSTICS,
    };
    await replaceStockSnapshot(capture);
  }
  if (options.jobs?.length) {
    const capture: JobsSnapshot = {
      id: 'jobs-1',
      capturedAt: TODAY,
      source: 'future.xlsx',
      periodFrom: TODAY - 200 * DAY,
      periodTo: TODAY,
      rows: options.jobs,
      diagnostics: DIAGNOSTICS,
    };
    await replaceJobsSnapshot(capture);
  }
}

/**
 * One shop, three kinds of code.
 *
 * `GL4` is in the range and short (300 promised against 60 m² on the shelf).
 * `OLD` is ours with the tick off, and short by more (900 against 400) — so if any
 * screen is still counting unticked codes, it shows up as a row, a chip or a total.
 * `ZZ9` appears in the last test only: a code this device has never seen.
 */
function shop(over: Partial<Seed> = {}): Seed {
  return {
    products: [product('GL4'), product('OLD', { enabled: false, rank: 2000 })],
    stock: [stockRow('GL4', 60), stockRow('OLD', 400)],
    jobs: [job('SO-1', 'GL4', { qty: 300 }), job('SO-2', 'OLD', { qty: 900 })],
    ...over,
  };
}

let mounted: Rendered | null = null;

async function open(screen: ReactElement): Promise<Rendered> {
  mounted?.unmount();
  mounted = render(screen);
  await settle(8);
  return mounted;
}

beforeEach(() => {
  // Only `Date` is faked: the macrotask turns `settle()` waits on stay real, so the
  // live queries still land — pinning the timer functions too would hang the screen.
  vi.useFakeTimers({ now: CLOCK, toFake: ['Date'] });
  setMediaWidth(null);
  window.location.hash = '#/matrix';
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.useRealTimers();
});

function says(view: Rendered): string {
  return view.host.textContent ?? '';
}

function codesIn(host: HTMLElement): string[] {
  return rows(host)
    .map((row) => row.querySelector<HTMLElement>('[data-col="code"]')?.textContent?.trim() ?? '')
    .filter((code) => code !== '');
}

function columnIndexOf(view: Rendered, heading: string): number {
  const heads = [...view.host.querySelectorAll<HTMLElement>('.dt-head [role="columnheader"]')];
  const index = heads.findIndex((head) => (head.textContent ?? '').startsWith(heading));
  if (index < 0) throw new Error(`no column headed ${heading}. ${heads.map((h) => h.textContent).join('|')}`);
  return index;
}

function cellOf(view: Rendered, needle: string, heading: string): string {
  const index = columnIndexOf(view, heading);
  const row = rows(view.host).find((r) => (r.textContent ?? '').includes(needle));
  if (!row) throw new Error(`no row containing ${needle}`);
  return row.querySelectorAll('.dt-cell')[index]?.textContent?.trim() ?? '';
}

/** The figure a footer cell holds, read by the column's own heading. */
function totalOf(view: Rendered, heading: string): string {
  const index = columnIndexOf(view, heading);
  const totals = view.host.querySelector<HTMLElement>('.dt-totals');
  if (!totals) throw new Error('no totals row on the board');
  return totals.querySelectorAll('.dt-cell')[index]?.textContent?.trim() ?? '';
}

describe('the matrix', () => {
  beforeEach(async () => {
    await clear();
    signInForTests();
  });

  it('has no row for a code outside the range, and its totals do not either', async () => {
    await seed(shop());
    const view = await open(<Matrix />);

    expect(codesIn(view.host)).toEqual(['GL4']);
    // The footer adds the rows on the board and nothing else. `OLD` holds 400 m² and
    // is owed 900 more: if either reached the column sums, the board would be adding
    // up rows it refuses to show.
    expect(totalOf(view, 'In stock')).toContain('60');
    expect(totalOf(view, 'In stock')).not.toContain('460');
    expect(totalOf(view, 'Due in view')).not.toContain('900');
  });

  it('points at Products when the whole range is off', async () => {
    await seed(shop({ products: [product('GL4', { enabled: false }), product('OLD', { enabled: false })] }));
    const view = await open(<Matrix />);
    expect(byText(view.host, 'No products are in the current range')).toBeTruthy();
  });
});

describe('the making plan', () => {
  beforeEach(async () => {
    await clear();
    signInForTests('owner');
    window.location.hash = '#/schedule';
  });

  it('plans the current range, counts what the rule left out, and keeps its chips honest', async () => {
    await seed(shop());
    const view = await open(<Schedule />);

    expect(codesIn(view.host)).toEqual(['GL4']);
    // The chip's number is the number of rows. A chip promising two and showing one is
    // the same bug wearing a different hat.
    const all = view.host.querySelector<HTMLButtonElement>('[data-schedule-bucket="all"]');
    expect((all?.textContent ?? '').replace(/\D/g, '')).toBe('1');
    expect(rows(view.host)).toHaveLength(1);
    // And the row that is not there is named, counted and pointed at the order book.
    const note = view.host.querySelector('[data-schedule-offrange]')?.textContent ?? '';
    expect(note).toContain('1 row');
    expect(note).toContain('order book');
  });

  it('says which screen to fix when the only short codes are ones the shop does not make', async () => {
    await seed(shop({ products: [product('GL4', { enabled: false }), product('OLD', { enabled: false })] }));
    const view = await open(<Schedule />);
    expect(rows(view.host)).toHaveLength(0);
    expect(says(view)).toContain('Nothing in the current range has to be made');
    expect(says(view)).toContain('2 rows short');
  });
});

describe('the daily entry picker', () => {
  beforeEach(async () => {
    await clear();
    signInForTests('maker');
    window.location.hash = '#/entry';
  });

  it('offers the codes the shop makes, in the order Products put them in', async () => {
    await seed(
      shop({
        products: [product('GL4'), product('B2', { rank: 1500 }), product('OLD', { enabled: false, rank: 2000 })],
      }),
    );
    const view = await open(<Entry />);

    const picker = view.host.querySelector<HTMLSelectElement>('select[aria-label="Product"]');
    expect(picker).not.toBeNull();
    const offered = [...(picker?.options ?? [])].map((o) => o.value).filter((v) => v !== '');
    expect(offered).toEqual(['GL4', 'B2']);
    expect(offered).not.toContain('OLD');
  });

  it('says why a row holding an off-range code cannot be logged', async () => {
    // The Matrix hands a code over with "Log making of this". A board opened before
    // the tick changed can still send one that is no longer in the range, and the row
    // used to answer "pick a product" — to a person who had plainly picked one, and
    // who then found the picker did not offer it. Now it says what is wrong and where
    // to fix it, and the log stays shut.
    await seed(shop());
    window.location.hash = '#/entry?code=OLD';
    const view = await open(<Entry />);

    const note = view.host.querySelector('[data-entry-offrange]');
    expect(note?.textContent).toContain('OLD is not in the current range');
    expect(note?.textContent).toContain('Tick it on Products');
    expect(view.host.querySelectorAll('[data-entry-problem]')).toHaveLength(0);
    expect(view.host.querySelector<HTMLButtonElement>('[data-entry-submit]')?.disabled).toBe(true);
    expect(await db.batches.count()).toBe(0);
    // The row still shows the code it is holding, marked, rather than going blank.
    const picker = view.host.querySelector<HTMLSelectElement>('select[aria-label="Product"]');
    expect([...(picker?.options ?? [])].map((o) => o.label).join(' |')).toContain('not in the current range');
  });

  it('still shows racks logged under a code that has since come off the range', async () => {
    // The picker is the current range; the day's sheet is a record of what was made.
    // Unticking a code today must not delete today's racks off the screen.
    await seed(shop({ batches: [rack({ code: 'OLD', madeAt: TODAY + 3_600_000 })] }));
    const view = await open(<Entry />);
    expect(view.host.querySelectorAll('[data-logged-batch]')).toHaveLength(1);
  });
});

describe('the order book', () => {
  beforeEach(async () => {
    await clear();
    signInForTests('owner');
    window.location.hash = '#/jobs';
  });

  it('keeps every line whatever the tick says, marks the one outside, and still counts the money', async () => {
    await seed(shop());
    const view = await open(<FutureJobs />);

    expect(rows(view.host)).toHaveLength(2);
    expect(cellOf(view, 'SO-1', 'Ours?')).toBe('ours');
    expect(cellOf(view, 'SO-2', 'Ours?')).toBe('not current');
    // 240 short on GL4 and 500 on OLD: the unticked code's money is still in the
    // footer, because a line the shop has sold is owed whether or not the code is
    // ticked. This is the figure that would go missing if the rule leaked here.
    expect(totalOf(view, 'Still needed')).toContain('740');
    expect(says(view)).toContain('2 still owed'); // the chip counts lines, not litres
    expect(view.host.querySelector('[data-jobs-offrange]')?.textContent).toContain('1 of these 2 lines');
  });

  it('says it in the panel too, without touching the figures under it', async () => {
    await seed(shop());
    const view = await open(<FutureJobs />);
    const row = rows(view.host).find((r) => (r.textContent ?? '').includes('SO-2'));
    if (!row) throw new Error('the unticked line is not on the book');
    click(row);
    await settle();

    const panel = view.host.querySelector('[data-jobs-detail]');
    expect(panel?.textContent).toContain('is not in the current range');
    expect(panel?.textContent).toContain('Stock on hand');
    // 400 m² of it is standing on a shelf whether or not the code is ticked.
    expect(panel?.textContent).toContain('400.00 m²');
  });

  it('tells a code we have unticked apart from a code it has never seen', async () => {
    await seed({
      products: [product('GL4'), product('OLD', { enabled: false })],
      jobs: [job('SO-1', 'GL4', { qty: 2 }), job('SO-2', 'OLD', { qty: 2 }), job('SO-3', 'ZZ9', { qty: 3 })],
    });
    const view = await open(<FutureJobs />);

    expect(cellOf(view, 'SO-1', 'Ours?')).toBe('ours');
    expect(cellOf(view, 'SO-2', 'Ours?')).toBe('not current');
    expect(cellOf(view, 'SO-3', 'Ours?')).toBe('not ours');
    expect(view.host.querySelector('[data-jobs-offrange]')?.textContent).toContain('2 of these 3 lines');
  });
});

describe('the racks', () => {
  beforeEach(async () => {
    await clear();
    signInForTests('maker');
    window.location.hash = '#/curing';
  });

  it('does not un-make a rack because its code came off the range', async () => {
    await seed({
      products: [product('GL4'), product('OLD', { enabled: false })],
      batches: [rack({ code: 'OLD' })],
    });
    const view = await open(<Curing />);

    // Work already made is not a plan. The tick reaches the boards; it does not reach
    // behind it into the racks, the log, or the queue that keys it into MYOB.
    expect(view.host.querySelectorAll('[data-curing-rack]')).toHaveLength(1);
    // And it still reads with its description, because the lookup is the whole range.
    expect(says(view)).toContain('OLD limestone');
  });
});
