// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  PLAN_BUCKETS,
  bucketCounts,
  buildSchedule,
  defaultScheduleFilter,
  filterSchedule,
  isFiltering,
  summariseSchedule,
  type ScheduleLine,
} from '@/core/schedule';
import { buildJobLines, type JobLineView } from '@/core/jobsBoard';
import { DEFAULT_SETTINGS } from '@/core/defaults';
import { dayStart } from '@/core/dates';
import type { JobRow, PlanItem, Product, Settings, StockRow } from '@/core/types';

/**
 * The plan. The rules that matter here are the ones that end up deciding what the
 * floor makes on a Monday: which promise a planned make answers, what day the make
 * had best have started, and what is still sitting with nothing planned against it.
 *
 * The shortfalls are not invented — they come out of `buildJobLines`, the same
 * allocation the order book shows — so the tests seed jobs and stock and let that
 * module do its part.
 */

const NOW = new Date(2026, 8, 18, 16, 0).getTime(); // Friday 18 Sep 2026, late afternoon
const DAY = 86_400_000;
const TODAY = dayStart(NOW);

/** A promised date `days` after today, at midday so no boundary is ambiguous. */
function promised(days: number): number {
  return TODAY + days * DAY + 12 * 3_600_000;
}

function settings(over: Partial<Settings['sources']> = {}): Settings {
  return { ...DEFAULT_SETTINGS, sources: { ...DEFAULT_SETTINGS.sources, ...over } };
}

function product(over: Partial<Product> = {}): Product {
  return {
    code: 'GL4',
    description: 'Grey limestone 400',
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

function job(id: string, over: Partial<JobRow> = {}): JobRow {
  return {
    id,
    itemCode: 'GL4',
    itemDescription: 'Grey limestone 400',
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

function planItem(over: Partial<PlanItem> = {}): PlanItem {
  return {
    id: 'plan-1',
    code: 'GL4',
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

interface Seed {
  jobs?: JobRow[];
  stock?: StockRow[];
  plan?: PlanItem[];
  products?: Product[];
  settings?: Settings;
}

/** Jobs through the order book, then the plan built on top of what it says is owed. */
function seed(input: Seed): { lines: JobLineView[]; rows: ScheduleLine[] } {
  const products = input.products ?? [product()];
  const lines = buildJobLines({
    jobs: input.jobs ?? [],
    products,
    stockRows: input.stock ?? [],
    batches: [],
    stockCapturedAt: NOW - 3_600_000,
    settings: input.settings ?? settings(),
    now: NOW,
  });
  const rows = buildSchedule({
    lines,
    planItems: input.plan ?? [],
    products,
    settings: input.settings ?? settings(),
    now: NOW,
  });
  return { lines, rows };
}

const gaps = (rows: ScheduleLine[]) => rows.filter((r) => r.origin === 'gap');
const plans = (rows: ScheduleLine[]) => rows.filter((r) => r.origin === 'plan');
const dayOf = (days: number) => dayStart(promised(days));

describe('a promise with nothing behind it', () => {
  it('becomes one row, dated by the cure', () => {
    const { rows } = seed({ jobs: [job('SO-1', { promisedDate: promised(4), qty: 8 })] });

    expect(rows).toHaveLength(1);
    const [row] = rows as [ScheduleLine];
    expect(row.origin).toBe('gap');
    expect(row.code).toBe('GL4');
    expect(row.qty).toBe(8);
    expect(row.promisedFor).toBe(dayOf(4));
    // Two days of cure, no blasting handling on a manufacture route, no buffer.
    expect(row.latestStart).toBe(dayOf(2));
    expect(row.daysToStart).toBe(2);
    expect(row.bucket).toBe('week');
    expect(row.status).toBeNull();
    expect(row.note).toBe('Nothing has been planned for this yet.');
  });

  it('works in the item’s own unit, and in trays when the yield is known', () => {
    const { rows } = seed({ jobs: [job('SO-1', { qty: 10 })] });
    const [row] = rows as [ScheduleLine];
    expect(row.unit).toBe('m2');
    expect(row.trays).toBe(5);
  });

  it('adds a blasting day for a shotblast route', () => {
    const { rows } = seed({
      jobs: [job('SO-2', { promisedDate: promised(6), qty: 4 })],
      products: [product({ route: 'shotblast' })],
    });
    const [row] = rows as [ScheduleLine];
    // cure 2 + blast handling 1 = three days back from the promise.
    expect(row.latestStart).toBe(dayOf(3));
    expect(row.route).toBe('shotblast');
  });

  it('only asks for what the book says is still short', () => {
    const { rows } = seed({
      jobs: [job('SO-1', { qty: 8 })],
      stock: [stockRow('GL4', 5)],
    });
    const [row] = gaps(rows) as [ScheduleLine];
    expect(row.qty).toBe(3);
  });

  it('piles the same code by the day it is promised', () => {
    const { rows } = seed({
      jobs: [
        job('SO-1', { promisedDate: promised(3), qty: 4 }),
        job('SO-2', { promisedDate: promised(9), qty: 5 }),
        job('SO-3', { promisedDate: promised(3), qty: 2, customer: 'Bunnings' }),
      ],
    });
    // One row per promised day — the start date is two days earlier again.
    expect(gaps(rows).map((r) => [r.promisedFor, r.qty])).toEqual([
      [dayOf(3), 6],
      [dayOf(9), 5],
    ]);
    // Two lines for the same day become one make, naming both customers once.
    const [first] = gaps(rows) as [ScheduleLine];
    expect(first.jobIds).toEqual(['SO-1', 'SO-3']);
    expect(first.customers).toEqual(['Bunnings']);
  });

  it('leaves credits, undated lines and left-out ship-vias out of the plan', () => {
    const { rows } = seed({
      jobs: [
        job('SO-1', { promisedDate: promised(4), qty: 5 }),
        job('SO-2', { promisedDate: new Date(2040, 3, 4, 12).getTime(), qty: 30 }),
        job('SO-3', { qty: -8 }),
        job('SO-4', { qty: 12, shipVia: 'CUSTOMER PICKUP' }),
      ],
      settings: settings({ excludedShipVia: ['CUSTOMER PICKUP'] }),
    });
    const [row] = gaps(rows) as [ScheduleLine];
    expect(gaps(rows)).toHaveLength(1);
    expect(row.jobIds).toEqual(['SO-1']);
  });

  it('says so when a code is not one of ours and there is no lead time to work from', () => {
    const { rows } = seed({ jobs: [job('SO-1', { itemCode: 'ZZ9', qty: 6 })] });
    const [row] = rows as [ScheduleLine];
    expect(row.ours).toBe(false);
    expect(row.latestStart).toBeNull();
    expect(row.bucket).toBe('undated');
    expect(row.trays).toBeNull();
    expect(row.note).toContain('Not a product on this device');
  });
});

describe('what the shop has already planned', () => {
  it('answers the earliest promise first, and leaves the later one a gap', () => {
    const { rows } = seed({
      jobs: [
        job('SO-LATE', { promisedDate: promised(9), qty: 6 }),
        job('SO-EARLY', { promisedDate: promised(2), qty: 4 }),
      ],
      plan: [planItem({ qty: 4 })],
    });
    const [planned] = plans(rows) as [ScheduleLine];
    expect(planned.jobIds).toEqual(['SO-EARLY']);
    expect(planned.promisedFor).toBe(dayOf(2));
    expect(planned.surplus).toBe(0);
    expect(gaps(rows).map((r) => [r.jobIds, r.qty])).toEqual([[['SO-LATE'], 6]]);
  });

  it('lets an explicit link override the earliest-promise rule', () => {
    const { rows } = seed({
      jobs: [
        job('SO-EARLY', { promisedDate: promised(2), qty: 4 }),
        job('SO-LATE', { promisedDate: promised(9), qty: 6 }),
      ],
      plan: [planItem({ qty: 6, linkedJobIds: ['SO-LATE'] })],
    });
    const [planned] = plans(rows) as [ScheduleLine];
    expect(planned.jobIds).toEqual(['SO-LATE']);
    expect(planned.promisedFor).toBe(dayOf(9));
    // The earlier promise is untouched by it, and is still a gap.
    expect(gaps(rows).map((r) => r.jobIds)).toEqual([['SO-EARLY']]);
  });

  it('will not let two plan items answer the same promise', () => {
    const { rows } = seed({
      jobs: [job('SO-1', { promisedDate: promised(4), qty: 4 })],
      plan: [planItem({ id: 'plan-a', qty: 4 }), planItem({ id: 'plan-b', qty: 4, rank: 2000 })],
    });
    const [first, second] = plans(rows) as [ScheduleLine, ScheduleLine];
    expect(first.jobIds).toEqual(['SO-1']);
    expect(second.jobIds).toEqual([]);
    expect(second.surplus).toBe(4);
    expect(second.note).toContain('already covered');
    expect(gaps(rows)).toHaveLength(0);
  });

  it('reports a plan that makes more than the promises ask for, rather than trimming it', () => {
    const { rows } = seed({
      jobs: [job('SO-1', { promisedDate: promised(4), qty: 4 })],
      plan: [planItem({ qty: 10 })],
    });
    const [planned] = plans(rows) as [ScheduleLine];
    expect(planned.qty).toBe(10);
    expect(planned.surplus).toBe(6);
    expect(planned.note).toContain('6 more than the promises it answers');
    expect(summariseSchedule(rows).surplusQty).toBe(6);
  });

  it('shows a started make as being made, not as over-planning', () => {
    const { rows } = seed({
      jobs: [job('SO-1', { promisedDate: promised(1), qty: 4 })],
      plan: [planItem({ qty: 10, status: 'started' })],
    });
    const [planned] = plans(rows) as [ScheduleLine];
    expect(planned.bucket).toBe('making');
    expect(planned.surplus).toBe(0);
    expect(planned.note).toContain('Being made');
    // And it is not counted as behind, even though its start day has gone.
    expect(rows.filter((r) => r.bucket === 'behind')).toHaveLength(0);
  });

  it('keeps a make nothing is owed, because a target refill is a plan too', () => {
    const { rows } = seed({ jobs: [], plan: [planItem({ qty: 20, promisedFor: promised(11) })] });
    const [planned] = rows as [ScheduleLine];
    expect(planned.origin).toBe('plan');
    expect(planned.bucket).toBe('later');
    expect(planned.note).toContain('Nothing in the order book is waiting on this');
  });

  it('does not show a cancelled or deleted plan item', () => {
    const { rows } = seed({
      jobs: [job('SO-1', { qty: 4 })],
      plan: [
        planItem({ id: 'plan-x', status: 'cancelled', qty: 4 }),
        planItem({ id: 'plan-y', deleted: true, qty: 4 }),
      ],
    });
    expect(plans(rows)).toHaveLength(0);
    expect(rows.map((r) => r.id)).toEqual([`gap|GL4|${String(dayOf(4))}`]);
  });
});

describe('when a make has to start', () => {
  it('is behind the day the start date slips past today', () => {
    const { rows } = seed({
      jobs: [
        job('SO-BEHIND', { promisedDate: promised(1), qty: 1 }),
        job('SO-TODAY', { promisedDate: promised(2), qty: 1 }),
        job('SO-WEEK', { promisedDate: promised(8), qty: 1 }),
        job('SO-LATER', { promisedDate: promised(9), qty: 1 }),
      ],
    });
    const byStart = new Map(rows.map((r) => [r.jobIds[0], r]));
    expect(byStart.get('SO-BEHIND')?.daysToStart).toBe(-1);
    expect(byStart.get('SO-BEHIND')?.bucket).toBe('behind');
    expect(byStart.get('SO-TODAY')?.daysToStart).toBe(0);
    expect(byStart.get('SO-TODAY')?.bucket).toBe('week');
    expect(byStart.get('SO-WEEK')?.daysToStart).toBe(6);
    expect(byStart.get('SO-WEEK')?.bucket).toBe('week');
    expect(byStart.get('SO-LATER')?.daysToStart).toBe(7);
    expect(byStart.get('SO-LATER')?.bucket).toBe('later');
  });

  it('says what a plan with a start day gone is worth', () => {
    const { rows } = seed({ jobs: [job('SO-1', { promisedDate: promised(1), qty: 12 })] });
    const totals = summariseSchedule(rows);
    expect(totals.behind).toBe(1);
    expect(totals.behindQty).toBe(12);
    expect(totals.unplanned).toBe(1);
    expect(totals.unplannedQty).toBe(12);
    expect(totals.codes).toBe(1);
    expect(totals.customers).toBe(1);
  });

  it('puts the rows a person has to act on first', () => {
    const { rows } = seed({
      jobs: [
        job('SO-LATER', { promisedDate: promised(20), qty: 30 }),
        job('SO-BEHIND', { promisedDate: promised(1), qty: 1 }),
        job('SO-WEEK', { promisedDate: promised(5), qty: 5 }),
      ],
    });
    expect(rows.map((r) => r.jobIds[0])).toEqual(['SO-BEHIND', 'SO-WEEK', 'SO-LATER']);
  });
});

describe('the counts and the filter never disagree', () => {
  const mixed = () =>
    seed({
      jobs: [
        job('SO-1', { promisedDate: promised(1), qty: 4, customer: 'Bunnings' }),
        job('SO-2', { promisedDate: promised(5), qty: 6, customer: 'Mitre 10', orderNo: 'SO-2' }),
        job('SO-3', { promisedDate: promised(20), qty: 2, itemCode: 'ZZ9', customer: 'Bunnings' }),
      ],
      plan: [planItem({ id: 'plan-a', qty: 4, status: 'started', promisedFor: promised(3) })],
    });

  it('counts each pile exactly as pressing it shows', () => {
    const { rows } = mixed();
    const counts = bucketCounts(rows);
    for (const bucket of PLAN_BUCKETS) {
      expect(filterSchedule(rows, { ...defaultScheduleFilter(), bucket: bucket.key })).toHaveLength(
        counts[bucket.key],
      );
    }
    expect(counts.all).toBe(rows.length);
  });

  it('narrows by what you type and by what has not been planned', () => {
    const { rows } = mixed();
    const base = defaultScheduleFilter();
    expect(isFiltering(base)).toBe(false);

    const oneCustomer = filterSchedule(rows, { ...base, query: 'mitre' });
    expect(oneCustomer.map((r) => r.jobIds)).toEqual([['SO-2']]);
    expect(isFiltering({ ...base, query: ' mitre ' })).toBe(true);

    const byOrder = filterSchedule(rows, { ...base, query: 'SO-1' });
    expect(byOrder).toHaveLength(1);

    const unplanned = filterSchedule(rows, { ...base, unplannedOnly: true });
    expect(unplanned.every((r) => r.origin === 'gap')).toBe(true);
    expect(plans(rows).every((r) => unplanned.includes(r))).toBe(false);
  });

  it('adds up to the same shortfall the order book reports', () => {
    const { lines, rows } = seed({
      jobs: [
        job('SO-1', { promisedDate: promised(3), qty: 8 }),
        job('SO-2', { promisedDate: promised(10), qty: 6, customer: 'Mitre 10' }),
      ],
      plan: [planItem({ qty: 8 })],
      stock: [stockRow('GL4', 2)],
    });

    // What the book says is owed across every dated, non-excluded, positive line…
    const owed = lines
      .filter((l) => l.qty > 0 && !l.excluded && !l.farFuture)
      .reduce((sum, l) => sum + l.short, 0);
    // …is exactly what the plan accounts for: what is planned against a promise,
    // plus what is still standing as a gap. Nothing is invented and nothing is lost.
    const accounted = rows.reduce(
      (sum, r) => sum + (r.origin === 'gap' ? r.qty : Math.max(0, r.qty - r.surplus)),
      0,
    );
    expect(owed).toBe(12);
    expect(accounted).toBe(owed);
  });
});

describe('the same numbers give the same answer', () => {
  it('does not care what order the rows arrived in', () => {
    const jobs = [
      job('SO-1', { promisedDate: promised(3), qty: 8 }),
      job('SO-2', { promisedDate: promised(9), qty: 5, customer: 'Mitre 10' }),
      job('SO-3', { promisedDate: promised(3), qty: 2, itemCode: 'ZZ9' }),
    ];
    const plansIn = [planItem({ id: 'plan-b', qty: 5, rank: 2000 }), planItem({ id: 'plan-a', qty: 8 })];

    const first = seed({ jobs, plan: plansIn }).rows.map((r) => r.id);
    const second = seed({ jobs: [...jobs].reverse(), plan: [...plansIn].reverse() }).rows.map((r) => r.id);
    expect(second).toEqual(first);
    expect(new Set(first).size).toBe(first.length);
  });
});
