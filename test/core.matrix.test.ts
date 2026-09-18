import { describe, expect, it } from 'vitest';
import {
  cellLines,
  HORIZONS,
  isHorizon,
  matrixDays,
  matrixRows,
  type MatrixRow,
} from '@/core/matrix';
import { DEFAULT_SETTINGS } from '@/core/defaults';
import { addDays, dayStart } from '@/core/dates';
import type { Batch, JobRow, Product, Settings, StockRow } from '@/core/types';

/**
 * The board's arithmetic.
 *
 * The one that matters most is the one that looks like a bug if you have not read
 * the sheet: MYOB's Units On Hand is *already* net of the open jobs, so a day cell
 * must not subtract its demand from stock again. Tests here pin both halves of
 * that — the figure in a cell, and the fact that adding a job never moves the
 * stock figure by a unit.
 */

// A Thursday, deliberately: seven days from here crosses a weekend, so the
// weekend flags and the day labels are exercised by the same fixture.
const NOW = new Date(2026, 8, 17, 9, 0, 0).getTime();

function settings(over: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...over };
}

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
    rank: 1000,
    seenInJobs: false,
    updatedAt: 1,
    ...over,
  };
}

function stock(code: string, qty: number, location = 'HQ'): StockRow {
  return { code, location, qtyOnHandRaw: qty, category: 'Paving' };
}

function job(code: string, qty: number, promised: number, over: Partial<JobRow> = {}): JobRow {
  return {
    id: `${code}|${over.orderNo ?? 'SO-1'}|${qty}|${promised}`,
    itemCode: code,
    itemDescription: `${code} paver`,
    customer: 'Test Customer',
    orderNo: over.orderNo ?? 'SO-1',
    orderDate: null,
    promisedDate: promised,
    qty,
    shipVia: over.shipVia ?? 'Pickup',
    salesperson: 'Test Person',
    rank: 1,
    ...over,
  };
}

function batch(code: string, over: Partial<Batch> = {}): Batch {
  const madeAt = NOW - 86_400_000;
  return {
    id: `b-${code}-${over.batchNo ?? '1'}`,
    batchNo: over.batchNo ?? '2026-09-16-01',
    code,
    lineId: 'line-1',
    trays: 10,
    qty: 10,
    qtyOverridden: false,
    routeSnapshot: 'manufacture',
    stage: 'curing',
    madeAt,
    cureDaysSnapshot: 2,
    cureDueAt: madeAt + 2 * 86_400_000,
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
    ...over,
  };
}

const DAYS = matrixDays(2, NOW);

function board(
  products: Product[],
  jobs: JobRow[],
  stockRows: StockRow[],
  batches: Batch[] = [],
  opts: { settings?: Settings; days?: typeof DAYS } = {},
): MatrixRow[] {
  return matrixRows({
    products,
    jobs,
    stockRows,
    batches,
    stockCapturedAt: NOW,
    settings: opts.settings ?? settings(),
    days: opts.days ?? DAYS,
    now: NOW,
  });
}

function only(rows: MatrixRow[], code: string): MatrixRow {
  const found = rows.find((r) => r.code === code);
  if (!found) throw new Error(`no row for ${code}`);
  return found;
}

describe('the horizon', () => {
  it('is one of four widths, every day of it', () => {
    expect(HORIZONS).toEqual([1, 2, 4, 6]);
    expect(isHorizon(4)).toBe(true);
    expect(isHorizon(3)).toBe(false);
    expect(isHorizon('4')).toBe(false);

    const oneWeek = matrixDays(1, NOW);
    expect(oneWeek).toHaveLength(7);
    expect(oneWeek.map((d) => d.weekend)).toEqual([false, false, true, true, false, false, false]);
    expect(oneWeek[0]).toEqual({ day: dayStart(NOW), weekend: false, today: true });

    // 17 Sep 2026 is a Thursday, so the third and fourth days of the window are
    // the weekend, and the columns either side of them are the working days.
  });
});

describe('a day cell', () => {
  it('holds what is promised that day, in the product’s unit', () => {
    const day3 = addDays(dayStart(NOW), 3);
    const rows = board(
      [product('A2')],
      [
        job('A2', 28.8, day3, { orderNo: 'SO-11' }),
        job('A2', 14.4, day3, { orderNo: 'SO-12' }),
        job('A2', 7, addDays(dayStart(NOW), 5), { orderNo: 'SO-13' }),
      ],
      [stock('A2', 50)],
    );

    const row = only(rows, 'A2');
    const cell = row.cells.get(day3);
    expect(cell).toMatchObject({ gross: 43.2, credits: 0, lines: 2 });
    expect(row.due).toBeCloseTo(50.2, 4);
  });

  it('folds a credit into the day it was raised, which can take it negative', () => {
    const day2 = addDays(dayStart(NOW), 2);
    const rows = board(
      [product('A2')],
      [
        job('A2', 10, day2, { orderNo: 'SO-21' }),
        job('A2', -4, day2, { orderNo: 'CR-1' }),
      ],
      [stock('A2', 10)],
    );

    const cell = only(rows, 'A2').cells.get(day2);
    expect(cell).toMatchObject({ gross: 10, credits: -4, lines: 2 });
    expect(only(rows, 'A2').due).toBeCloseTo(6, 4);
  });

  it('never touches the stock figure, because MYOB is already net of these jobs', () => {
    const day1 = addDays(dayStart(NOW), 1);
    const withoutJobs = board([product('A2', { target: 0 })], [], [stock('A2', 50)]);
    const withJobs = board([product('A2', { target: 0 })], [job('A2', 400, day1)], [stock('A2', 50)]);

    expect(only(withJobs, 'A2').stockReal).toBe(only(withoutJobs, 'A2').stockReal);
    expect(only(withJobs, 'A2').inclCuringBlasted).toBe(only(withoutJobs, 'A2').inclCuringBlasted);
    // And the demand is still visible where it belongs — a day column, once.
    expect(only(withJobs, 'A2').due).toBeCloseTo(400, 4);
    expect(only(withJobs, 'A2').beyond).toBe(0);
  });

  it('lists the same lines it added up, so a popup can never disagree with the cell', () => {
    const day4 = addDays(dayStart(NOW), 4);
    const jobs = [
      job('A2', 12, day4, { orderNo: 'SO-31' }),
      job('A2', 8, day4, { orderNo: 'SO-32' }),
      job('A2', 5, addDays(day4, 1), { orderNo: 'SO-33' }),
    ];
    const rows = board([product('A2')], jobs, [stock('A2', 50)]);
    const cell = only(rows, 'A2').cells.get(day4);
    const lines = cellLines(jobs, 'A2', day4, settings());

    expect(cell?.gross).toBeCloseTo(lines.reduce((t, l) => t + l.qty, 0), 4);
    expect(lines).toHaveLength(2);
    // Biggest first: the line worth a phone call is the one at the top.
    expect(lines[0]?.orderNo).toBe('SO-31');
  });
});

describe('the dates a board must not plan on', () => {
  const placeholder = new Date(2040, 3, 4).getTime();

  it('holds placeholder promised dates out of the cells and out of the overflow', () => {
    const rows = board(
      [product('A2')],
      [job('A2', 900, placeholder, { orderNo: 'SO-41' })],
      [stock('A2', 10)],
    );
    const row = only(rows, 'A2');
    expect(row.cells.size).toBe(0);
    expect(row.due).toBe(0);
    expect(row.beyond).toBe(0);
    expect(row.beyondLines).toBe(0);
  });

  it('counts real demand past the last column once, as the overflow', () => {
    const outside = addDays(dayStart(NOW), 30);
    const rows = board([product('A2')], [job('A2', 55, outside, { orderNo: 'SO-51' })], [stock('A2', 10)]);
    const row = only(rows, 'A2');
    expect(row.cells.size).toBe(0);
    expect(row.beyond).toBeCloseTo(55, 4);
    expect(row.beyondLines).toBe(1);
  });

  it('leaves out the ship-via values that are not demand', () => {
    const day1 = addDays(dayStart(NOW), 1);
    const s = settings({ sources: { ...DEFAULT_SETTINGS.sources, excludedShipVia: ['Freight'] } });
    const rows = board(
      [product('A2')],
      [job('A2', 500, day1, { orderNo: 'SO-61', shipVia: 'Freight' })],
      [stock('A2', 10)],
      [],
      { settings: s },
    );
    expect(only(rows, 'A2').cells.size).toBe(0);
    expect(cellLines([job('A2', 500, day1, { shipVia: 'Freight' })], 'A2', day1, s)).toHaveLength(0);
  });
});

describe('the colour of a row', () => {
  it('is red when nothing closes the gap, and green when the cure clock does', () => {
    const short = board([product('A2', { target: 100 })], [], [stock('A2', 60)]);
    expect(only(short, 'A2').tone).toBe('short');
    expect(only(short, 'A2').toGetToTarget).toBeCloseTo(40, 2);

    const coming = board(
      [product('A2', { target: 100 })],
      [],
      [stock('A2', 60)],
      [batch('A2', { qty: 40 })],
    );
    expect(only(coming, 'A2').tone).toBe('needsCuring');
    expect(only(coming, 'A2').toGetToTarget).toBe(0);

    const covered = board([product('A2', { target: 100 })], [], [stock('A2', 120)]);
    expect(only(covered, 'A2').tone).toBe('neutral');
  });

  it('never judges a product with no target, because there is nothing to be short of', () => {
    const rows = board([product('A2', { target: 0 })], [], [stock('A2', 1)]);
    expect(only(rows, 'A2').tone).toBe('neutral');
    expect(only(rows, 'A2').toGetToTarget).toBe(0);
  });

  it('says so when on-hand is below zero', () => {
    const rows = board([product('M6', { target: 200, usesBaseline10000: true })], [], [stock('M6', 9790.23)]);
    const row = only(rows, 'M6');
    expect(row.stockReal).toBeCloseTo(-209.77, 2);
    expect(row.oversold).toBe(true);
    expect(row.tone).toBe('short');
  });
});

describe('the dot that says too late', () => {
  it('appears once the last start date has passed', () => {
    // Cure 2 days + buffer 0: a promise today had its last start date 2 days ago.
    const rows = board([product('A2', { cureDays: 2 })], [job('A2', 10, dayStart(NOW), { orderNo: 'SO-71' })], [stock('A2', 0)]);
    expect(only(rows, 'A2').cells.get(dayStart(NOW))?.late).toBe(true);
  });

  it('stays off while there is still time to start', () => {
    // Ten days off, cure two: the make could start eight days from now. Inside the
    // two-week board, which is the only place a dot can be drawn at all.
    const later = addDays(dayStart(NOW), 10);
    const rows = board([product('A2', { cureDays: 2 })], [job('A2', 10, later, { orderNo: 'SO-72' })], [stock('A2', 0)]);
    expect(only(rows, 'A2').cells.get(later)).toBeDefined();
    expect(only(rows, 'A2').cells.get(later)?.late).toBe(false);
  });

  it('stays off when the route is not decided, because the cure time is unknown', () => {
    const rows = board(
      [product('A2', { route: 'unset', cureDays: 2 })],
      [job('A2', 10, dayStart(NOW), { orderNo: 'SO-73' })],
      [stock('A2', 0)],
    );
    expect(only(rows, 'A2').cells.get(dayStart(NOW))?.late).toBe(false);
  });

  it('adds the blaster’s handling time for a shotblast product', () => {
    const s = settings({ planning: { ...DEFAULT_SETTINGS.planning, blastHandlingDays: 5, bufferDays: 0 } });
    const day3 = addDays(dayStart(NOW), 3);
    const late = board(
      [product('A2', { route: 'shotblast', cureDays: 2 })],
      [job('A2', 10, day3, { orderNo: 'SO-81' })],
      [stock('A2', 0)],
      [],
      { settings: s },
    );
    const plain = board(
      [product('A2', { route: 'manufacture', cureDays: 2 })],
      [job('A2', 10, day3, { orderNo: 'SO-82' })],
      [stock('A2', 0)],
    );
    expect(only(late, 'A2').cells.get(day3)?.late).toBe(true);
    expect(only(plain, 'A2').cells.get(day3)?.late).toBe(false);
  });
});
