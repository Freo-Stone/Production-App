// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dayStart } from '@/core/dates';
import type { JobsSnapshot, JobRow, Product, StockRow, StockSnapshot } from '@/core/types';
import { db, replaceJobsSnapshot, replaceStockSnapshot } from '@/data/db';
import { addPlanItem } from '@/data/planRepo';
import { Schedule } from '@/screens/Schedule';
import { setMediaWidth } from './setup';
import { signInForTests } from './support/who';
import {
  buttonNamed,
  click,
  render,
  rows,
  settle,
  typeInto,
  type Rendered,
} from './support/render';

/**
 * The plan on screen.
 *
 * Which promise a make answers, and what day it had best have started, are tested in
 * `test/core.schedule.test.ts`. What is tested here is what only a screen can get
 * wrong: that the counts on the chips are the counts in the rows, that pressing a row
 * explains the date in plain words, that the button on the bottom of that card really
 * writes the plan line through the same writer everybody else uses, and that a row
 * nothing has been planned for can be told apart from one the shop has already
 * written down — at a glance, without reading the small print.
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

interface Seed {
  jobs?: JobRow[];
  products?: Product[];
  stock?: StockRow[];
}

async function seed(options: Seed): Promise<void> {
  await Promise.all([
    db.jobsSnapshots.clear(),
    db.jobRows.clear(),
    db.stockSnapshots.clear(),
    db.stockRows.clear(),
    db.products.clear(),
    db.batches.clear(),
    db.planItems.clear(),
    db.events.clear(),
  ]);
  if (options.products) await db.products.bulkAdd(options.products);
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

async function open(options: Seed): Promise<Rendered> {
  signInForTests('owner');
  window.location.hash = '#/schedule';
  await seed(options);
  const view = mount(<Schedule />);
  await settle();
  return view;
}

/**
 * A write goes through IndexedDB and then back out through a live query, so both the
 * database and the screen have to be caught up before an assertion reads them.
 */
async function until<T>(what: () => Promise<T>, describe: string): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await what();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${describe}`);
}

function says(view: Rendered): string {
  return view.host.textContent ?? '';
}

function rowCount(view: Rendered): number {
  return rows(view.host).length;
}

function rowTexts(view: Rendered): string[] {
  return rows(view.host).map((row) => (row.textContent ?? '').replace(/\s+/g, ' ').trim());
}

/** The row for an item code, or the nth one when several codes are the same. */
function rowFor(view: Rendered, needle: string): HTMLElement {
  const row = rows(view.host).find((r) => (r.textContent ?? '').includes(needle));
  if (!row) throw new Error(`no row containing "${needle}". ${rowTexts(view).join(' / ')}`);
  return row;
}

function detailCard(view: Rendered): Element | null {
  return view.host.querySelector('[data-schedule-detail]');
}

function dialog(): HTMLElement {
  const panel = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!panel) throw new Error('no dialog open');
  return panel;
}

function chipNumber(view: Rendered, marker: string): number {
  const chip = view.host.querySelector<HTMLButtonElement>(`[data-schedule-bucket="${marker}"]`);
  if (!chip) throw new Error(`no bucket chip ${marker}`);
  const digits = (chip.textContent ?? '').replace(/\D/g, '');
  return Number(digits);
}

function pressChip(view: Rendered, marker: string): void {
  const chip = view.host.querySelector<HTMLButtonElement>(`[data-schedule-bucket="${marker}"]`);
  if (!chip) throw new Error(`no bucket chip ${marker}`);
  click(chip);
}

/**
 * Views are torn down between tests rather than left mounted. A screen that still
 * owns a dialog portal while the next test runs leaves Framer Motion reaching for a
 * node that is no longer in the document, and the failure has nothing to do with the
 * test that trips it.
 */
const mounted: Rendered[] = [];

function mount(node: ReactNode): Rendered {
  const view = render(node);
  mounted.push(view);
  return view;
}

beforeEach(() => {
  setMediaWidth(null);
  window.location.hash = '';
});

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.unmount();
});

describe('the plan before anybody touches it', () => {
  it('names what has to be made, and how much of it nobody has planned', async () => {
    const view = await open({
      products: [product('GL4'), product('B2')],
      jobs: [
        job('SO-1', { promisedDate: promisedOn(1), qty: 4 }),
        job('SO-2', { promisedDate: promisedOn(4), qty: 8 }),
        job('SO-3', { itemCode: 'B2', id: 'B2|SO-3', promisedDate: promisedOn(20), qty: 3 }),
      ],
    });

    expect(says(view)).toContain('3 rows');
    expect(says(view)).toContain('2 codes');
    expect(says(view)).toContain('3 promises not planned');
    expect(says(view)).toContain('order book read 2 h ago');
    expect(says(view)).toContain('1 is already behind');
    expect(says(view)).toContain('3 have nothing planned');
    expect(rowCount(view)).toBe(3);
    // The build order, not the export order: behind first, and it says so in numbers.
    expect(rowTexts(view)[0]).toContain('-1');
    expect(says(view)).not.toContain('is not wired up yet');
  });

  it('puts the row a person has to act on at the top, in red', async () => {
    const view = await open({
      products: [product('GL4')],
      jobs: [
        job('SO-LATER', { promisedDate: promisedOn(20), qty: 30 }),
        job('SO-BEHIND', { promisedDate: promisedOn(1), qty: 4 }),
      ],
    });
    const behind = rows(view.host)[0];
    // The tone is painted on the cell's inner span, and both date columns say it.
    const red = [...(behind?.querySelectorAll<HTMLSpanElement>('.dt-cell span[class*="text-short"]') ?? [])].map(
      (span) => span.textContent ?? '',
    );
    expect(red).toContain('-1');
    expect(red.length).toBeGreaterThanOrEqual(2);
    expect(behind?.querySelector('.dt-cell[data-col="status"]')?.textContent).toContain('not yet');
  });

  it('says so when there is nothing to make', async () => {
    const view = await open({
      products: [product('GL4')],
      jobs: [job('SO-1', { promisedDate: promisedOn(4), qty: 8 })],
      stock: [stockRow('GL4', 40)],
    });

    expect(rowCount(view)).toBe(0);
    expect(says(view)).toContain('Nothing has to be made');
    expect(says(view)).toContain('covered by stock or by work already on the racks');
  });

  it('tells an unused device where to start', async () => {
    const view = await open({ products: [product('GL4')] });
    expect(says(view)).toContain('No promises to plan against');
    expect(says(view)).toContain('Data sources');
  });
});

describe('pressing a row', () => {
  it('explains the start date in words, and how the lead time is made', async () => {
    const view = await open({
      products: [product('GL4', { cureDays: 3 })],
      jobs: [job('SO-1', { promisedDate: promisedOn(4), qty: 8 })],
    });
    click(rowFor(view, 'GL4'));
    await settle();

    const card = detailCard(view);
    expect(card?.textContent).toContain('has to have started by');
    expect(card?.textContent).toContain('to be ready for');
    expect(card?.querySelector('[data-schedule-detail-lead]')?.textContent).toContain('Lead time 3 days');
    expect(card?.querySelector('[data-schedule-detail-lead]')?.textContent).toContain('no blasting day');
    expect(card?.querySelector('[data-schedule-detail-lead]')?.textContent).toContain('It is made on the line.');
    // The order it answers, named.
    expect(card?.querySelector('[data-schedule-detail-lines]')?.textContent).toContain('SO-1');
    expect(card?.querySelector('[data-schedule-detail-lines]')?.textContent).toContain('Bunnings');
  });

  it('only talks about trays when the yield is one the shop set', async () => {
    const withYield = await open({
      products: [product('GL4', { trayYield: 2 })],
      jobs: [job('SO-1', { promisedDate: promisedOn(4), qty: 8 })],
    });
    click(rowFor(withYield, 'GL4'));
    await settle();
    expect(detailCard(withYield)?.querySelector('[data-schedule-detail-trays]')?.textContent).toContain('about 4 trays');

    // An imported item arrives with a yield of 1, which is a gap in the data, not a
    // fact about the shop's trays. Saying "8 trays" off that would be made up.
    const placeholder = await open({
      products: [product('GL4', { trayYield: 1 })],
      jobs: [job('SO-1', { promisedDate: promisedOn(4), qty: 8 })],
    });
    click(rowFor(placeholder, 'GL4'));
    await settle();
    expect(detailCard(placeholder)?.querySelector('[data-schedule-detail-trays]')).toBeNull();
  });

  it('says when the day has already gone', async () => {
    const view = await open({
      products: [product('GL4')],
      jobs: [job('SO-1', { promisedDate: promisedOn(1), qty: 4 })],
    });
    click(rowFor(view, 'GL4'));
    await settle();
    expect(detailCard(view)?.textContent).toContain('ago');
  });

  // Rewritten 2026-09-19 for the current-range rule, and the rewrite is disclosed
  // rather than slipped through: this test used to click a row for `ZZ9` — a code this
  // device has never seen — and read its start date off it. A code outside the range
  // is not a make the shop has decided to make, so it is no longer a row at all, and
  // an assertion about a row that cannot exist is not a test of anything. The two
  // halves below keep both decisions honest: the row that is gone stays counted, and
  // the row that stays (a code we make, with no route chosen) still explains itself.
  it('keeps a code outside the range off the plan, and says how many it left out', async () => {
    const view = await open({
      products: [product('GL4')],
      jobs: [
        job('SO-9', { itemCode: 'ZZ9', id: 'ZZ9|SO-9', promisedDate: promisedOn(4), qty: 6 }),
        job('SO-10', { promisedDate: promisedOn(4), qty: 8 }),
      ],
    });

    // The short promise the shop does not make is not a row, and cannot be pressed.
    expect(rowTexts(view).join(' / ')).not.toContain('ZZ9');
    expect(rowCount(view)).toBe(1);
    // It is not quietly missing either: the screen counts it and points at the book.
    expect(view.host.querySelector('[data-schedule-offrange]')?.textContent).toContain('1 row');
    expect(view.host.querySelector('[data-schedule-offrange]')?.textContent).toContain('order book');
  });

  it('says plainly when a plan line has no date to work from', async () => {
    await seed({
      // Stock enough to cover the promise, so the only row on the plan is the line.
      products: [product('GL4')],
      stock: [stockRow('GL4', 100)],
      jobs: [job('SO-11', { promisedDate: promisedOn(4), qty: 8 })],
    });
    signInForTests('owner');
    // A make the shop wrote down for no particular promise: nothing to date a lead
    // time backwards from, which is the one way a row of a code we do make can end up
    // undated now that a code outside the range is off the plan altogether.
    await addPlanItem({ code: 'GL4', qty: 6, promisedFor: null });

    const view = mount(<Schedule />);
    await settle();
    expect(chipNumber(view, 'undated')).toBe(1);

    click(rowFor(view, 'GL4'));
    await settle();
    const card = detailCard(view);
    expect(card?.textContent).toContain('There is no start date for GL4 to work from');
    // It cannot be "put on the plan" again — it is already there.
    expect(card?.querySelector('[data-schedule-add]')).toBeNull();
  });
});

describe('writing the plan down', () => {
  it('puts a short row on the plan through the real writer', async () => {
    const view = await open({
      products: [product('GL4')],
      jobs: [job('SO-1', { promisedDate: promisedOn(4), qty: 8 })],
    });
    click(rowFor(view, 'GL4'));
    await settle();

    click(buttonNamed(view.host, 'Put 8.00 m² on the plan'));
    await until(() => db.planItems.count().then((n) => n === 1), 'the plan line to be written');
    await settle();

    const [item] = await db.planItems.toArray();
    expect(item?.code).toBe('GL4');
    expect(item?.qty).toBe(8);
    expect(item?.linkedJobIds).toEqual(['GL4|SO-1']);
    expect(item?.latestStartDate).toBe(dayStart(promisedOn(2)));

    // The gap row it was standing for has become a plan line, and the chips moved.
    expect(rowCount(view)).toBe(1);
    expect(chipNumber(view, 'week')).toBe(1);
    expect(chipNumber(view, 'behind')).toBe(0);
    expect(rowFor(view, 'planned').textContent).toContain('SO-1'.replace('SO-1', 'GL4'));
    expect(says(view)).not.toContain('have nothing planned');
    const lines = await db.events.toArray();
    expect(lines.filter((e) => e.action === 'plan.add')).toHaveLength(1);
    expect(lines[0]?.detail).toContain('put on the plan');
  });

  it('shows a plan line the shop wrote, and says what it answers', async () => {
    await seed({
      products: [product('GL4')],
      jobs: [job('SO-1', { promisedDate: promisedOn(4), qty: 8 })],
    });
    signInForTests('owner');
    await addPlanItem({ code: 'GL4', qty: 8, promisedFor: promisedOn(4), linkedJobIds: ['GL4|SO-1'] });

    const view = mount(<Schedule />);
    await settle();

    expect(says(view)).toContain('1 row');
    expect(says(view)).toContain('nothing left unplanned'); // it is covered now
    const row = rowFor(view, 'planned');
    expect(row.textContent).toContain('Covers 1 line on the book');
    // Nothing is left standing as a gap, so the plan has one row and no promises waiting.
    expect(rowTexts(view).filter((t) => t.includes('not yet'))).toHaveLength(0);
  });

  it('marks a plan line started, and moves it out of the pile it was in', async () => {
    await seed({
      products: [product('GL4')],
      jobs: [job('SO-1', { promisedDate: promisedOn(4), qty: 8 })],
    });
    signInForTests('owner');
    const item = await addPlanItem({ code: 'GL4', qty: 8, promisedFor: promisedOn(4) });

    const view = mount(<Schedule />);
    await settle();
    expect(chipNumber(view, 'making')).toBe(0);

    click(rowFor(view, 'planned'));
    await settle();
    click(buttonNamed(view.host, 'Started making it'));
    await until(() => db.planItems.get(item.id).then((i) => i?.status === 'started'), 'the line to be started');
    await settle();

    expect(chipNumber(view, 'making')).toBe(1);
    expect(chipNumber(view, 'week')).toBe(0);
    expect(rowFor(view, 'being made').textContent).toContain('Being made');
  });

  it('wants a reason before it takes a line off the plan', async () => {
    await seed({
      products: [product('GL4')],
      jobs: [job('SO-1', { promisedDate: promisedOn(4), qty: 8 })],
    });
    signInForTests('owner');
    const item = await addPlanItem({ code: 'GL4', qty: 8, promisedFor: promisedOn(4) });

    const view = mount(<Schedule />);
    await settle();
    click(rowFor(view, 'planned'));
    await settle();
    click(buttonNamed(view.host, 'Take it off the plan'));

    const panel = dialog();
    expect(panel.textContent).toContain('Take GL4 off the plan');
    const confirm = [...panel.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      (b.textContent ?? '').includes('Take it off'),
    );
    expect(confirm?.disabled).toBe(true);

    typeInto(panel.querySelector('input') as Element, 'Customer took the order back');
    expect(confirm?.disabled).toBe(false);
    click(confirm as HTMLButtonElement);
    await until(() => db.planItems.get(item.id).then((i) => i?.status === 'cancelled'), 'the line to come off');
    await settle();

    // The promise is short again, so the row comes back as a gap — taking a line off
    // the plan uncovers what it was standing for, it does not make the order go away.
    expect(rowCount(view)).toBe(1);
    expect(rowTexts(view)[0]).toContain('not yet');
    expect(says(view)).toContain('1 promise not planned');
    // Ledger ids are random, so the lines are found by what they are, not by order.
    const lines = await db.events.toArray();
    expect(lines.filter((e) => e.action === 'plan.add')).toHaveLength(1);
    const cancel = lines.find((e) => e.action === 'plan.cancel');
    expect(cancel?.detail).toContain('Customer took the order back');
    expect(cancel?.code).toBe('GL4');
  });

  it('will not let a read-only sign-in write the plan', async () => {
    await seed({
      products: [product('GL4')],
      jobs: [job('SO-1', { promisedDate: promisedOn(4), qty: 8 })],
    });
    signInForTests('viewer');
    window.location.hash = '#/schedule';
    const view = mount(<Schedule />);
    await settle();

    click(rowFor(view, 'GL4'));
    await settle();
    expect(detailCard(view)?.textContent).toContain('takes a maker or owner sign-in');
    expect(detailCard(view)?.querySelector('[data-schedule-add]')).toBeNull();
    expect(await db.planItems.count()).toBe(0);
  });
});

describe('the chips and the filters', () => {
  const mixed = () => ({
    products: [product('GL4'), product('B2')],
    jobs: [
      job('SO-1', { promisedDate: promisedOn(1), qty: 4 }),
      job('SO-2', { promisedDate: promisedOn(4), qty: 8 }),
      job('SO-3', { itemCode: 'B2', id: 'B2|SO-3', promisedDate: promisedOn(20), qty: 3 }),
      // A promise for a code outside the current range. It is on the order book and
      // not on the plan, so every count in this block is three rows and one left out.
      job('SO-4', { itemCode: 'ZZ9', id: 'ZZ9|SO-4', promisedDate: promisedOn(5), qty: 2 }),
    ],
  });

  it('shows exactly what each chip says it will', async () => {
    const view = await open(mixed());
    const expected = {
      all: rowCount(view),
      behind: chipNumber(view, 'behind'),
      week: chipNumber(view, 'week'),
      later: chipNumber(view, 'later'),
      undated: chipNumber(view, 'undated'),
    };
    expect(expected.all).toBe(3);
    expect(view.host.querySelector('[data-schedule-offrange]')?.textContent).toContain('1 row');

    for (const bucket of ['behind', 'week', 'later', 'undated'] as const) {
      pressChip(view, bucket);
      await settle();
      expect(rowCount(view), bucket).toBe(expected[bucket]);
      pressChip(view, 'all');
      await settle();
    }
  });

  it('leaves only what nobody has planned, once asked', async () => {
    await seed(mixed());
    signInForTests('owner');
    await addPlanItem({ code: 'GL4', qty: 4, promisedFor: promisedOn(1) });

    const view = mount(<Schedule />);
    await settle();
    // Three promises short, one of them now planned: the plan line plus two gaps. The
    // fourth promise the fixture holds is for a code outside the range and is not on
    // the plan at all — see `mixed()` above.
    expect(rowCount(view)).toBe(3);

    click(buttonNamed(view.host, 'Nobody has planned it'));
    await settle();
    expect(rowCount(view)).toBe(2);
    expect(rowTexts(view).every((t) => t.includes('not yet'))).toBe(true);
    expect(says(view)).toContain('2 of 3 rows');
  });

  it('says how much a search took out', async () => {
    const view = await open(mixed());
    typeInto(view.host.querySelector('[data-schedule-search]') as Element, 'B2');
    await settle();

    expect(rowCount(view)).toBe(1);
    expect(view.host.querySelector('[data-schedule-filtered]')?.textContent).toContain('1 of 3 rows');
    expect(says(view)).toContain('B2');

    typeInto(view.host.querySelector('[data-schedule-search]') as Element, 'nothing like this');
    await settle();
    expect(says(view)).toContain('Nothing on the plan matches');
  });

  it('clears itself', async () => {
    const view = await open(mixed());
    pressChip(view, 'behind');
    await settle();
    expect(rowCount(view)).toBe(1);

    click(buttonNamed(view.host, 'Clear'));
    await settle();
    expect(rowCount(view)).toBe(3);
    expect(view.host.querySelector('[data-schedule-filtered]')).toBeNull();
  });
});
