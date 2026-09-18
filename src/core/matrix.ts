/**
 * The matrix: product against day.
 *
 * This is the board the whole app is named after, so the two rules the sheet was
 * verified against are worth restating here rather than trusting a reader to have
 * read them in `calc.ts`:
 *
 * 1. **Units On Hand from MYOB is already net of the open jobs.** Day columns are
 *    therefore a *display* of what is promised when — they are not a second
 *    subtraction from stock. A cell that said "stock minus everything promised up
 *    to here" would flag every product in the shop as short, which is the mistake
 *    the sheet does not make and this file must not either. `test/core.matrix.test.ts`
 *    pins that: the same demand appears in a cell and is *not* deducted again.
 *
 * 2. **Whether a product needs making comes from its target** (`toGetToTarget`, the
 *    sheet's `TO GET TO TARGET`), and the colouring follows it: red when on-hand is
 *    under target and staying under it, green when on-hand is under target but the
 *    material already curing or being blasted closes the gap. So the colour of a day
 *    cell answers "is this product a problem", and the number in it answers "how
 *    much of the problem is promised on this day".
 *
 * The third thing a cell says is the one nobody can read off a total: `late`. A day
 * whose promise date has already passed the last date a make could have started is
 * too late to fix by starting today, whatever the stock figures say. That is a fact
 * about the calendar and the product's cure time, so it is computed from
 * `latestStartDate` and nothing else.
 */
import {
  isExcludedJob,
  isFarFuture,
  latestStartDate,
  productPosition,
  type PlanningTone,
} from '@/core/calc';
import { addDays, dayStart } from '@/core/dates';
import { round } from '@/core/format';
import type {
  Batch,
  JobRow,
  Product,
  ProductRoute,
  Settings,
  StockRow,
} from '@/core/types';

/* ── The horizon ───────────────────────────────────────────────────────────── */

/** The widths the plan calls for: a week, a fortnight, a month, six weeks. */
export const HORIZONS = [1, 2, 4, 6] as const;
export type Horizon = (typeof HORIZONS)[number];

export function isHorizon(value: unknown): value is Horizon {
  return typeof value === 'number' && (HORIZONS as readonly unknown[]).includes(value);
}

export interface MatrixDay {
  /** Midnight on the day, local time — the same key the job rows are bucketed by. */
  day: number;
  /** Saturday and Sunday carry no production but can carry a promise date. */
  weekend: boolean;
  /** Today, the first column. Marked so the header can say "today". */
  today: boolean;
}

/**
 * The key a day column carries on the board.
 *
 * One function says it, because the same string is written into a person's saved
 * view — the short list a phone shows is matched against it key for key. Two places
 * spelling it out is how a phone ends up with a board that has no days on it, and
 * the day `2026-09-18` is not the column `d1758153600000`.
 */
export function matrixDayKey(day: number): string {
  return `d${day}`;
}

/**
 * Every day from today for `weeks` weeks. Every calendar day, not just working
 * days: a promise date on a Saturday is a fact about a truck, and dropping the
 * column would drop the demand with it.
 */
export function matrixDays(weeks: Horizon, from = Date.now()): MatrixDay[] {
  const first = dayStart(from);
  const out: MatrixDay[] = [];
  for (let i = 0; i < weeks * 7; i++) {
    const day = addDays(first, i);
    const dow = new Date(day).getDay();
    out.push({ day, weekend: dow === 0 || dow === 6, today: i === 0 });
  }
  return out;
}

/* ── Rows ──────────────────────────────────────────────────────────────────── */

export interface MatrixCell {
  /** Lines promised that day, before credits. */
  gross: number;
  /** Returns and credits on the same day, negative. */
  credits: number;
  /** Job lines behind the figure, so a cell can say "3 jobs" without opening it. */
  lines: number;
  /** The latest date a make could start and still land on this day has passed. */
  late: boolean;
}

export interface MatrixRow {
  code: string;
  description: string;
  unit: string;
  route: ProductRoute;
  rank: number;
  target: number;
  /** MYOB on-hand for the chosen locations, phantom removed. May be negative. */
  stockReal: number;
  inclCuringBlasted: number;
  toGetToTarget: number;
  curing: number;
  awaitingBlast: number;
  blasting: number;
  ready: number;
  tone: PlanningTone;
  oversold: boolean;
  /** Net demand inside the horizon, in the product's unit. */
  due: number;
  /** Net demand promised after the horizon, placeholder dates excluded. */
  beyond: number;
  beyondLines: number;
  /** Keyed by `dayStart`; a day with nothing promised has no entry at all. */
  cells: Map<number, MatrixCell>;
}

export interface MatrixInput {
  products: Product[];
  jobs: JobRow[];
  stockRows: StockRow[];
  batches: Batch[];
  stockCapturedAt: number | null;
  settings: Settings;
  days: MatrixDay[];
  now?: number;
}

/**
 * One row per product: where it stands, and what is promised of it on each day.
 *
 * Every job shaping rule is the one the rest of the app uses — `isExcludedJob` for
 * Ship-Via values that are not demand, `isFarFuture` for the placeholder year and
 * the far-future window — because a board that quietly counts a different set of
 * jobs to the Jobs screen is worse than no board.
 */
export function matrixRows({
  products,
  jobs,
  stockRows,
  batches,
  stockCapturedAt,
  settings,
  days,
  now = Date.now(),
}: MatrixInput): MatrixRow[] {
  const today = dayStart(now);
  const lastDay = days.length > 0 ? (days[days.length - 1]?.day ?? today) : today;
  const wanted = new Set(days.map((d) => d.day));

  // One pass over the export, bucketed per product per day. Done here rather than
  // per product so a 2,000-line export is walked once for the whole board.
  const shaped = new Map<
    string,
    { cells: Map<number, { gross: number; credits: number; lines: number }>; beyond: number; beyondLines: number }
  >();

  for (const job of jobs) {
    if (isExcludedJob(job, settings)) continue;
    const day = dayStart(job.promisedDate);
    const entry = shaped.get(job.itemCode) ?? {
      cells: new Map<number, { gross: number; credits: number; lines: number }>(),
      beyond: 0,
      beyondLines: 0,
    };
    if (wanted.has(day)) {
      const cell = entry.cells.get(day) ?? { gross: 0, credits: 0, lines: 0 };
      if (job.qty >= 0) cell.gross += job.qty;
      else cell.credits += job.qty;
      cell.lines += 1;
      entry.cells.set(day, cell);
    } else if (day > lastDay && !isFarFuture(job.promisedDate, settings, now)) {
      // The overflow figure only ever counts demand that is real and dated.
      entry.beyond += job.qty;
      entry.beyondLines += 1;
    }
    shaped.set(job.itemCode, entry);
  }

  return products.map((product) => {
    const position = productPosition({
      product,
      stockRows,
      batches,
      stockCapturedAt,
      settings,
    });

    const shapedForCode = shaped.get(product.code);
    const cells = new Map<number, MatrixCell>();
    let due = 0;
    if (shapedForCode) {
      for (const [day, cell] of shapedForCode.cells) {
        const net = round(cell.gross + cell.credits, 4);
        due += net;
        cells.set(day, {
          gross: round(cell.gross, 4),
          credits: round(cell.credits, 4),
          lines: cell.lines,
          // Unknown route means unknown cure time, which means no honest answer —
          // so no dot. The Products screen is where that gets fixed.
          late:
            product.route !== 'unset' &&
            net > 0 &&
            latestStartDate(day, product, settings) < today,
        });
      }
    }

    return {
      code: product.code,
      description: product.description,
      unit: product.unit,
      route: product.route,
      rank: product.rank,
      target: product.target,
      stockReal: position.stockReal,
      inclCuringBlasted: position.inclCuringBlasted,
      toGetToTarget: position.toGetToTarget,
      curing: position.curing,
      awaitingBlast: position.awaitingBlast,
      blasting: position.blasting,
      ready: position.ready,
      tone: position.tone,
      oversold: position.oversold,
      due: round(due, 4),
      beyond: round(shapedForCode?.beyond ?? 0, 4),
      beyondLines: shapedForCode?.beyondLines ?? 0,
      cells,
    };
  });
}

/**
 * The job lines behind one cell, in promise order. The popup reads the same
 * filters as the numbers, so what it lists always adds up to the cell.
 */
export function cellLines(jobs: JobRow[], code: string, day: number, settings: Settings): JobRow[] {
  return jobs
    .filter((j) => j.itemCode === code && !isExcludedJob(j, settings) && dayStart(j.promisedDate) === day)
    .sort((a, b) => b.qty - a.qty || a.customer.localeCompare(b.customer));
}

/** How far a promise date is from today, in the words a floor uses. */
export function dueIn(day: number, now = Date.now()): string {
  const days = Math.round((dayStart(day) - dayStart(now)) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}
