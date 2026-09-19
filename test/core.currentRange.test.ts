// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildJobLines, summariseJobs } from '@/core/jobsBoard';
import { buildSchedule, bucketCounts, summariseSchedule } from '@/core/schedule';
import { currentCodeSet, currentProducts, isCurrentProduct } from '@/core/currentRange';
import { DEFAULT_SETTINGS } from '@/core/defaults';
import { dayStart } from '@/core/dates';
import type { JobLineView } from '@/core/jobsBoard';
import type { JobRow, PlanItem, Product, Settings, StockRow } from '@/core/types';

/**
 * The current range — the tick on Products, and what it decides.
 *
 * One predicate, in `core/currentRange`, and the two halves of the rule it carries:
 * a planning screen cuts its rows with it (and every total with the rows), while the
 * order book and the log mark the exception and stay whole. The second half matters
 * as much as the first: 414 sold lines against 134 ticked codes means a filter
 * applied to the wrong screen hides most of what the shop owes.
 */

const NOW = new Date(2026, 8, 18, 16, 0).getTime(); // Friday 18 Sep 2026, late afternoon
const DAY = 86_400_000;
const TODAY = dayStart(NOW);

function promised(days: number): number {
  return TODAY + days * DAY + 12 * 3_600_000;
}

const SETTINGS: Settings = DEFAULT_SETTINGS;

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
    updatedAt: 0,
    ...over,
  };
}

function job(id: string, code: string, over: Partial<JobRow> = {}): JobRow {
  return {
    id: `${code}|${id}`,
    itemCode: code,
    itemDescription: `${code} limestone`,
    customer: 'Bunnings',
    orderNo: id,
    orderDate: promised(-20),
    promisedDate: promised(4),
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

function planItem(id: string, code: string, over: Partial<PlanItem> = {}): PlanItem {
  return {
    id,
    code,
    qty: 10,
    latestStartDate: null,
    promisedFor: null,
    route: 'manufacture',
    status: 'planned',
    linkedJobIds: [],
    note: '',
    rank: 1000,
    updatedAt: NOW,
    ...over,
  };
}

describe('isCurrentProduct', () => {
  it('is the tick, and nothing else', () => {
    expect(isCurrentProduct(product('GL4', { enabled: true }))).toBe(true);
    expect(isCurrentProduct(product('GL4', { enabled: false }))).toBe(false);
  });

  it('does not count a code that has been written off, however it is ticked', () => {
    // A tombstone is not a product. A filter that read `enabled` alone would plan a
    // make for a code somebody wrote off, and the row would never leave.
    expect(isCurrentProduct(product('GL4', { enabled: true, deleted: true }))).toBe(false);
    expect(isCurrentProduct(product('GL4', { enabled: false, deleted: true }))).toBe(false);
  });

  it('says no to a code this device has never seen', () => {
    // Both ways a lookup can miss have to answer the same way, or a caller has to
    // know which one it is holding — which is how a screen starts guessing.
    expect(isCurrentProduct(null)).toBe(false);
    expect(isCurrentProduct(undefined)).toBe(false);
  });

  it('takes the whole list and hands back the range, in the order it was given', () => {
    const list = [
      product('B2', { rank: 2000 }),
      product('GL4', { enabled: false }),
      product('S3'),
      product('OLD', { deleted: true }),
    ];
    // Order matters: the Matrix rows are the Products screen's rank order, and a
    // filter that re-sorted them would make a drag move a row to the wrong neighbour.
    expect(currentProducts(list).map((p) => p.code)).toEqual(['B2', 'S3']);
    expect(currentCodeSet(list)).toEqual(new Set(['B2', 'S3']));
    expect(currentProducts([])).toEqual([]);
  });
});

describe('the order book: marked, never hidden', () => {
  const lines = (products: Product[], jobs: JobRow[]): JobLineView[] =>
    buildJobLines({
      jobs,
      products,
      stockRows: [stockRow('GL4', 40), stockRow('OFF', 12)],
      batches: [],
      stockCapturedAt: NOW - 3_600_000,
      settings: SETTINGS,
      now: NOW,
    });

  const three = (): JobRow[] => [
    job('SO-1', 'GL4'),
    job('SO-2', 'OFF', { qty: 6 }),
    job('SO-3', 'ZZ9', { qty: 5 }),
  ];

  it('keeps every line whatever the tick says, and marks the two that are outside', () => {
    const out = lines([product('GL4'), product('OFF', { enabled: false })], three());

    expect(out).toHaveLength(3);
    const byCode = new Map(out.map((l) => [l.itemCode, l]));
    expect(byCode.get('GL4')?.current).toBe(true);
    expect(byCode.get('GL4')?.ours).toBe(true);
    // Ours, and unticked: the cover figures still mean something, so `ours` stays.
    expect(byCode.get('OFF')?.ours).toBe(true);
    expect(byCode.get('OFF')?.current).toBe(false);
    // Never seen at all: no `ours`, and no `current` either.
    expect(byCode.get('ZZ9')?.ours).toBe(false);
    expect(byCode.get('ZZ9')?.current).toBe(false);
  });

  it('still counts what is owed on a code nobody has ticked', () => {
    // The whole point of the exemption: the tick is about what we make next month, not
    // about what was sold last week. Unticking a code must not settle the debt.
    const out = lines([product('GL4'), product('OFF', { enabled: false })], three());
    const off = out.find((l) => l.itemCode === 'OFF');
    expect(off?.short).toBe(0); // 12 m² on the shelf against 6 m² promised
    expect(off?.available).toBe(12);

    const tickedAgain = lines([product('GL4'), product('OFF', { enabled: true })], three());
    expect(tickedAgain.find((l) => l.itemCode === 'OFF')?.short).toBe(off?.short);
  });

  it('counts the outside lines by cause, and once more as a total', () => {
    const out = lines([product('GL4'), product('OFF', { enabled: false })], three());
    // The two causes stay apart — one has cover figures, one has none — and the total
    // is the number the footer quotes, so the sentence under the table adds the same
    // two piles the chips beside it show.
    const totals = summariseJobs(out);
    expect(totals.lines).toBe(3);
    expect(totals.notCurrent).toBe(1);
    expect(totals.unknownCodes).toBe(1);
    expect(totals.outsideRange).toBe(2);
  });

  it('counts nothing as outside when the shop has ticked everything it sold', () => {
    const out = lines([product('GL4'), product('OFF'), product('ZZ9')], three());
    const totals = summariseJobs(out);
    expect(totals.outsideRange).toBe(0);
    expect(totals.notCurrent).toBe(0);
    expect(totals.unknownCodes).toBe(0);
  });
});

describe('the plan: rows and totals are one list', () => {
  function plan(products: Product[], planItems: PlanItem[] = []) {
    const lines = buildJobLines({
      jobs: [job('SO-1', 'GL4', { qty: 30 }), job('SO-2', 'OFF', { id: 'OFF|SO-2', qty: 30 }), job('SO-3', 'ZZ9', { qty: 30 })],
      products,
      stockRows: [],
      batches: [],
      stockCapturedAt: NOW - 3_600_000,
      settings: SETTINGS,
      now: NOW,
    });
    const rows = buildSchedule({ lines, planItems, products, settings: SETTINGS, now: NOW });
    return { rows, planned: rows.filter((r) => r.current) };
  }

  it('tags every row, of either kind, with the answer of the one predicate', () => {
    const { rows } = plan([product('GL4'), product('OFF', { enabled: false })]);
    expect(rows.find((r) => r.code === 'GL4')?.current).toBe(true);
    expect(rows.find((r) => r.code === 'OFF')?.current).toBe(false);
    // A code the device has never seen is not current either — it has no route, no
    // cure and no tray yield, so there is nothing on the plan for it to do.
    expect(rows.find((r) => r.code === 'ZZ9')?.current).toBe(false);
  });

  it('takes a plan line the shop wrote for an unticked code off the plan too', () => {
    const { rows, planned } = plan([product('GL4'), product('OFF', { enabled: false })], [planItem('p1', 'OFF')]);
    expect(rows.some((r) => r.origin === 'plan' && r.code === 'OFF')).toBe(true);
    expect(planned.some((r) => r.origin === 'plan' && r.code === 'OFF')).toBe(false);
    // The GL4 rows are untouched: the rule is per code, not a blanket trim.
    expect(planned.filter((r) => r.code === 'GL4')).toHaveLength(rows.filter((r) => r.code === 'GL4').length);
  });

  it('leaves the totals nothing the table has hidden', () => {
    // The failure this guards against is the loud one: a table with the row gone and
    // the footer still adding it up. Everything below is reduced over the filtered
    // list, so a figure on the screen cannot describe a row the screen is not showing.
    const { rows, planned } = plan([product('GL4'), product('OFF', { enabled: false })]);
    const all = summariseSchedule(rows);
    const shown = summariseSchedule(planned);

    expect(all.rows).toBe(3);
    expect(all.codes).toBe(3);
    expect(all.unplannedQty).toBe(90); // three codes, 30 each, nothing planned
    expect(shown.rows).toBe(1);
    expect(shown.codes).toBe(1);
    expect(shown.unplannedQty).toBe(30);
    expect(shown.behindQty).toBeLessThanOrEqual(all.behindQty);

    const counts = bucketCounts(planned);
    expect(counts.all).toBe(planned.length);
    for (const bucket of ['behind', 'week', 'later', 'making', 'undated'] as const) {
      expect(counts[bucket]).toBeLessThanOrEqual(counts.all);
    }
  });
});
