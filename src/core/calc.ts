/**
 * The planning brain.
 *
 * Two rules here are load-bearing and were verified against the shop's own
 * spreadsheet, so they are stated plainly rather than buried:
 *
 * 1. MYOB holds baseline items as `actual + 10000`. Subtracting it can legitimately
 *    go NEGATIVE — M6 exports 9790.23 and really means -209.77 (oversold). The
 *    flag is a per-product setting because `>= 10000` cannot detect it: that rule
 *    would read M6 as 9790 m² of stock, wrong on exactly the short items.
 *
 * 2. Units On Hand is ALREADY net of the future jobs. Subtracting each day's jobs
 *    from stock again would double-count and flag every product as short. So
 *    "needs making" comes from the Target, exactly like `TO GET TO TARGET` in the
 *    sheet, and the day columns stay display detail.
 */

import { addDays, dayStart, nextWeekday } from './dates';
import { round } from './format';
import type {
  Batch,
  JobRow,
  Product,
  Settings,
  StockRow,
} from './types';

export const BASELINE_PHANTOM = 10_000;

/** Stages whose material exists but has not been keyed into MYOB yet. */
const OPEN_STAGES = new Set(['green', 'curing', 'awaiting_shotblast', 'blasting', 'ready']);

export type PlanningTone = 'neutral' | 'needsCuring' | 'short';

export interface ProductPosition {
  code: string;
  /** MYOB Units On Hand for the chosen locations, baseline removed. May be negative. */
  stockReal: number;
  curing: number;
  awaitingBlast: number;
  blasting: number;
  ready: number;
  /** Keyed into MYOB after the newest stock export, so not yet in `stockReal`. */
  enteredPendingExport: number;
  /** Everything made but not yet entered, whatever its stage. */
  openProduction: number;
  /** The sheet's `HQ STOCK INCL CURING & BLASTED` column. */
  inclCuringBlasted: number;
  /** The sheet's `TO GET TO TARGET` column. */
  toGetToTarget: number;
  tone: PlanningTone;
  /** True when on-hand is negative even before considering targets. */
  oversold: boolean;
}

/**
 * Sum the chosen locations, then remove the phantom once per product. The
 * phantom lives in the primary location's figure (HQ holds 11861.57 while GW
 * holds a plain 165.01), so subtracting once — not once per row — is what
 * matches the sheet.
 *
 * `rowsForProduct` must already be narrowed to ONE product code: this function
 * adds up every row it is given, so passing a whole snapshot would total the
 * entire company.
 */
export function stockOnHand(
  rowsForProduct: StockRow[],
  selectedLocations: string[],
  usesBaseline: boolean,
): number {
  const wanted = new Set(selectedLocations);
  let total = 0;
  let counted = 0;
  for (const row of rowsForProduct) {
    if (!wanted.has(row.location)) continue;
    total += row.qtyOnHandRaw;
    counted++;
  }
  if (counted === 0) return 0;
  return round(usesBaseline ? total - BASELINE_PHANTOM : total, 2);
}

export interface PositionInput {
  product: Product;
  /** Whole snapshot; rows are narrowed to this product's code here. */
  stockRows: StockRow[];
  batches: Batch[];
  /** capturedAt of the newest stock snapshot, or null when nothing imported. */
  stockCapturedAt: number | null;
  settings: Settings;
}

export function productPosition({
  product,
  stockRows,
  batches,
  stockCapturedAt,
  settings,
}: PositionInput): ProductPosition {
  const stockReal = stockOnHand(
    stockRows.filter((r) => r.code === product.code),
    settings.sources.stockLocations,
    product.usesBaseline10000,
  );

  let curing = 0;
  let awaitingBlast = 0;
  let blasting = 0;
  let ready = 0;
  let enteredPendingExport = 0;

  for (const b of batches) {
    if (b.code !== product.code || b.deleted) continue;
    if (b.stage === 'written_off') continue;

    if (b.stage === 'entered_myob') {
      // Counted back until the export actually reflects the keying, otherwise
      // stock is under-reported for the whole gap between entry and re-export.
      if (b.enteredAt != null && (stockCapturedAt == null || b.enteredAt > stockCapturedAt)) {
        enteredPendingExport += b.qty;
      }
      continue;
    }
    if (!OPEN_STAGES.has(b.stage)) continue;

    switch (b.stage) {
      case 'green':
      case 'curing':
        curing += b.qty;
        break;
      case 'awaiting_shotblast':
        awaitingBlast += b.qty;
        break;
      case 'blasting':
        blasting += b.qty;
        break;
      case 'ready':
        ready += b.qty;
        break;
    }
  }

  const openProduction = round(curing + awaitingBlast + blasting + ready, 4);
  const countsReady = settings.sources.countsReadyAsAvailable;
  const inclCuringBlasted = round(
    stockReal + openProduction + enteredPendingExport - (countsReady ? 0 : ready),
    2,
  );

  const toGetToTarget = product.target > 0 ? round(Math.max(0, product.target - inclCuringBlasted), 2) : 0;

  let tone: PlanningTone = 'neutral';
  if (product.target > 0) {
    if (stockReal >= product.target) tone = 'neutral';
    else if (inclCuringBlasted >= product.target) tone = 'needsCuring';
    else tone = 'short';
  }

  return {
    code: product.code,
    stockReal,
    curing: round(curing, 2),
    awaitingBlast: round(awaitingBlast, 2),
    blasting: round(blasting, 2),
    ready: round(ready, 2),
    enteredPendingExport: round(enteredPendingExport, 2),
    openProduction,
    inclCuringBlasted,
    toGetToTarget,
    tone,
    oversold: stockReal < 0,
  };
}

/* ── Availability for sale (MYOB entry list, schedule) ─────────────────────── */

/**
 * When a batch may be treated as sellable.
 *
 * Shotblast route: blasting makes it ready — and blasting may happen while the
 * piece is still curing ("make - shotblast - ready. it can be shotblast during
 * curing"). Manufacture-only route: the cure period is the gate.
 */
export function readyAt(batch: Batch, settings: Settings, now = Date.now()): number | null {
  const cureDoneAt = batch.cureDueAt;
  if (batch.routeSnapshot === 'shotblast') {
    if (batch.blastedAt != null && batch.blastedQty >= batch.qty - 1e-6) {
      return settings.production.blastingCompletesCure
        ? batch.blastedAt
        : Math.max(batch.blastedAt, cureDoneAt);
    }
    return null;
  }
  return now >= cureDoneAt ? Math.max(cureDoneAt, batch.madeAt) : null;
}

export function isCureComplete(batch: Batch, now = Date.now()): boolean {
  return now >= batch.cureDueAt;
}

/**
 * Which weekly MYOB run a ready batch belongs to. Anything becoming ready after
 * the cut-off on that weekday rolls to the following week.
 */
export function assignMyobRunDate(readyMs: number, settings: Settings): number {
  const { entryWeekday, cutoffHours } = settings.myobEntry;
  const candidate = nextWeekday(readyMs, entryWeekday);
  const cutoff = candidate + cutoffHours * 3_600_000;
  return readyMs > cutoff ? addDays(candidate, 7) : candidate;
}

/** Latest date a make can start and still land on the promised date. */
export function latestStartDate(
  promisedDate: number,
  product: Product,
  settings: Settings,
): number {
  const lead =
    product.cureDays +
    (product.route === 'shotblast' ? settings.planning.blastHandlingDays : 0) +
    settings.planning.bufferDays;
  return addDays(dayStart(promisedDate), -lead);
}

export function isLate(
  promisedDate: number,
  product: Product,
  settings: Settings,
  now = Date.now(),
): boolean {
  return now > latestStartDate(promisedDate, product, settings);
}

/* ── Demand shaping ────────────────────────────────────────────────────────── */

/**
 * True for rows that must not drive near-term planning: the placeholder year
 * seen in the export (`4/04/2040` on 475 of 1553 lines) and anything beyond the
 * configured far-future window.
 */
export function isFarFuture(
  promisedDate: number,
  settings: Settings,
  now = Date.now(),
): boolean {
  const year = new Date(promisedDate).getFullYear();
  if (settings.planning.placeholderYears.includes(year)) return true;
  const horizon = new Date(now);
  horizon.setMonth(horizon.getMonth() + settings.planning.farFutureMonths);
  return promisedDate > horizon.getTime();
}

export function isExcludedJob(job: JobRow, settings: Settings): boolean {
  return settings.sources.excludedShipVia.includes(job.shipVia);
}

/** Net near-term demand per product, credits clamped at zero and reported apart. */
export function demandByProduct(
  jobs: JobRow[],
  settings: Settings,
  now = Date.now(),
): Map<string, { demand: number; credits: number; lines: number; earliest: number | null }> {
  const out = new Map<string, { demand: number; credits: number; lines: number; earliest: number | null }>();
  for (const job of jobs) {
    if (isExcludedJob(job, settings) || isFarFuture(job.promisedDate, settings, now)) continue;
    const cur = out.get(job.itemCode) ?? { demand: 0, credits: 0, lines: 0, earliest: null };
    if (job.qty >= 0) cur.demand += job.qty;
    else cur.credits += job.qty;
    cur.lines++;
    if (cur.earliest == null || job.promisedDate < cur.earliest) cur.earliest = job.promisedDate;
    out.set(job.itemCode, cur);
  }
  for (const v of out.values()) {
    v.demand = round(Math.max(0, v.demand + v.credits), 2);
    v.credits = round(v.credits, 2);
  }
  return out;
}

/** Sum of open job qty per (code, day) — the matrix cell value. */
export function demandByCodeAndDay(jobs: JobRow[], settings: Settings): Map<string, Map<number, number>> {
  const out = new Map<string, Map<number, number>>();
  for (const job of jobs) {
    if (isExcludedJob(job, settings)) continue;
    const day = dayStart(job.promisedDate);
    const byDay = out.get(job.itemCode) ?? new Map<number, number>();
    byDay.set(day, round((byDay.get(day) ?? 0) + job.qty, 4));
    out.set(job.itemCode, byDay);
  }
  return out;
}

/* ── Tray conversion ───────────────────────────────────────────────────────── */

export interface TrayConversion {
  trays: number;
  qty: number;
  yieldPerTray: number;
}

/** Trays are what the floor counts; qty is what MYOB wants. */
export function qtyFromTrays(trays: number, trayYield: number): number {
  if (!Number.isFinite(trays) || !Number.isFinite(trayYield)) return 0;
  return round(trays * trayYield, 3);
}

export function traysFromQty(qty: number, trayYield: number): number {
  if (!Number.isFinite(qty) || !trayYield) return 0;
  return round(qty / trayYield, 3);
}

/* ── Rank management (drag-and-drop order) ─────────────────────────────────── */

/**
 * Midpoint insert keeps a drag to a single record write. When neighbours get too
 * close for another float, callers rebalance the list with `resequence`.
 */
export function rankBetween(before: number | null, after: number | null): number {
  if (before == null && after == null) return 1000;
  if (before == null) return after! - 1000;
  if (after == null) return before + 1000;
  return (before + after) / 2;
}

export function needsResequence(ranks: number[], epsilon = 1e-6): boolean {
  const sorted = [...ranks].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    if ((sorted[i] ?? 0) - (sorted[i - 1] ?? 0) < epsilon) return true;
  }
  return false;
}

export function resequence(count: number, step = 1000): number[] {
  return Array.from({ length: count }, (_, i) => (i + 1) * step);
}
