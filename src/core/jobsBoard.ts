import type { Batch, JobRow, Product, ProductUnit, Settings, StockRow } from '@/core/types';
import { isExcludedJob, isFarFuture, productPosition } from '@/core/calc';
import { isCurrentProduct } from '@/core/currentRange';
import { dayStart, diffDays } from '@/core/dates';
import { round } from '@/core/format';

/**
 * The order book: every open sales-order line, and what the shop can already
 * point at for it.
 *
 * The export says what was *sold*. It does not say whether the thing is standing
 * in the yard, so a list of jobs on its own leaves the owner doing the sum in his
 * head while a customer is on the phone. This module does the sum once, the same
 * way `productPosition` counts availability everywhere else in the app — stock on
 * hand, plus what is being made, plus what has been keyed into MYOB and not yet
 * come back out of an export.
 *
 * **This screen does not filter by the current range, on purpose.** The tick on
 * Products answers *what we plan to make*; an order line answers *what we have
 * already sold*, and the two are not the same list — the book holds 414 open lines
 * while 134 codes are ticked. Hiding a line because its code is unticked would make
 * most of the shop's obligations vanish from the one screen whose job is to show
 * them, so every line stays and the ones outside the range are **marked** instead
 * (`current`, and the `notCurrent` / `outsideRange` counts). That is the same
 * treatment the screen already gave a code it did not recognise, which is why the
 * existing `ours` rule was extended rather than a second kind of "unknown" invented
 * beside it. Planning screens — the Matrix and the plan — filter; this one annotates.
 *
 * The one real decision here is **allocation**. Stock and in-progress work belong
 * to a code, not to an order line, and the same code is usually promised to three
 * customers on three different days. Whoever reads this list needs to know which
 * line the pallet in the yard answers, so the pool is handed out in promised-date
 * order: the earliest promise is covered first, and a later promise cannot eat the
 * same pallet twice. That is a rule, not a fact from MYOB, and the screen says so.
 */

/** How near the screen is looking. */
export type JobWindow = 'past' | 'week' | 'fortnight' | 'all';

export const JOB_WINDOWS: Array<{ key: JobWindow; label: string; hint: string }> = [
  { key: 'past', label: 'Past due', hint: 'Promised already and still open. These are the ones the phone rings about.' },
  { key: 'week', label: 'This week', hint: 'Promised within the next seven days, today included.' },
  { key: 'fortnight', label: 'Next fortnight', hint: 'Promised within the next fourteen days, today included.' },
  { key: 'all', label: 'Everything', hint: 'Every open line with a promise date the shop believes.' },
];

export interface JobLineView extends JobRow {
  /** Whole calendar days from today to the promise. Negative means it is late. */
  daysToGo: number;
  /** Promised before today, and still open. */
  pastDue: boolean;
  /** A promise date the shop does not believe — a placeholder year, or beyond the planning horizon. */
  farFuture: boolean;
  /** On a ship-via the shop leaves out of demand everywhere else in the app. */
  excluded: boolean;
  /** The code is one of ours on this device, so the cover figures mean anything. */
  ours: boolean;
  /**
   * The code is in the current range — ours **and** ticked on Products.
   *
   * `ours` and `current` are different questions and are kept apart deliberately: a
   * code the device has never seen has no cover figures to compare against, while a
   * code it knows with the tick off has perfectly good figures and simply is not
   * something we plan to make again. Both read the same way on the board — outside
   * the current range — and neither hides the line.
   */
  current: boolean;
  unit: ProductUnit | null;
  /** What the whole shop can point at for this code: stock, work in progress, keyed-not-yet-exported. */
  available: number;
  /** What *this line* can point at, after earlier promises took their share. */
  covered: number;
  /** What this line still needs. Never negative. */
  short: number;
}

export interface JobBoardInput {
  jobs: JobRow[];
  /** All products on the device; only the ones a job names are looked at. */
  products: Product[];
  /** Whole stock snapshot rows, or an empty array when nothing has been imported. */
  stockRows: StockRow[];
  /** Every batch on the device, whatever its stage; `productPosition` filters. */
  batches: Batch[];
  stockCapturedAt: number | null;
  settings: Settings;
  now?: number;
}

/**
 * Turn the export into lines a person can act on.
 *
 * Cover is worked out per code in one pass: the codes that appear in the jobs are
 * bucketed first, so `productPosition` — which scans whatever it is handed — gets
 * only its own rows instead of the whole company for every single code.
 */
export function buildJobLines(input: JobBoardInput): JobLineView[] {
  const now = input.now ?? Date.now();
  const today = dayStart(now);
  const byCode = new Map<string, Product>();
  for (const p of input.products) byCode.set(p.code, p);

  // Bucket once. A year of stock rows times six hundred codes is a pause a person
  // would notice on a tablet, and it is the same work done over and over.
  const stockBucket = bucket(input.stockRows);
  const batchBucket = bucket(input.batches);

  const base: JobLineView[] = [];
  const pool = new Map<string, { available: number; left: number }>();

  for (const job of input.jobs) {
    const product = byCode.get(job.itemCode) ?? null;
    let available = 0;
    if (product && !product.deleted) {
      const known = pool.get(job.itemCode);
      if (known) {
        available = known.available;
      } else {
        const pos = productPosition({
          product,
          // Narrowed above: productPosition filters by code, and its own bucket
          // already is that code, so the filter becomes a no-op.
          stockRows: stockBucket.get(job.itemCode) ?? [],
          batches: batchBucket.get(job.itemCode) ?? [],
          stockCapturedAt: input.stockCapturedAt,
          settings: input.settings,
        });
        available = pos.inclCuringBlasted;
        pool.set(job.itemCode, { available, left: available });
      }
    }

    const promised = job.promisedDate;
    base.push({
      ...job,
      daysToGo: diffDays(today, dayStart(promised)),
      pastDue: false,
      farFuture: isFarFuture(promised, input.settings, now),
      excluded: isExcludedJob(job, input.settings),
      ours: product !== null && !product.deleted,
      current: isCurrentProduct(product),
      unit: product && !product.deleted ? product.unit : null,
      available: round(available, 2),
      covered: 0,
      short: 0,
    });
  }

  // Promise order, then the export's own order number so two lines promised the
  // same day keep the order a person reading the sheet would expect. Undated lines
  // sort last, which is the point: a promise the export has never dated must not eat
  // the pallet a customer is actually waiting for. The list comes back in this order,
  // so a screen that shows it untouched shows the order a person would work it.
  const byPromised = [...base].sort(
    (a, b) => a.promisedDate - b.promisedDate || a.orderNo.localeCompare(b.orderNo) || a.id.localeCompare(b.id),
  );

  const out: JobLineView[] = [];
  for (const line of byPromised) {
    const share = line.ours ? pool.get(line.itemCode) : undefined;
    let covered = 0;
    let short = Math.max(0, line.qty);
    if (share && line.qty > 0) {
      covered = Math.min(share.left, line.qty);
      share.left = round(share.left - covered, 4);
      short = round(line.qty - covered, 4);
    }
    out.push({
      ...line,
      pastDue: !line.farFuture && line.daysToGo < 0,
      covered: round(covered, 2),
      short: line.qty > 0 ? short : 0,
    });
  }
  return out;
}

function bucket<T extends { code: string }>(rows: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const list = out.get(row.code);
    if (list) list.push(row);
    else out.set(row.code, [row]);
  }
  return out;
}

export interface JobFilter {
  window: JobWindow;
  query: string;
  /** Only the lines the shop cannot cover from what it has and is making. */
  shortOnly: boolean;
  /** Include lines whose promise date is a placeholder or beyond the horizon. */
  showFarFuture: boolean;
  /** One ship-via the shop left in, when it wants to see the ones it usually excludes. */
  showExcluded: boolean;
}

export function defaultJobFilter(): JobFilter {
  return { window: 'all', query: '', shortOnly: false, showFarFuture: false, showExcluded: false };
}

/** What a window means for one line. Exported so the counts on the chips cannot drift from the rows. */
export function inWindow(line: JobLineView, window: JobWindow): boolean {
  if (line.farFuture) return window === 'all';
  switch (window) {
    case 'past':
      return line.daysToGo < 0;
    case 'week':
      return line.daysToGo >= 0 && line.daysToGo <= 7;
    case 'fortnight':
      return line.daysToGo >= 0 && line.daysToGo <= 14;
    case 'all':
      return true;
  }
}

export function filterJobLines(lines: JobLineView[], filter: JobFilter): JobLineView[] {
  const query = filter.query.trim().toLowerCase();
  const out: JobLineView[] = [];
  for (const line of lines) {
    if (line.farFuture && !filter.showFarFuture) continue;
    if (line.excluded && !filter.showExcluded) continue;
    if (!inWindow(line, filter.window)) continue;
    if (filter.shortOnly && line.short <= 0) continue;
    if (query !== '') {
      const haystack = `${line.itemCode} ${line.itemDescription} ${line.customer} ${line.orderNo} ${line.salesperson} ${line.shipVia}`;
      if (!haystack.toLowerCase().includes(query)) continue;
    }
    out.push(line);
  }
  return out;
}

export interface JobTotals {
  /** Lines on the device at all, whatever their dates. */
  lines: number;
  /** Open lines with a promise date the shop believes. */
  open: number;
  pastDue: number;
  thisWeek: number;
  /**
   * Open lines still needing something after the shop's own stock and work in
   * progress. Lines with a promise date the shop does not believe are left out —
   * they are counted under `farFuture`, because mixing an order that has never been
   * dated into "what we owe this month" makes the number meaningless.
   */
  shortLines: number;
  shortQty: number;
  /** Lines with a placeholder or beyond-horizon promise date. */
  farFuture: number;
  /** Lines whose code is not one of ours — no cover figures for those. */
  unknownCodes: number;
  /** Lines whose code is ours but has the tick off: sold, and not in the current range. */
  notCurrent: number;
  /**
   * Lines outside the current range, for either reason — the number the footer quotes.
   *
   * Kept as its own count rather than left for the screen to add, so the sentence
   * under the table cannot end up summing a slightly different pair of things from
   * the two chips beside it.
   */
  outsideRange: number;
  /** Lines on a ship-via the shop leaves out of demand. */
  excluded: number;
  /** Distinct customers, so the header can say what "1,553 lines" is spread over. */
  customers: number;
  codes: number;
}

export function summariseJobs(lines: JobLineView[]): JobTotals {
  const totals: JobTotals = {
    lines: lines.length,
    open: 0,
    pastDue: 0,
    thisWeek: 0,
    shortLines: 0,
    shortQty: 0,
    farFuture: 0,
    unknownCodes: 0,
    notCurrent: 0,
    outsideRange: 0,
    excluded: 0,
    customers: 0,
    codes: 0,
  };
  const customers = new Set<string>();
  const codes = new Set<string>();
  for (const line of lines) {
    if (line.farFuture) totals.farFuture += 1;
    else {
      totals.open += 1;
      if (line.daysToGo < 0) totals.pastDue += 1;
      if (line.daysToGo >= 0 && line.daysToGo <= 7) totals.thisWeek += 1;
    }
    if (line.excluded) totals.excluded += 1;
    if (!line.ours) totals.unknownCodes += 1;
    else if (!line.current) totals.notCurrent += 1;
    if (!line.current) totals.outsideRange += 1;
    if (line.short > 0 && !line.farFuture) {
      totals.shortLines += 1;
      totals.shortQty = round(totals.shortQty + line.short, 2);
    }
    if (line.customer.trim() !== '') customers.add(line.customer.trim());
    codes.add(line.itemCode);
  }
  totals.customers = customers.size;
  totals.codes = codes.size;
  return totals;
}

/** Counts for the window chips, so a chip can never promise rows the filter will not show. */
export function windowCounts(lines: JobLineView[]): Record<JobWindow, number> {
  const out: Record<JobWindow, number> = { past: 0, week: 0, fortnight: 0, all: 0 };
  for (const line of lines) {
    if (line.farFuture) continue;
    if (inWindow(line, 'past')) out.past += 1;
    if (inWindow(line, 'week')) out.week += 1;
    if (inWindow(line, 'fortnight')) out.fortnight += 1;
    out.all += 1;
  }
  return out;
}

/** What one line's cover is made of, for the panel that opens when a row is pressed. */
export interface CoverBreakdown {
  /** Whether the code is ours; when it is not, there is nothing honest to break down. */
  ours: boolean;
  stock: number;
  curing: number;
  awaitingBlast: number;
  blasting: number;
  ready: number;
  countedReady: boolean;
  keyedNotExported: number;
  available: number;
}

export function coverBreakdown(
  product: Product | null,
  stockRows: StockRow[],
  batches: Batch[],
  stockCapturedAt: number | null,
  settings: Settings,
): CoverBreakdown {
  const empty: CoverBreakdown = {
    ours: false,
    stock: 0,
    curing: 0,
    awaitingBlast: 0,
    blasting: 0,
    ready: 0,
    countedReady: settings.sources.countsReadyAsAvailable,
    keyedNotExported: 0,
    available: 0,
  };
  if (product === null || product.deleted) return empty;
  const pos = productPosition({
    product,
    stockRows: stockRows.filter((r) => r.code === product.code),
    batches: batches.filter((b) => b.code === product.code),
    stockCapturedAt,
    settings,
  });
  return {
    ours: true,
    stock: pos.stockReal,
    curing: pos.curing,
    awaitingBlast: pos.awaitingBlast,
    blasting: pos.blasting,
    ready: pos.ready,
    countedReady: settings.sources.countsReadyAsAvailable,
    keyedNotExported: pos.enteredPendingExport,
    available: pos.inclCuringBlasted,
  };
}
