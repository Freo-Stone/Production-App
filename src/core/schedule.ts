import type { JobLineView } from '@/core/jobsBoard';
import type { PlanItem, Product, ProductRoute, ProductUnit, Settings } from '@/core/types';
import { latestStartDate, traysFromQty } from '@/core/calc';
import { dayStart, diffDays } from '@/core/dates';
import { round } from '@/core/format';

/**
 * The plan: what has to be made, how much, and the latest day it can start.
 *
 * The order book (`jobsBoard`) answers *what do we owe*. This answers the next
 * question — *so what do we have to make, and when* — and it starts from exactly
 * the same numbers: the shortfalls it works on are the ones `buildJobLines`
 * produced, so the two screens cannot disagree about what is owed.
 *
 * Two things make a row, and they are deliberately told apart:
 *
 * - **A promise with nothing behind it** (`origin: 'gap'`). The book says this code
 *   is short for a promise on this day, and nothing has been written down to make
 *   it. The shop can put it on the plan with one press.
 * - **Something the shop has already planned** (`origin: 'plan'`). A `PlanItem` this
 *   device holds, with its quantity, its route and the order lines it was written
 *   for.
 *
 * **How a plan item is matched to promises.** A plan item says how much it makes,
 * and often not which order it is for. Where it names order lines, those come
 * first — that is an explicit statement from the shop, and it overrides the default
 * rule. Everything else is covered the way the order book covers stock: earliest
 * promise first, so two plan items cannot both claim to answer the same promise.
 * What a plan item makes beyond the promises it answers is reported as `surplus`
 * rather than trimmed away: a plan that over-makes is information, not a rounding
 * error.
 *
 * The date a make has to start by is not invented here. It is
 * `calc.latestStartDate` — promise date less the cure, less the blasting handling
 * days for a shotblast route, less the shop's planning buffer — the same arithmetic
 * the Matrix tones use, so "behind" means the same thing on both screens.
 */

/** Which pile a row sits in, and the only way the screen filters. */
export type PlanBucket = 'behind' | 'week' | 'later' | 'making' | 'undated' | 'all';

export const PLAN_BUCKETS: Array<{ key: PlanBucket; label: string; hint: string }> = [
  {
    key: 'behind',
    label: 'Already behind',
    hint: 'The day this make had to start has gone. It will not land on its promise date unless something gives.',
  },
  {
    key: 'week',
    label: 'Start this week',
    hint: 'Has to start within the next seven days, today included, to reach its promise date.',
  },
  {
    key: 'later',
    label: 'Later',
    hint: 'Not yet due to start. On the plan, but not this week.',
  },
  {
    key: 'making',
    label: 'Being made',
    hint: 'Marked started. The order book counts the racks against the promise as soon as they are logged.',
  },
  {
    key: 'undated',
    label: 'No start date',
    hint: 'Nothing to work a lead time from — a promise the export never dated, or a code that is not one of ours.',
  },
  { key: 'all', label: 'Everything', hint: 'Every row on the plan, whatever its date.' },
];

/** Whether this row is something the shop wrote down, or a promise with nothing behind it. */
export type ScheduleOrigin = 'plan' | 'gap';

export interface ScheduleLine {
  /** A plan item's own id, or the gap's code and promise day. Stable while the data is. */
  id: string;
  origin: ScheduleOrigin;
  code: string;
  description: string;
  /** The code is a product on this device, so the lead time and the route mean anything. */
  ours: boolean;
  unit: ProductUnit | null;
  /** How much this row has to make, in the item's own unit. */
  qty: number;
  /** The same quantity in trays, when the product's tray yield makes it possible. */
  trays: number | null;
  /** The earliest promise this row answers. */
  promisedFor: number | null;
  /** The latest day the making can start, from `calc.latestStartDate`. */
  latestStart: number | null;
  /** Whole days from today to that day. Negative means the day has gone. */
  daysToStart: number | null;
  behind: boolean;
  bucket: PlanBucket;
  route: Exclude<ProductRoute, 'unset'> | null;
  /** The plan item's status. A gap has none until the shop plans it. */
  status: PlanItem['status'] | null;
  /** The plan item behind this row, for the screen to edit or cancel. */
  plan: PlanItem | null;
  /** The order lines this row answers. */
  jobIds: string[];
  /** Who is waiting, without repeating a customer with several lines. */
  customers: string[];
  /** Plan quantity left over after the promises it answers. Never trimmed away. */
  surplus: number;
  /** Why the row reads the way it does — said in words, on the row. */
  note: string;
  rank: number;
}

export interface ScheduleInput {
  /** Every analysed order line, from `buildJobLines`. */
  lines: JobLineView[];
  /** Every plan item on the device, including cancelled and deleted ones. */
  planItems: PlanItem[];
  products: Product[];
  settings: Settings;
  now?: number;
}

const EPSILON = 1e-9;

type Route = Exclude<ProductRoute, 'unset'>;

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

function earliest(...dates: Array<number | null>): number | null {
  let out: number | null = null;
  for (const date of dates) if (date !== null && (out === null || date < out)) out = date;
  return out;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

/** Plan items for one code, in the order they get first claim on a promise. */
function bySoonestPromise(items: PlanItem[]): PlanItem[] {
  return [...items].sort((a, b) => {
    const ad = a.promisedFor ?? a.latestStartDate ?? Number.MAX_SAFE_INTEGER;
    const bd = b.promisedFor ?? b.latestStartDate ?? Number.MAX_SAFE_INTEGER;
    if (ad !== bd) return ad - bd;
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function bucketOf(
  status: PlanItem['status'] | null,
  latestStart: number | null,
  today: number,
): PlanBucket {
  if (status === 'started') return 'making';
  if (latestStart === null) return 'undated';
  const days = diffDays(today, latestStart);
  if (days < 0) return 'behind';
  return days <= 6 ? 'week' : 'later';
}

function traysFor(qty: number, product: Product | null): number | null {
  if (product === null || product.trayYield <= 0) return null;
  return round(traysFromQty(qty, product.trayYield), 2);
}

function startFor(promisedFor: number | null, product: Product | null, settings: Settings): number | null {
  if (promisedFor === null || product === null) return null;
  return latestStartDate(promisedFor, product, settings);
}

function view(
  base: {
    id: string;
    origin: ScheduleOrigin;
    code: string;
    description: string;
    ours: boolean;
    unit: ProductUnit | null;
    qty: number;
    promisedFor: number | null;
    latestStart: number | null;
    route: Route | null;
    status: PlanItem['status'] | null;
    plan: PlanItem | null;
    jobIds: string[];
    customers: string[];
    surplus: number;
    note: string;
    rank: number;
  },
  product: Product | null,
  today: number,
): ScheduleLine {
  const daysToStart = base.latestStart === null ? null : diffDays(today, base.latestStart);
  const bucket = bucketOf(base.status, base.latestStart, today);
  return {
    ...base,
    trays: traysFor(base.qty, product),
    daysToStart,
    behind: daysToStart !== null && daysToStart < 0,
    bucket,
  };
}

/**
 * The plan as it stands: one row per planned make, and one row per promise that
 * nothing has been planned against yet.
 *
 * The order of the rows is the order a person reads them in: the ones already
 * behind first, then by the day the making has to start, with undated rows last
 * because there is nothing to act on today about them.
 */
export function buildSchedule(input: ScheduleInput): ScheduleLine[] {
  const now = input.now ?? Date.now();
  const today = dayStart(now);
  const products = new Map(input.products.map((p) => [p.code, p]));

  // What the shop has already written down, per code, minus anything cancelled.
  const plannedByCode = new Map<string, PlanItem[]>();
  for (const item of input.planItems) {
    if (item.deleted === true || item.status === 'cancelled') continue;
    push(plannedByCode, item.code, item);
  }
  for (const list of plannedByCode.values()) list.splice(0, list.length, ...bySoonestPromise(list));

  // What the order book says is still owed, per code, in promise order.
  const owedByCode = new Map<string, JobLineView[]>();
  for (const line of input.lines) {
    if (line.qty <= 0 || line.excluded || line.farFuture) continue;
    if (line.short <= EPSILON) continue;
    push(owedByCode, line.itemCode, line);
  }

  const out: ScheduleLine[] = [];
  /** Order line id to the day it is promised, for a plan item that names lines but carries no date. */
  const lineById = new Map<string, JobLineView>();
  const dayById = new Map<string, number>();
  for (const lines of owedByCode.values()) {
    for (const line of lines) {
      lineById.set(line.id, line);
      dayById.set(line.id, dayStart(line.promisedDate));
    }
  }

  const planRow = (item: PlanItem, answers: string[], surplus: number): ScheduleLine => {
    const product = products.get(item.code) ?? null;
    const promisedFor = item.promisedFor ?? earliest(...answers.map((id) => dayById.get(id) ?? null));
    const latestStart = item.latestStartDate ?? startFor(promisedFor, product, input.settings);
    const answered = answers.length;
    const note =
      item.status === 'started'
        ? 'Being made. The order book counts the racks against the promise as soon as they are logged.'
        : answered === 0
          ? owedByCode.has(item.code)
            ? 'The promises for this code are already covered, so nothing on the book is waiting on this one.'
            : 'Nothing in the order book is waiting on this. It is a make the shop put on the plan itself.'
          : surplus > EPSILON
            ? `Makes ${answered} ${answered === 1 ? 'line' : 'lines'} and ${round(surplus, 2)} more than the promises it answers.`
            : `Covers ${answered} ${answered === 1 ? 'line' : 'lines'} on the book.`;
    const names = unique(answers.map((id) => lineById.get(id)?.customer ?? '').filter((n) => n !== ''));
    return view(
      {
        id: item.id,
        origin: 'plan',
        code: item.code,
        description: product?.description ?? '',
        ours: product !== null,
        unit: product?.unit ?? null,
        qty: round(item.qty, 2),
        promisedFor,
        latestStart,
        route: item.route,
        status: item.status,
        plan: item,
        jobIds: answers,
        customers: names,
        // A started rack is work in progress the order book already counts, so
        // calling its leftover "over-planned" would be a lie about a real rack.
        surplus: item.status === 'started' ? 0 : round(surplus, 2),
        note: item.note.trim() !== '' ? `${note} ${item.note.trim()}` : note,
        rank: item.rank,
      },
      product,
      today,
    );
  };

  for (const [code, lines] of owedByCode) {
    const product = products.get(code) ?? null;
    const items = plannedByCode.get(code) ?? [];
    const left = lines.map((line) => ({ line, left: line.short }));
    const claimedBy = new Set<string>();

    for (const item of items) {
      let budget = item.qty;
      const answers: string[] = [];
      const linked = new Set(item.linkedJobIds);
      // An explicit link is the shop overriding the earliest-promise rule.
      for (const pass of [true, false] as const) {
        for (const slot of left) {
          if (budget <= EPSILON) break;
          if (pass !== linked.has(slot.line.id)) continue;
          if (claimedBy.has(slot.line.id) && slot.left <= EPSILON) continue;
          const take = Math.min(budget, slot.left);
          if (take <= EPSILON) continue;
          slot.left = round(slot.left - take, 4);
          budget = round(budget - take, 4);
          claimedBy.add(slot.line.id);
          if (!answers.includes(slot.line.id)) answers.push(slot.line.id);
        }
      }
      out.push(planRow(item, answers, budget));
    }

    // Whatever is still uncovered, in one row per promise day.
    const gaps = new Map<number, { qty: number; ids: string[]; customers: string[] }>();
    for (const slot of left) {
      if (slot.left <= EPSILON) continue;
      const day = dayStart(slot.line.promisedDate);
      const gap = gaps.get(day) ?? { qty: 0, ids: [], customers: [] };
      gap.qty = round(gap.qty + slot.left, 4);
      gap.ids.push(slot.line.id);
      gap.customers.push(slot.line.customer);
      gaps.set(day, gap);
    }
    for (const [day, gap] of gaps) {
      const latestStart = startFor(day, product, input.settings);
      out.push(
        view(
          {
            id: `gap|${code}|${day}`,
            origin: 'gap',
            code,
            description: product?.description ?? '',
            ours: product !== null,
            unit: product?.unit ?? null,
            qty: round(gap.qty, 2),
            promisedFor: day,
            latestStart,
            route: product !== null && product.route !== 'unset' ? product.route : null,
            status: null,
            plan: null,
            jobIds: gap.ids,
            customers: unique(gap.customers),
            surplus: 0,
            note:
              product === null
                ? 'Not a product on this device, so there is no lead time to work a start date from.'
                : 'Nothing has been planned for this yet.',
            rank: latestStart ?? Number.MAX_SAFE_INTEGER,
          },
          product,
          today,
        ),
      );
    }
  }

  // Planned makes for codes nothing is currently owed — a target refill, say.
  for (const [code, items] of plannedByCode) {
    if (owedByCode.has(code)) continue;
    for (const item of items) out.push(planRow(item, [], item.qty));
  }

  return out.sort(compareRows);
}

function compareRows(a: ScheduleLine, b: ScheduleLine): number {
  const order: Record<PlanBucket, number> = { behind: 0, week: 1, later: 2, making: 3, undated: 4, all: 5 };
  if (order[a.bucket] !== order[b.bucket]) return order[a.bucket] - order[b.bucket];
  const ad = a.latestStart ?? Number.MAX_SAFE_INTEGER;
  const bd = b.latestStart ?? Number.MAX_SAFE_INTEGER;
  if (ad !== bd) return ad - bd;
  if (a.qty !== b.qty) return b.qty - a.qty;
  if (a.code !== b.code) return a.code < b.code ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/* ── Filtering ─────────────────────────────────────────────────────────────── */

export interface ScheduleFilter {
  bucket: PlanBucket;
  query: string;
  /** Only the promises with nothing planned against them. */
  unplannedOnly: boolean;
}

export function defaultScheduleFilter(): ScheduleFilter {
  return { bucket: 'all', query: '', unplannedOnly: false };
}

export function inBucket(line: ScheduleLine, bucket: PlanBucket): boolean {
  switch (bucket) {
    case 'all':
      return true;
    case 'behind':
      return line.bucket === 'behind';
    case 'week':
      return line.bucket === 'week';
    case 'later':
      return line.bucket === 'later';
    case 'making':
      return line.bucket === 'making';
    case 'undated':
      return line.bucket === 'undated';
  }
}

export function matchesScheduleQuery(line: ScheduleLine, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  const haystack = [
    line.code,
    line.description,
    ...line.customers,
    ...line.jobIds,
    line.plan?.note ?? '',
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(q);
}

export function filterSchedule(lines: ScheduleLine[], filter: ScheduleFilter): ScheduleLine[] {
  return lines.filter(
    (line) =>
      inBucket(line, filter.bucket) &&
      matchesScheduleQuery(line, filter.query) &&
      (!filter.unplannedOnly || line.origin === 'gap'),
  );
}

export function isFiltering(filter: ScheduleFilter): boolean {
  return filter.bucket !== 'all' || filter.query.trim() !== '' || filter.unplannedOnly;
}

/* ── Counts ────────────────────────────────────────────────────────────────── */

export interface ScheduleTotals {
  rows: number;
  /** Rows the shop has already written down, and the quantity they make. */
  planned: number;
  plannedQty: number;
  /** Promises with nothing planned against them, and what they still need. */
  unplanned: number;
  unplannedQty: number;
  /** Rows whose start day has gone. A plan with these on it is not a plan yet. */
  behind: number;
  behindQty: number;
  making: number;
  undated: number;
  codes: number;
  customers: number;
  /** Planned quantity beyond the promises it answers. */
  surplusQty: number;
}

export function summariseSchedule(lines: ScheduleLine[]): ScheduleTotals {
  const totals: ScheduleTotals = {
    rows: lines.length,
    planned: 0,
    plannedQty: 0,
    unplanned: 0,
    unplannedQty: 0,
    behind: 0,
    behindQty: 0,
    making: 0,
    undated: 0,
    codes: 0,
    customers: 0,
    surplusQty: 0,
  };
  const codes = new Set<string>();
  const customers = new Set<string>();
  for (const line of lines) {
    codes.add(line.code);
    for (const name of line.customers) customers.add(name);
    if (line.origin === 'plan') {
      totals.planned += 1;
      totals.plannedQty = round(totals.plannedQty + line.qty, 2);
      totals.surplusQty = round(totals.surplusQty + line.surplus, 2);
    } else {
      totals.unplanned += 1;
      totals.unplannedQty = round(totals.unplannedQty + line.qty, 2);
    }
    if (line.bucket === 'behind') {
      totals.behind += 1;
      totals.behindQty = round(totals.behindQty + line.qty, 2);
    }
    if (line.bucket === 'making') totals.making += 1;
    if (line.bucket === 'undated') totals.undated += 1;
  }
  totals.codes = codes.size;
  totals.customers = customers.size;
  return totals;
}

/**
 * The number each pile holds. Counted through the same predicate the filter uses,
 * so a chip can never promise more rows than pressing it will show.
 */
export function bucketCounts(lines: ScheduleLine[]): Record<PlanBucket, number> {
  const counts = { behind: 0, week: 0, later: 0, making: 0, undated: 0, all: lines.length } as Record<
    PlanBucket,
    number
  >;
  for (const line of lines) {
    for (const bucket of PLAN_BUCKETS) {
      if (bucket.key === 'all') continue;
      if (inBucket(line, bucket.key)) counts[bucket.key] += 1;
    }
  }
  return counts;
}
