// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { dayStart } from '@/core/dates';
import { DEFAULT_SETTINGS } from '@/core/defaults';
import type { Batch, JobsSnapshot, JobRow, Product, StockSnapshot, StockRow } from '@/core/types';
import { db, replaceJobsSnapshot, replaceStockSnapshot } from '@/data/db';
import { jobBoardSource, productForCode } from '@/data/jobRepo';

/**
 * What the order book is read from.
 *
 * The board mixes four tables — the job export, the shop's products, the stock
 * export and the racks on the floor — so the read that matters is that they arrive
 * as one consistent picture: the newest exports, not the ones before them; a product
 * that has been discontinued is no longer one of ours; a rack that was written off is
 * not work in progress.
 */

const DAY = 86_400_000;
const NOW = dayStart(Date.now()) + 9 * 3_600_000;

function product(code: string, over: Partial<Product> = {}): Product {
  return {
    code,
    description: `${code} paver`,
    enabled: true,
    route: 'manufacture',
    usesBaseline10000: false,
    unit: 'm2',
    trayYield: 1.44,
    target: 0,
    cureDays: 2,
    notes: '',
    rank: code === 'A3' ? 10 : 20,
    seenInJobs: true,
    updatedAt: NOW,
    ...over,
  };
}

function jobRow(id: string, over: Partial<JobRow> = {}): JobRow {
  return {
    id,
    itemCode: 'A3',
    itemDescription: 'A3 paver',
    customer: 'Bunnings',
    orderNo: 'SO-1',
    orderDate: NOW - 10 * DAY,
    promisedDate: NOW + 4 * DAY,
    qty: 8,
    shipVia: 'DELIVER',
    salesperson: 'Karen',
    rank: 1,
    ...over,
  };
}

function stockRow(code: string, qty: number, location = 'HQ'): StockRow {
  return { code, location, qtyOnHandRaw: qty, category: 'Stone' };
}

function rack(id: string, over: Partial<Batch> = {}): Batch {
  return {
    id,
    batchNo: '2026-09-14-01',
    code: 'A3',
    lineId: 'line-1',
    trays: 5,
    qty: 10,
    qtyOverridden: false,
    routeSnapshot: 'manufacture',
    stage: 'curing',
    madeAt: NOW - 2 * DAY,
    cureDaysSnapshot: 2,
    cureDueAt: NOW,
    blastedQty: 0,
    blastedAt: null,
    myobRunDate: null,
    enteredAt: null,
    enteredRef: '',
    operator: 'Mike',
    note: '',
    rank: 1,
    parentBatchId: null,
    updatedAt: NOW,
    ...over,
  };
}

/** A capture as it is stored: the header on its own, rows in their own table. */
function jobsCapture(capturedAt: number, rows: JobRow[], source = 'future.xlsx'): JobsSnapshot {
  return {
    id: `jobs-${capturedAt}`,
    capturedAt,
    source,
    periodFrom: NOW - 200 * DAY,
    periodTo: NOW,
    rows,
    diagnostics: {
      sheetName: 'Sales',
      reportTitle: 'Sales [Item Detail]',
      headerRow: 5,
      rowsRead: rows.length,
      rowsUsed: rows.length,
      totalRowsSkipped: 0,
      groupRowsSkipped: 0,
      unparsed: [],
    },
  };
}

/** Seeded through the real writer, so storage shape is not a guess. */
async function addCapture(capturedAt: number, rows: JobRow[]): Promise<void> {
  await replaceJobsSnapshot(jobsCapture(capturedAt, rows));
}

function stockCapture(capturedAt: number, rows: StockRow[]): StockSnapshot {
  return {
    id: `stock-${capturedAt}`,
    capturedAt,
    source: 'location.xlsx',
    rows,
    diagnostics: {
      sheetName: 'Item List',
      reportTitle: 'Item List [Summary]',
      headerRow: 4,
      rowsRead: rows.length,
      rowsUsed: rows.length,
      totalRowsSkipped: 0,
      groupRowsSkipped: 0,
      unparsed: [],
    },
  };
}

beforeEach(async () => {
  await db.events.clear();
  await db.products.clear();
  await db.batches.clear();
  await db.jobsSnapshots.clear();
  await db.jobRows.clear();
  await db.stockSnapshots.clear();
  await db.stockRows.clear();
  await db.meta.clear();
});

describe('reading the order book', () => {
  it('says what a device with nothing on it has', async () => {
    const source = await jobBoardSource();

    expect(source.jobs).toEqual([]);
    expect(source.capturedAt).toBeNull();
    expect(source.source).toBe('');
    expect(source.stockRows).toEqual([]);
    expect(source.stockCapturedAt).toBeNull();
    // The settings always come back — the board needs its rules before it has data.
    expect(source.settings.planning.placeholderYears).toEqual(DEFAULT_SETTINGS.planning.placeholderYears);
  });

  it('brings the newest export, not the one before it', async () => {
    await addCapture(NOW - 8 * DAY, [jobRow('old|SO-1')]);
    await addCapture(NOW, [jobRow('new|SO-2', { orderNo: 'SO-2' }), jobRow('new|SO-3', { orderNo: 'SO-3' })]);

    const source = await jobBoardSource();
    expect(source.jobs.map((j) => j.id).sort()).toEqual(['new|SO-2', 'new|SO-3']);
    expect(source.capturedAt).toBe(NOW);
    expect(source.source).toBe('future.xlsx');
    expect(source.periodFrom).toBe(NOW - 200 * DAY);
  });

  it('brings the newest stock capture too, and says when it was taken', async () => {
    await replaceStockSnapshot(stockCapture(NOW - 30 * DAY, [stockRow('A3', 1)]));
    await replaceStockSnapshot(stockCapture(NOW - DAY, [stockRow('A3', 44), stockRow('B2', 3)]));

    const source = await jobBoardSource();
    expect(source.stockCapturedAt).toBe(NOW - DAY);
    expect(source.stockRows).toHaveLength(2);
    expect(source.stockRows.find((r) => r.code === 'A3')?.qtyOnHandRaw).toBe(44);
  });

  it('does not count a discontinued product as one of ours', async () => {
    await db.products.bulkAdd([product('A3'), product('ZZ9', { deleted: true })]);

    const source = await jobBoardSource();
    expect(source.products.map((p) => p.code)).toEqual(['A3']);
    expect(productForCode(source.products, 'A3')?.code).toBe('A3');
    expect(productForCode(source.products, 'ZZ9')).toBeNull();
    // A code that is not ours is not an error, it is a fact the row has to carry.
    expect(productForCode(source.products, 'FROM-CHINA')).toBeNull();
  });

  it('leaves written-off racks out of what is being made', async () => {
    await db.batches.bulkAdd([rack('b-1'), rack('b-2', { deleted: true, stage: 'written_off' })]);

    const source = await jobBoardSource();
    expect(source.batches.map((b) => b.id)).toEqual(['b-1']);
  });

  it('comes ranked, so a board that is not sorted still reads in the shop’s order', async () => {
    await db.products.bulkAdd([product('B2', { rank: 5 }), product('A3', { rank: 1 })]);

    const source = await jobBoardSource();
    expect(source.products.map((p) => p.code)).toEqual(['A3', 'B2']);
  });

  it('survives a device with jobs but no stock export yet', async () => {
    await addCapture(NOW, [jobRow('a|SO-1')]);
    await db.products.add(product('A3'));

    const source = await jobBoardSource();
    expect(source.jobs).toHaveLength(1);
    expect(source.stockRows).toEqual([]);
    expect(source.stockCapturedAt).toBeNull();
    // The board can still say what was sold; it just cannot promise cover.
    expect(source.products).toHaveLength(1);
  });
});
