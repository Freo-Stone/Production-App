// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  buildJobLines,
  coverBreakdown,
  defaultJobFilter,
  filterJobLines,
  inWindow,
  summariseJobs,
  windowCounts,
  type JobLineView,
} from '@/core/jobsBoard';
import { DEFAULT_SETTINGS } from '@/core/defaults';
import { dayStart } from '@/core/dates';
import type { Batch, JobRow, Product, Settings, StockRow } from '@/core/types';

/**
 * The order book. The rules worth testing are the ones a customer phone call
 * depends on: what counts as late, and which line the pallet standing in the yard
 * actually answers.
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

function job(over: Partial<JobRow> = {}): JobRow {
  return {
    id: `GL4|SO-1`,
    itemCode: 'GL4',
    itemDescription: 'Grey limestone 400',
    customer: 'Bunnings',
    orderNo: 'SO-1',
    orderDate: promised(-20),
    promisedDate: promised(4),
    qty: 8,
    shipVia: 'DELIVER',
    salesperson: 'Karen',
    rank: 1,
    ...over,
  };
}

function stockRow(code: string, location: string, qty: number): StockRow {
  return { code, location, qtyOnHandRaw: qty, category: 'Stone' };
}

let rackCount = 0;

/** A rack on the floor, in the shape the app actually stores. */
function rack(code: string, stage: Batch['stage'], qty: number, over: Partial<Batch> = {}): Batch {
  rackCount += 1;
  return {
    id: `b-${code}-${stage}-${rackCount}`,
    batchNo: `2026-09-14-0${rackCount}`,
    code,
    lineId: 'line-1',
    trays: qty / 2,
    qty,
    qtyOverridden: false,
    routeSnapshot: 'manufacture',
    stage,
    madeAt: NOW - 4 * DAY,
    cureDaysSnapshot: 2,
    cureDueAt: NOW - 2 * DAY,
    blastedQty: 0,
    blastedAt: null,
    myobRunDate: null,
    enteredAt: null,
    enteredRef: '',
    operator: 'Mike',
    note: '',
    rank: 1000 + rackCount,
    parentBatchId: null,
    updatedAt: NOW,
    ...over,
  };
}

function lines(jobs: JobRow[], over: Partial<Parameters<typeof buildJobLines>[0]> = {}): JobLineView[] {
  return buildJobLines({
    jobs,
    products: [product()],
    stockRows: [],
    batches: [],
    stockCapturedAt: null,
    settings: settings(),
    now: NOW,
    ...over,
  });
}

describe('the order book', () => {
  it('counts how long there is, and calls a passed date past due', () => {
    const board = new Map(
      lines([
        job({ id: 'soon', promisedDate: promised(4) }),
        job({ id: 'late', promisedDate: promised(-3) }),
        job({ id: 'today', promisedDate: promised(0) }),
      ]).map((l) => [l.id, l]),
    );
    const soon = board.get('soon')!;
    const late = board.get('late')!;
    const today = board.get('today')!;
    // The list comes back in promise order: earliest promise first, the order a
    // person works the book in.
    expect(lines([job({ id: 'x', promisedDate: promised(9) }), job({ id: 'y', promisedDate: promised(1) })]).map((l) => l.id)).toEqual(['y', 'x']);

    expect(soon?.daysToGo).toBe(4);
    expect(soon?.pastDue).toBe(false);
    expect(late?.daysToGo).toBe(-3);
    expect(late?.pastDue).toBe(true);
    // Promised today is not late yet. It is the day the truck comes.
    expect(today?.daysToGo).toBe(0);
    expect(today?.pastDue).toBe(false);
  });

  it('holds a placeholder promise date out of every near-term view', () => {
    // The date the export actually uses for a large share of its open lines.
    const placeholder = new Date(2040, 3, 4, 12).getTime();
    const [far] = lines([job({ id: 'far', promisedDate: placeholder })]);

    expect(far?.farFuture).toBe(true);
    // A date the shop does not believe is never "late" — that would shout about
    // 600 lines the export has never dated.
    expect(far?.pastDue).toBe(false);
    expect(inWindow(far!, 'past')).toBe(false);
    expect(inWindow(far!, 'week')).toBe(false);
    expect(inWindow(far!, 'all')).toBe(true);

    const board = lines([job({ id: 'near', promisedDate: promised(2) }), job({ id: 'far', promisedDate: placeholder })]);
    expect(filterJobLines(board, defaultJobFilter()).map((l) => l.id)).toEqual(['near']);
    expect(filterJobLines(board, { ...defaultJobFilter(), showFarFuture: true }).map((l) => l.id)).toEqual(['near', 'far']);
  });

  it('keeps the window edges where the chips say they are', () => {
    const board = new Map<number, JobLineView>();
    for (const days of [-1, 0, 7, 8, 14, 15]) {
      board.set(days, lines([job({ id: `d${days}`, promisedDate: promised(days) })])[0]!);
    }
    expect(inWindow(board.get(-1)!, 'past')).toBe(true);
    expect(inWindow(board.get(0)!, 'past')).toBe(false);
    expect(inWindow(board.get(7)!, 'week')).toBe(true);
    expect(inWindow(board.get(8)!, 'week')).toBe(false);
    expect(inWindow(board.get(8)!, 'fortnight')).toBe(true);
    expect(inWindow(board.get(14)!, 'fortnight')).toBe(true);
    expect(inWindow(board.get(15)!, 'fortnight')).toBe(false);
  });

  it('hands the pool out in promise order, so a pallet is only promised once', () => {
    // 10 m² on the shelf. Two customers want GL4: the later promise is asked first
    // by the export, which is exactly why the order cannot be taken from the sheet.
    const board = lines(
      [
        job({ id: 'later', orderNo: 'SO-9', promisedDate: promised(9), qty: 5 }),
        job({ id: 'earlier', orderNo: 'SO-2', promisedDate: promised(2), qty: 8 }),
      ],
      { stockRows: [stockRow('GL4', 'HQ', 10)] },
    );

    const earlier = board.find((l) => l.id === 'earlier')!;
    const later = board.find((l) => l.id === 'later')!;
    expect(earlier.available).toBe(10);
    expect(earlier.covered).toBe(8);
    expect(earlier.short).toBe(0);
    expect(later.covered).toBe(2);
    expect(later.short).toBe(3);
    // The pool itself is the same figure on both lines: it is the code's, not the line's.
    expect(later.available).toBe(10);
  });

  it('counts what is being made, and what is keyed but not yet exported', () => {
    const board = lines([job({ id: 'a', promisedDate: promised(2), qty: 20 })], {
      stockRows: [stockRow('GL4', 'HQ', 4)],
      batches: [
        rack('GL4', 'curing', 6),
        rack('GL4', 'ready', 3),
        // Keyed into MYOB after the stock snapshot: the export has not caught up,
        // so it is still the shop's to point at.
        rack('GL4', 'entered_myob', 5, { enteredAt: NOW - DAY, enteredRef: 'INV-1' }),
      ],
      stockCapturedAt: NOW - 3 * DAY,
    });

    const line = board[0]!;
    expect(line.available).toBe(18); // 4 + 6 + 3 + 5
    expect(line.covered).toBe(18);
    expect(line.short).toBe(2);
  });

  it('respects the shop’s own stock rules while doing it', () => {
    // The phantom 10000 comes off once, and only for a baseline item.
    const baseline = lines([job({ id: 'a', promisedDate: promised(2), qty: 6 })], {
      products: [product({ usesBaseline10000: true })],
      stockRows: [stockRow('GL4', 'HQ', 10_004)],
    });
    expect(baseline[0]?.available).toBe(4);

    // A rack that is ready is not available when the shop says ready work is not.
    const strict = lines([job({ id: 'a', promisedDate: promised(2), qty: 6 })], {
      settings: settings({ countsReadyAsAvailable: false }),
      batches: [rack('GL4', 'ready', 3)],
    });
    expect(strict[0]?.available).toBe(0);
    expect(strict[0]?.short).toBe(6);
  });

  it('says a code is not one of ours instead of inventing a figure for it', () => {
    const [line] = lines([job({ id: 'a', itemCode: 'ZZ9', qty: 6 })]);
    expect(line?.ours).toBe(false);
    expect(line?.available).toBe(0);
    expect(line?.covered).toBe(0);
    // The whole quantity stands as owed: the shop cannot point at anything, and it
    // has not been counted out of the pool either.
    expect(line?.short).toBe(6);
    expect(summariseJobs(lines([job({ id: 'a', itemCode: 'ZZ9', qty: 6 })])).unknownCodes).toBe(1);
  });

  it('does not try to cover a credit line', () => {
    const [credit] = lines([job({ id: 'c', qty: -3 })], { stockRows: [stockRow('GL4', 'HQ', 10)] });
    expect(credit?.covered).toBe(0);
    expect(credit?.short).toBe(0);
  });

  it('leaves out the ship-via the shop excludes, and can be told to show it', () => {
    const withRule = buildJobLines({
      jobs: [job({ id: 'a', shipVia: 'WILL CALL' }), job({ id: 'b', shipVia: 'DELIVER' })],
      products: [product()],
      stockRows: [],
      batches: [],
      stockCapturedAt: null,
      settings: settings({ excludedShipVia: ['WILL CALL'] }),
      now: NOW,
    });
    expect(withRule.find((l) => l.id === 'a')?.excluded).toBe(true);
    expect(filterJobLines(withRule, defaultJobFilter()).map((l) => l.id)).toEqual(['b']);
    expect(
      filterJobLines(withRule, { ...defaultJobFilter(), showExcluded: true }).map((l) => l.id),
    ).toEqual(['a', 'b']);
  });

  it('filters by words, by window and by what is still owed', () => {
    const board = lines([
      job({ id: 'a', customer: 'Bunnings', orderNo: 'SO-11', promisedDate: promised(2), qty: 8 }),
      job({ id: 'b', customer: 'Devonport', orderNo: 'SO-12', promisedDate: promised(-1), qty: 4 }),
      job({ id: 'c', customer: 'Bunnings', orderNo: 'SO-13', promisedDate: promised(30), qty: 6 }),
    ]);
    const f = defaultJobFilter();

    // Promise order: the late one is first, which is right — it is the one to ring about.
    expect(filterJobLines(board, f).map((l) => l.id)).toEqual(['b', 'a', 'c']);
    expect(filterJobLines(board, { ...f, window: 'past' }).map((l) => l.id)).toEqual(['b']);
    expect(filterJobLines(board, { ...f, window: 'week' }).map((l) => l.id)).toEqual(['a']);
    expect(filterJobLines(board, { ...f, query: 'devon' }).map((l) => l.id)).toEqual(['b']);
    expect(filterJobLines(board, { ...f, query: 'SO-13' }).map((l) => l.id)).toEqual(['c']);
    expect(filterJobLines(board, { ...f, query: 'karen' }).map((l) => l.id)).toHaveLength(3);
    // Nothing is covered because nothing was imported, so shortOnly keeps every line.
    expect(filterJobLines(board, { ...f, shortOnly: true })).toHaveLength(3);
    const covered = buildJobLines({
      jobs: [job({ id: 'a', promisedDate: promised(2), qty: 8 }), job({ id: 'c', promisedDate: promised(30), qty: 6 })],
      products: [product()],
      stockRows: [stockRow('GL4', 'HQ', 10)],
      batches: [],
      stockCapturedAt: null,
      settings: settings(),
      now: NOW,
    });
    expect(filterJobLines(covered, { ...f, shortOnly: true }).map((l) => l.id)).toEqual(['c']);
  });

  it('counts the day out for the header and the chips', () => {
    const board = buildJobLines({
      jobs: [
        job({ id: 'a', customer: 'Bunnings', promisedDate: promised(-2), qty: 8 }),
        job({ id: 'b', customer: 'Devonport', promisedDate: promised(3), qty: 5 }),
        job({ id: 'c', customer: 'Bunnings', itemCode: 'ZZ9', promisedDate: promised(4), qty: 2 }),
        job({ id: 'd', promisedDate: promised(14) + 20 * 365 * DAY, qty: 7 }),
      ],
      products: [product()],
      stockRows: [stockRow('GL4', 'HQ', 6)],
      batches: [],
      stockCapturedAt: null,
      settings: settings(),
      now: NOW,
    });
    const totals = summariseJobs(board);

    expect(totals.lines).toBe(4);
    expect(totals.open).toBe(3);
    expect(totals.pastDue).toBe(1);
    expect(totals.thisWeek).toBe(2);
    expect(totals.farFuture).toBe(1);
    expect(totals.unknownCodes).toBe(1);
    expect(totals.customers).toBe(2);
    expect(totals.codes).toBe(2);
    // The shelf had 6. `a`, the earliest promise, takes 6 and still needs 2; `b`
    // needs 5 with nothing left; `c` is not one of ours so all 2 of it stand.
    // `d` has a promise date the shop does not believe, so it is not in "owed".
    expect(board.find((l) => l.id === 'a')?.covered).toBe(6);
    expect(totals.shortLines).toBe(3);
    expect(totals.shortQty).toBe(9);
  });

  it('never lets a chip promise more than the filter will show', () => {
    const board = buildJobLines({
      jobs: [
        job({ id: 'a', promisedDate: promised(-2) }),
        job({ id: 'b', promisedDate: promised(3) }),
        job({ id: 'c', promisedDate: promised(11) }),
        job({ id: 'd', promisedDate: promised(40) }),
        job({ id: 'e', promisedDate: promised(4000) }),
      ],
      products: [product()],
      stockRows: [],
      batches: [],
      stockCapturedAt: null,
      settings: settings(),
      now: NOW,
    });
    const counts = windowCounts(board);
    const f = defaultJobFilter();

    for (const window of ['past', 'week', 'fortnight', 'all'] as const) {
      expect(filterJobLines(board, { ...f, window })).toHaveLength(counts[window]);
    }
    expect(counts.all).toBe(4); // the 4000-day line is beyond the planning horizon
    expect(counts.past).toBe(1);
    expect(counts.week).toBe(1);
    expect(counts.fortnight).toBe(2); // 3 days and 11 days; the late one is not "upcoming"
  });

  it('breaks one line’s cover down into the things a person can go and look at', () => {
    const board = buildJobLines({
      jobs: [job({ id: 'a', promisedDate: promised(2), qty: 20 })],
      products: [product()],
      stockRows: [stockRow('GL4', 'HQ', 4)],
      batches: [rack('GL4', 'curing', 6), rack('GL4', 'ready', 3)],
      stockCapturedAt: NOW - DAY,
      settings: settings(),
      now: NOW,
    });
    const line = board[0]!;
    const breakdown = coverBreakdown(product(), [stockRow('GL4', 'HQ', 4)], [rack('GL4', 'curing', 6), rack('GL4', 'ready', 3)], NOW - DAY, settings());

    expect(breakdown.ours).toBe(true);
    expect(breakdown.stock).toBe(4);
    expect(breakdown.curing).toBe(6);
    expect(breakdown.ready).toBe(3);
    expect(breakdown.available).toBe(line.available);
    // A code that is not ours has nothing to break down.
    expect(coverBreakdown(null, [], [], null, settings()).ours).toBe(false);
  });

  it('is the same answer every time it is asked', () => {
    const jobs = [job({ id: 'a', promisedDate: promised(2), qty: 8 }), job({ id: 'b', promisedDate: promised(2), orderNo: 'SO-2', qty: 8 })];
    const input = {
      jobs,
      products: [product()],
      stockRows: [stockRow('GL4', 'HQ', 10)],
      batches: [],
      stockCapturedAt: null,
      settings: settings(),
      now: NOW,
    };
    const first = buildJobLines(input);
    const second = buildJobLines(input);
    expect(first.map((l) => `${l.id}:${l.covered}:${l.short}`)).toEqual(second.map((l) => `${l.id}:${l.covered}:${l.short}`));
    // Same promised day: the order number decides who eats first.
    expect(first.find((l) => l.id === 'a')?.covered).toBe(8);
    expect(first.find((l) => l.id === 'b')?.covered).toBe(2);
  });
});
