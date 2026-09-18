// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { dayStart } from '@/core/dates';
import { DEFAULT_SETTINGS } from '@/core/defaults';
import type { JobRow, Product, StockRow } from '@/core/types';
import { PermissionError } from '@/data/principal';
import { db, replaceJobsSnapshot, replaceStockSnapshot } from '@/data/db';
import {
  addPlanItem,
  cancelPlanItem,
  PlanRefusedError,
  planItemsForCode,
  scheduleSource,
  startPlanItem,
} from '@/data/planRepo';
import { signInForTests } from './support/who';

/**
 * Putting a make on the plan, and taking it off again.
 *
 * A plan line is the only place the shop says "we are making this", so the writer is
 * judged on three things: the start date has to be computed the way the schedule
 * shows it, the refusals have to be sentences a person can act on, and every press
 * has to leave a ledger line that says what was decided.
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

/** Captures as they are really stored: the header on its own, rows in their own table. */
async function addJobs(rows: JobRow[], capturedAt = NOW - DAY, source = 'future.xlsx'): Promise<void> {
  await replaceJobsSnapshot({
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
  });
}

async function addStock(rows: StockRow[], capturedAt = NOW - DAY, source = 'location.xlsx'): Promise<void> {
  await replaceStockSnapshot({
    id: `stock-${capturedAt}`,
    capturedAt,
    source,
    rows,
    diagnostics: {
      sheetName: 'StockOnHand',
      reportTitle: 'Stock on hand',
      headerRow: 4,
      rowsRead: rows.length,
      rowsUsed: rows.length,
      totalRowsSkipped: 0,
      groupRowsSkipped: 0,
      unparsed: [],
    },
  });
}

async function ledger(action?: string) {
  const all = await db.events.toArray();
  return action === undefined ? all : all.filter((e) => e.action === action);
}

beforeEach(async () => {
  await db.products.clear();
  await db.planItems.clear();
  await db.events.clear();
  await db.jobsSnapshots.clear();
  await db.jobRows.clear();
  await db.stockSnapshots.clear();
  await db.stockRows.clear();
  // Writes go through the permission check, so the test has to be somebody.
  signInForTests('maker');
});

describe('putting a make on the plan', () => {
  it('works the start date out from the product, not from the screen', async () => {
    await db.products.put(product('A3', { cureDays: 3 }));

    const item = await addPlanItem({ code: 'A3', qty: 8, promisedFor: NOW + 5 * DAY });

    expect(item.status).toBe('planned');
    expect(item.route).toBe('manufacture');
    expect(item.id).toMatch(/^plan_/);
    // Three days of cure, no blasting day on a manufacture route, no buffer.
    expect(item.latestStartDate).toBe(dayStart(NOW + 2 * DAY));
    expect(item.linkedJobIds).toEqual([]);

    const [line] = await ledger('plan.add');
    expect(line?.code).toBe('A3');
    expect(line?.qty).toBe(8);
    expect(line?.detail).toContain('A3 · 8.00 m² put on the plan');
    expect(line?.detail).toContain('start by ');
  });

  it('carries the order lines it was written for, and the note the shop typed', async () => {
    await db.products.put(product('A3'));
    const item = await addPlanItem({
      code: 'A3',
      qty: 10,
      promisedFor: NOW + 6 * DAY,
      linkedJobIds: ['A3|SO-1', 'A3|SO-1', 'A3|SO-2'],
      note: '  second pour on the Tuesday  ',
    });
    expect(item.linkedJobIds).toEqual(['A3|SO-1', 'A3|SO-2']);
    expect(item.note).toBe('second pour on the Tuesday');
    const [line] = await ledger('plan.add');
    expect(line?.detail).toContain('orders A3|SO-1, A3|SO-2');
  });

  it('lets a refill with no promise behind it have no start date', async () => {
    await db.products.put(product('A3'));
    const item = await addPlanItem({ code: 'A3', qty: 4, promisedFor: null });
    expect(item.latestStartDate).toBeNull();
    expect(item.promisedFor).toBeNull();
    const [line] = await ledger('plan.add');
    expect(line?.detail).toContain('with no promise behind it');
  });

  it('puts new lines after the ones already there', async () => {
    await db.products.put(product('A3'));
    const first = await addPlanItem({ code: 'A3', qty: 4, promisedFor: null });
    const second = await addPlanItem({ code: 'A3', qty: 5, promisedFor: null });
    expect(second.rank).toBeGreaterThan(first.rank);
  });

  it('refuses a quantity that is not a quantity', async () => {
    await db.products.put(product('A3'));
    for (const qty of [0, -8, Number.NaN]) {
      await expect(addPlanItem({ code: 'A3', qty, promisedFor: NOW })).rejects.toBeInstanceOf(PlanRefusedError);
    }
    expect(await db.planItems.count()).toBe(0);
    expect(await ledger('plan.add')).toHaveLength(0);
  });

  it('refuses a code that is not one of ours, and names it', async () => {
    await expect(addPlanItem({ code: 'ZZ9', qty: 4, promisedFor: NOW })).rejects.toThrowError(
      /ZZ9 is not a product on this device/,
    );
  });

  it('refuses a product with no route, because the start date would be a guess', async () => {
    await db.products.put(product('A3', { route: 'unset' }));
    await expect(addPlanItem({ code: 'A3', qty: 4, promisedFor: NOW })).rejects.toThrowError(/no route set/);
  });

  it('refuses a product that has been switched off, in the same words', async () => {
    await db.products.put(product('A3', { deleted: true }));
    await expect(addPlanItem({ code: 'A3', qty: 4, promisedFor: NOW })).rejects.toThrowError(
      /not a product on this device/,
    );
  });

  it('is not something a read-only login may do', async () => {
    await db.products.put(product('A3'));
    signInForTests('viewer');
    await expect(addPlanItem({ code: 'A3', qty: 4, promisedFor: NOW })).rejects.toBeInstanceOf(PermissionError);
    await expect(startPlanItem('plan-any')).rejects.toBeInstanceOf(PermissionError);
    await expect(cancelPlanItem('plan-any', 'because')).rejects.toBeInstanceOf(PermissionError);
    expect(await db.planItems.count()).toBe(0);
    expect(await ledger('plan.add')).toHaveLength(0);
  });
});

describe('starting and taking off a planned make', () => {
  it('marks it started, once, and says so in the log', async () => {
    await db.products.put(product('A3'));
    const item = await addPlanItem({ code: 'A3', qty: 8, promisedFor: NOW + 5 * DAY });

    const started = await startPlanItem(item.id);
    expect(started.status).toBe('started');
    expect(started.qty).toBe(item.qty);
    expect(started.latestStartDate).toBe(item.latestStartDate);
    expect((await db.planItems.get(item.id))?.status).toBe('started');

    const lines = await ledger('plan.start');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.detail).toContain('marked started');

    await expect(startPlanItem(item.id)).rejects.toThrowError(/Already marked as started/);
    expect(await ledger('plan.start')).toHaveLength(1);
  });

  it('will not start something that has been taken off the plan', async () => {
    await db.products.put(product('A3'));
    const item = await addPlanItem({ code: 'A3', qty: 8, promisedFor: NOW + 5 * DAY });
    await cancelPlanItem(item.id, 'The customer took the order back');

    await expect(startPlanItem(item.id)).rejects.toThrowError(/taken off the plan/);
  });

  it('wants a reason before it takes one off, and keeps the item', async () => {
    await db.products.put(product('A3'));
    const item = await addPlanItem({ code: 'A3', qty: 8, promisedFor: NOW + 5 * DAY });

    await expect(cancelPlanItem(item.id, '   ')).rejects.toThrowError(/needs a reason/);
    expect((await db.planItems.get(item.id))?.status).toBe('planned');

    const off = await cancelPlanItem(item.id, 'made by a customer who changed the order');
    expect(off.status).toBe('cancelled');
    // Cancelled, not erased: other devices have to hear that it went away.
    expect(await db.planItems.get(item.id)).toBeDefined();
    const [line] = await ledger('plan.cancel');
    expect(line?.detail).toContain('taken off the plan — made by a customer who changed the order');

    // Pressing it again changes nothing and writes nothing.
    const again = await cancelPlanItem(item.id, 'again');
    expect(again.status).toBe('cancelled');
    expect(await ledger('plan.cancel')).toHaveLength(1);
  });

  it('refuses a plan line this device does not have', async () => {
    await expect(startPlanItem('plan-gone')).rejects.toThrowError(/not on this device/);
    await expect(cancelPlanItem('plan-gone', 'whatever')).rejects.toThrowError(/not on this device/);
  });
});

describe('what the schedule screen reads', () => {
  it('is empty in the way an unused device is empty', async () => {
    const source = await scheduleSource();
    expect(source.jobs).toEqual([]);
    expect(source.jobsCapturedAt).toBeNull();
    expect(source.stockRows).toEqual([]);
    expect(source.stockCapturedAt).toBeNull();
    expect(source.planItems).toEqual([]);
    expect(source.settings.planning.bufferDays).toBe(DEFAULT_SETTINGS.planning.bufferDays);
  });

  it('brings the exports, the products and the plan in one read', async () => {
    await db.products.put(product('A3'));
    await db.products.put(product('B2', { rank: 5 }));
    await db.products.put(product('OLD', { deleted: true }));
    await addJobs([jobRow('A3|SO-1'), jobRow('A3|SO-2', { orderNo: 'SO-2', id: 'A3|SO-2' })]);
    await addStock([stockRow('A3', 6)]);
    await addPlanItem({ code: 'A3', qty: 8, promisedFor: NOW + 5 * DAY });
    const second = await addPlanItem({ code: 'B2', qty: 2, promisedFor: null });
    await cancelPlanItem(second.id, 'not needed');

    const source = await scheduleSource();
    expect(source.jobs).toHaveLength(2);
    expect(source.jobsCapturedAt).toBe(NOW - DAY);
    expect(source.stockCapturedAt).toBe(NOW - DAY);
    // A discontinued product is not one of ours, and the rank order is the shop's.
    expect(source.products.map((p) => p.code)).toEqual(['B2', 'A3']);
    // Cancelled lines come back so the screen can say what was taken off; they are
    // left out of the plan maths by the core rules.
    expect(source.planItems.map((i) => i.status)).toEqual(['planned', 'cancelled']);
  });

  it('lists the plan lines a code still has to honour', async () => {
    await db.products.put(product('A3'));
    await db.products.put(product('B2'));
    const keep = await addPlanItem({ code: 'A3', qty: 8, promisedFor: NOW + 5 * DAY });
    const other = await addPlanItem({ code: 'B2', qty: 3, promisedFor: null });
    const gone = await addPlanItem({ code: 'A3', qty: 4, promisedFor: null });
    await cancelPlanItem(gone.id, 'duplicate');

    const forA3 = await planItemsForCode('A3');
    expect(forA3.map((i) => i.id)).toEqual([keep.id]);
    expect(await planItemsForCode('B2')).toHaveLength(1);
    expect(other.code).toBe('B2');
    expect(await planItemsForCode('ZZ9')).toEqual([]);
  });
});
