// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { dayStart } from '@/core/dates';
import type { Batch, JobsSnapshot, JobRow, Product, StockRow, StockSnapshot } from '@/core/types';
import { db, replaceJobsSnapshot, replaceStockSnapshot } from '@/data/db';
import { FutureJobs } from '@/screens/FutureJobs';
import { setMediaWidth } from './setup';
import { signInForTests } from './support/who';
import { buttonNamed, click, render, rows, settle, typeInto, type Rendered } from './support/render';

/**
 * The order book on screen.
 *
 * Who the stock belongs to, and what counts as late, are tested in
 * `test/core.jobsBoard.test.ts`. What is tested here is the part only a screen can
 * get wrong: that the counts on the chips are the counts in the rows, that a filter
 * says how much it hid, that pressing a line really does explain where its cover
 * came from, and that a device which has never had the export says so plainly
 * instead of showing a table with nothing in it.
 */

const DAY = 86_400_000;
const TODAY = dayStart(Date.now());
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
    target: 0,
    cureDays: 2,
    notes: '',
    rank: 1000,
    seenInJobs: true,
    updatedAt: Date.now(),
    ...over,
  };
}

function job(orderNo: string, over: Partial<JobRow> = {}): JobRow {
  return {
    id: `GL4|${orderNo}`,
    itemCode: 'GL4',
    itemDescription: 'GL4 limestone',
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
  return {
    id: over.id ?? 'b-1',
    batchNo: '2026-09-14-01',
    code: 'GL4',
    lineId: 'line-1',
    trays: 3,
    qty: 6,
    qtyOverridden: false,
    routeSnapshot: 'manufacture',
    stage: 'curing',
    madeAt: TODAY - 2 * DAY,
    cureDaysSnapshot: 2,
    cureDueAt: TODAY,
    blastedQty: 0,
    blastedAt: null,
    myobRunDate: null,
    enteredAt: null,
    enteredRef: '',
    operator: 'Test Person',
    note: '',
    rank: 1000,
    parentBatchId: null,
    updatedAt: Date.now(),
    ...over,
  };
}

async function seed(options: {
  jobs?: JobRow[];
  products?: Product[];
  stock?: StockRow[];
  batches?: Batch[];
}): Promise<void> {
  await Promise.all([
    db.jobsSnapshots.clear(),
    db.jobRows.clear(),
    db.stockSnapshots.clear(),
    db.stockRows.clear(),
    db.products.clear(),
    db.batches.clear(),
    db.events.clear(),
  ]);
  if (options.products) await db.products.bulkAdd(options.products);
  if (options.batches) await db.batches.bulkAdd(options.batches);
  if (options.stock) {
    const capture: StockSnapshot = {
      id: 'stock-1',
      capturedAt: TODAY - DAY,
      source: 'location.xlsx',
      rows: options.stock,
      diagnostics: {
        sheetName: 'Item List',
        reportTitle: 'Item List [Summary]',
        headerRow: 4,
        rowsRead: options.stock.length,
        rowsUsed: options.stock.length,
        totalRowsSkipped: 0,
        groupRowsSkipped: 0,
        unparsed: [],
      },
    };
    await replaceStockSnapshot(capture);
  }
  if (options.jobs) {
    const capture: JobsSnapshot = {
      id: 'jobs-1',
      capturedAt: Date.now() - 2 * 3_600_000,
      source: 'future.xlsx',
      periodFrom: TODAY - 200 * DAY,
      periodTo: TODAY,
      rows: options.jobs,
      diagnostics: {
        sheetName: 'Sales',
        reportTitle: 'Sales [Item Detail]',
        headerRow: 5,
        rowsRead: options.jobs.length,
        rowsUsed: options.jobs.length,
        totalRowsSkipped: 0,
        groupRowsSkipped: 0,
        unparsed: [],
      },
    };
    await replaceJobsSnapshot(capture);
  }
}

async function open(options: Parameters<typeof seed>[0]): Promise<Rendered> {
  signInForTests('owner');
  window.location.hash = '#/jobs';
  await seed(options);
  const view = render(<FutureJobs />);
  await settle();
  return view;
}

function says(view: Rendered): string {
  return view.host.textContent ?? '';
}

function pressSelector(view: Rendered, selector: string): void {
  const node = view.host.querySelector<HTMLButtonElement>(selector);
  if (!node) throw new Error(`no button matching ${selector}`);
  click(node);
}

/**
 * Rows are read through the headings rather than a fixed column number, so a column
 * that moves or is hidden by a saved view fails the test instead of passing it.
 */
function columnIndexOf(view: Rendered, heading: string): number {
  const heads = [...view.host.querySelectorAll<HTMLElement>('.dt-head [role="columnheader"]')];
  const index = heads.findIndex((head) => (head.textContent ?? '').startsWith(heading));
  if (index < 0) throw new Error(`no column headed ${heading}. ${heads.map((h) => h.textContent).join('|')}`);
  return index;
}

function rowFor(view: Rendered, orderNo: string): HTMLElement {
  const row = rows(view.host).find((r) => (r.textContent ?? '').includes(orderNo));
  if (!row) throw new Error(`no row for ${orderNo}. ${rowNames(view).join(' / ')}`);
  return row;
}

function cellOf(view: Rendered, orderNo: string, heading: string): string {
  const index = columnIndexOf(view, heading);
  return rowFor(view, orderNo).querySelectorAll('.dt-cell')[index]?.textContent?.trim() ?? '';
}

function rowNames(view: Rendered): string[] {
  return rows(view.host).map((row) => (row.textContent ?? '').slice(0, 60));
}

function rowCount(view: Rendered): number {
  return rows(view.host).length;
}

beforeEach(() => {
  setMediaWidth(null);
  window.location.hash = '';
});

describe('the order book on screen', () => {
  it('names the book before anybody reads a line', async () => {
    const view = await open({
      products: [product('GL4'), product('B2')],
      jobs: [
        job('SO-1', { promisedDate: promisedOn(2) }),
        job('SO-2', { customer: 'Devonport', promisedDate: promisedOn(6) }),
        job('SO-3', { itemCode: 'B2', id: 'B2|SO-3', promisedDate: promisedOn(9) }),
      ],
    });

    expect(says(view)).toContain('3 open lines');
    expect(says(view)).toContain('2 codes');
    expect(says(view)).toContain('2 customers');
    expect(says(view)).toContain('2 h ago');
    // Nothing has been imported as stock, so every line is still owed.
    expect(says(view)).toContain('3 still owed');
    expect(rowCount(view)).toBe(3);
  });

  it('says so plainly when the export has never been read on this device', async () => {
    const view = await open({ products: [product('GL4')] });

    expect(says(view)).toContain('No future jobs on this device');
    expect(says(view)).toContain('Sales [Item Detail]');
    expect(says(view)).not.toContain('is not wired up yet');
    click(buttonNamed(view.host, 'Data sources'));
    await settle();
    expect(window.location.hash).toBe('#/sources');
  });

  it('gives the pallet to the earliest promise and says what is left', async () => {
    const view = await open({
      products: [product('GL4')],
      stock: [stockRow('GL4', 10)],
      // The export offers the later promise first; the screen must not follow it.
      jobs: [job('SO-LATER', { promisedDate: promisedOn(9), qty: 5 }), job('SO-EARLY', { promisedDate: promisedOn(2), qty: 8 })],
    });

    expect(cellOf(view, 'SO-EARLY', 'Covered')).toBe('8.00');
    expect(cellOf(view, 'SO-EARLY', 'Still needed')).toBe('0.00');
    expect(cellOf(view, 'SO-LATER', 'Covered')).toBe('2.00');
    expect(cellOf(view, 'SO-LATER', 'Still needed')).toBe('3.00');
    // The pool belongs to the code, so it reads the same on both lines.
    expect(cellOf(view, 'SO-EARLY', 'Whole shop')).toBe('10.00');
    expect(cellOf(view, 'SO-LATER', 'Whole shop')).toBe('10.00');
    expect(says(view)).toContain('1 still owed');
  });

  it('counts a late line and lets you see only the late ones', async () => {
    const view = await open({
      products: [product('GL4')],
      jobs: [job('SO-EARLY', { promisedDate: promisedOn(2) }), job('SO-LATE', { promisedDate: promisedOn(-4) })],
    });

    expect(says(view)).toContain('1 line late');
    const pastChip = view.host.querySelector<HTMLButtonElement>('[data-jobs-window="past"]');
    expect(pastChip?.textContent).toContain('1');
    click(pastChip!);
    await settle();
    expect(rowCount(view)).toBe(1);
    expect(rowNames(view).join(' ')).toContain('SO-LATE');
    expect(says(view)).toContain('1 of 2 lines');
  });

  it('holds the undated lines out, counts them, and shows them when asked', async () => {
    const view = await open({
      products: [product('GL4')],
      jobs: [job('SO-REAL', { promisedDate: promisedOn(3) }), job('SO-NODATE', { promisedDate: new Date(2040, 3, 4, 12).getTime() })],
    });

    expect(rowCount(view)).toBe(1);
    const chip = view.host.querySelector<HTMLButtonElement>('[data-jobs-far-future]');
    expect(chip?.textContent).toContain('1');

    click(chip!);
    await settle();
    expect(rowCount(view)).toBe(2);
    expect(says(view)).toContain('Undated lines are shown');
    // An undated line is never "late", whatever the date says.
    expect(says(view)).not.toContain('day late');
  });

  it('says how much a filter took out', async () => {
    const view = await open({
      products: [product('GL4')],
      jobs: [job('SO-1', { customer: 'Bunnings' }), job('SO-2', { customer: 'Devonport' }), job('SO-3', { customer: 'Bunnings' })],
    });

    const search = view.host.querySelector<HTMLInputElement>('[data-jobs-search]')!;
    typeInto(search, 'devon');
    await settle();
    expect(rowCount(view)).toBe(1);
    expect(rowNames(view).join(' ')).toContain('SO-2');
    expect(says(view)).toContain('1 of 3 lines');

    typeInto(search, 'nothing like this');
    await settle();
    expect(says(view)).toContain('No line matches');
    expect(says(view)).toContain('nothing like this');

    pressSelector(view, '[data-jobs-clear]');
    await settle();
    expect(rowCount(view)).toBe(3);
    expect(view.host.querySelector('[data-jobs-filtered]')).toBeNull();
  });

  it('shows only what is still owed when asked', async () => {
    const view = await open({
      products: [product('GL4')],
      stock: [stockRow('GL4', 10)],
      jobs: [job('SO-COVERED', { promisedDate: promisedOn(1), qty: 8 }), job('SO-OWED', { promisedDate: promisedOn(3), qty: 8 })],
    });

    expect(rowCount(view)).toBe(2);
    pressSelector(view, '[data-jobs-short-only]');
    await settle();
    expect(rowCount(view)).toBe(1);
    expect(rowNames(view).join(' ')).toContain('SO-OWED');
  });

  it('explains a line when you press it, in things you can go and look at', async () => {
    const view = await open({
      products: [product('GL4')],
      stock: [stockRow('GL4', 4)],
      batches: [rack({ stage: 'curing', qty: 6 })],
      jobs: [job('SO-1', { promisedDate: promisedOn(2), qty: 20 })],
    });

    click(rowFor(view, 'SO-1'));
    await settle();

    const detail = view.host.querySelector('[data-jobs-detail]');
    expect(detail).not.toBeNull();
    const text = detail?.textContent ?? '';
    expect(text).toContain('Stock on hand');
    expect(text).toContain('On the racks');
    expect(text).toContain('Whole shop');
    expect(text).toContain('10.00 m²'); // 4 on the shelf plus 6 on the racks
    expect(text).toContain('in 2 days');
    // The customer's name is in the body in full, not only in a heading that truncates.
    expect(detail?.querySelector('[data-jobs-detail-when]')?.textContent).toContain('Bunnings was promised');

    click(buttonNamed(view.host, 'Close'));
    await settle();
    expect(view.host.querySelector('[data-jobs-detail]')).toBeNull();
  });

  it('says a code is not one of ours instead of making a figure up for it', async () => {
    const view = await open({
      products: [product('GL4')],
      stock: [stockRow('ZZ9', 40)],
      jobs: [job('SO-IMPORTED', { id: 'ZZ9|SO-IMPORTED', itemCode: 'ZZ9', qty: 6 })],
    });

    expect(cellOf(view, 'SO-IMPORTED', 'Ours?')).toBe('not ours');
    click(rowFor(view, 'SO-IMPORTED'));
    await settle();
    expect(says(view)).toContain('is not a product on this device');
    expect(says(view)).toContain('ZZ9');
  });

  it('counts the late lines that the production board starts after', async () => {
    // A job promised last month is not on the Matrix, and the shop still owes it.
    const view = await open({
      products: [product('GL4')],
      jobs: [job('SO-OLD', { promisedDate: promisedOn(-30), qty: 12 })],
    });

    expect(says(view)).toContain('1 open line');
    expect(cellOf(view, 'SO-OLD', 'Days to go')).toBe('-30');
    expect(says(view)).toContain('12.00');
  });

  it('is still the order book at phone width', async () => {
    setMediaWidth(390);
    const view = await open({
      products: [product('GL4')],
      stock: [stockRow('GL4', 10)],
      jobs: [job('SO-EARLY', { promisedDate: promisedOn(2) }), job('SO-LATE', { promisedDate: promisedOn(-1) })],
    });

    expect(says(view)).toContain('The order book');
    expect(rowCount(view)).toBe(2);
    // Every filter is still a button a thumb can hit.
    expect(view.host.querySelectorAll('[data-jobs-window]').length).toBe(4);
    expect(view.host.querySelector('[data-jobs-search]')).not.toBeNull();
    pressSelector(view, '[data-jobs-window="fortnight"]');
    await settle();
    expect(rowCount(view)).toBe(1);
  });
});
