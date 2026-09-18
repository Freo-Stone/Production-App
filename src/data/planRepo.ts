import { latestStartDate } from '@/core/calc';
import { formatDayFull } from '@/core/dates';
import { formatNumber, unitLabel } from '@/core/format';
import { uid } from '@/core/ids';
import type { Batch, JobRow, PlanItem, Product, ProductRoute, Settings, StockRow } from '@/core/types';
import { db, getSettings, latestJobsSnapshot, latestStockSnapshot } from '@/data/db';
import { logEvent } from '@/data/events';
import { assertCan } from '@/data/principal';

/**
 * Writing the plan down.
 *
 * The order book reads what is owed and the schedule works out what that means to
 * make, but neither of them can say "we are making this". A `PlanItem` is the shop's
 * own record: this much of this code, for this promise, on this route, with the day
 * it had better have started by.
 *
 * Three writers, all of them refusing in a sentence rather than guessing:
 *
 * - **`addPlanItem`** makes one. The quantity has to be a number, the code has to be
 *   a product on this device, and the product has to have a route — the same three
 *   things Daily entry refuses to guess at, because a plan built on an assumed cure
 *   time is a promise the shop cannot keep twice.
 * - **`startPlanItem`** says the making has begun. It does not create a rack: the
 *   floor logs racks on Daily entry, and the order book starts counting them the
 *   moment they exist. This only stops the plan nagging about a make that is
 *   already happening.
 * - **`cancelPlanItem`** takes it off. It stays in the database as a cancelled item
 *   — other devices have to hear that it went away — and the ledger keeps the reason,
 *   exactly as a write-off does.
 *
 * The start date is never taken from the screen. It is `calc.latestStartDate`, the
 * same arithmetic the schedule shows, so what the button wrote and what the row said
 * cannot drift apart.
 */

/** A plan line that could not be written. The message is the reason, and it is shown. */
export class PlanRefusedError extends Error {}

export interface NewPlanItem {
  code: string;
  qty: number;
  /** The promise this make answers. Null for a refill the shop is planning by itself. */
  promisedFor: number | null;
  /** Normally the product's own route; only worth passing when the shop overrides it. */
  route?: Exclude<ProductRoute, 'unset'> | null;
  /** Order lines this make is for. An explicit link overrides the schedule's default matching. */
  linkedJobIds?: string[];
  note?: string;
}

/** Everything the schedule screen reads, in one consistent snapshot. */
export interface ScheduleSource {
  jobs: JobRow[];
  jobsCapturedAt: number | null;
  source: string;
  stockRows: StockRow[];
  stockCapturedAt: number | null;
  batches: Batch[];
  products: Product[];
  /** Every plan item on the device, cancelled ones included. */
  planItems: PlanItem[];
  settings: Settings;
}

export async function scheduleSource(): Promise<ScheduleSource> {
  const [jobs, stock, products, batches, planItems, settings] = await Promise.all([
    latestJobsSnapshot(),
    latestStockSnapshot(),
    db.products.toArray(),
    db.batches.toArray(),
    db.planItems.toArray(),
    getSettings(),
  ]);
  return {
    jobs: jobs?.rows ?? [],
    jobsCapturedAt: jobs?.capturedAt ?? null,
    source: jobs?.source ?? '',
    stockRows: stock?.rows ?? [],
    stockCapturedAt: stock?.capturedAt ?? null,
    batches: batches.filter((b) => !b.deleted),
    products: products.filter((p) => !p.deleted).sort((a, b) => a.rank - b.rank),
    planItems: planItems.sort((a, b) => a.rank - b.rank),
    settings,
  };
}

/** The plan items for one code that the schedule still has to honour. */
export async function planItemsForCode(code: string): Promise<PlanItem[]> {
  const all = await db.planItems.where('code').equals(code).toArray();
  return all.filter((item) => !item.deleted && item.status !== 'cancelled');
}

/**
 * Put a make on the plan.
 *
 * The refusals here are the whole point of the writer: each one is a thing the shop
 * would otherwise find out a week later, when the make lands late.
 */
export async function addPlanItem(input: NewPlanItem): Promise<PlanItem> {
  assertCan('production.record');

  const code = input.code.trim();
  if (code === '') throw new PlanRefusedError('No item code, so there is nothing to plan.');
  if (!Number.isFinite(input.qty) || input.qty <= 0) {
    throw new PlanRefusedError(
      'A plan line has to say how much is being made, and it has to be more than nothing. A credit is not something you put a pallet against.',
    );
  }

  return db.transaction('rw', db.planItems, db.products, db.events, db.meta, async () => {
    const product = (await db.products.get(code)) ?? null;
    if (product === null || product.deleted === true) {
      throw new PlanRefusedError(
        `${code} is not a product on this device, so there is no cure time to plan a make around. Switch it on in Products first.`,
      );
    }
    // A product with no route cannot be planned: the start date depends on whether
    // the piece cures or goes through the blaster, and guessing it is how a shop
    // ends up a week late on a promise it meant to keep.
    const route = input.route ?? (product.route === 'unset' ? null : product.route);
    if (route === null) {
      throw new PlanRefusedError(
        `${code} has no route set. Say on Products whether it is made or goes through the blaster, so the plan knows whether to leave a blasting day out.`,
      );
    }

    const settings = await getSettings();
    const now = Date.now();
    const start = input.promisedFor === null ? null : latestStartDate(input.promisedFor, product, settings);
    const rank = await nextRank();

    const item: PlanItem = {
      id: uid('plan'),
      code: product.code,
      qty: Math.round(input.qty * 100) / 100,
      latestStartDate: start,
      promisedFor: input.promisedFor,
      route,
      status: 'planned',
      linkedJobIds: Array.from(new Set(input.linkedJobIds ?? [])),
      note: (input.note ?? '').trim(),
      rank,
      updatedAt: now,
    };
    await db.planItems.add(item);
    await logEvent('plan.add', {
      code: item.code,
      qty: item.qty,
      detail: planDetail(item, product, start),
    });
    return item;
  });
}

/** Say that a planned make has started. It does not log a rack — Daily entry does that. */
export async function startPlanItem(id: string): Promise<PlanItem> {
  assertCan('production.record');
  return db.transaction('rw', db.planItems, db.products, db.events, db.meta, async () => {
    const item = await db.planItems.get(id);
    if (item === undefined || item.deleted === true) {
      throw new PlanRefusedError('That plan line is not on this device.');
    }
    if (item.status === 'cancelled') {
      throw new PlanRefusedError('It has been taken off the plan. Put it back on as a new line if it is on again.');
    }
    if (item.status === 'started') {
      throw new PlanRefusedError('Already marked as started. The racks themselves go in on Daily entry.');
    }

    const started: PlanItem = { ...item, status: 'started', updatedAt: Date.now() };
    await db.planItems.put(started);
    const product = (await db.products.get(item.code)) ?? null;
    await logEvent('plan.start', {
      code: item.code,
      qty: item.qty,
      detail: `${item.code} · ${formatQty(item.qty, product)} on the plan marked started${
        item.latestStartDate === null ? '' : ` — start by ${formatDayFull(item.latestStartDate)}`
      }`,
    });
    return started;
  });
}

/** Take a make off the plan. A reason is required, in the words the write-off uses. */
export async function cancelPlanItem(id: string, reason: string): Promise<PlanItem> {
  assertCan('production.record');
  const why = reason.trim();
  if (why === '') {
    throw new PlanRefusedError(
      'Taking a make off the plan needs a reason. It is the only place the shop writes down why a planned quantity went away.',
    );
  }
  return db.transaction('rw', db.planItems, db.products, db.events, db.meta, async () => {
    const item = await db.planItems.get(id);
    if (item === undefined || item.deleted === true) {
      throw new PlanRefusedError('That plan line is not on this device.');
    }
    if (item.status === 'cancelled') return item;

    const off: PlanItem = { ...item, status: 'cancelled', updatedAt: Date.now() };
    await db.planItems.put(off);
    const product = (await db.products.get(item.code)) ?? null;
    await logEvent('plan.cancel', {
      code: item.code,
      qty: item.qty,
      detail: `${item.code} · ${formatQty(item.qty, product)} taken off the plan — ${why}`,
    });
    return off;
  });
}

/** Plan lines go at the end of the shop's own order, in the same steps Products uses. */
async function nextRank(): Promise<number> {
  const all = await db.planItems.toArray();
  if (all.length === 0) return 1000;
  return Math.max(...all.map((item) => item.rank)) + 1000;
}

function formatQty(qty: number, product: Product | null): string {
  return product === null ? formatNumber(qty, 2) : `${formatNumber(qty, 2)} ${unitLabel(product.unit)}`;
}

function planDetail(item: PlanItem, product: Product, start: number | null): string {
  const parts = [`${item.code} · ${formatQty(item.qty, product)} put on the plan`];
  parts.push(item.promisedFor === null ? 'with no promise behind it' : `for ${formatDayFull(item.promisedFor)}`);
  parts.push(start === null ? 'no start date — nothing to work a lead time from' : `start by ${formatDayFull(start)}`);
  if (item.linkedJobIds.length > 0) {
    parts.push(
      `${item.linkedJobIds.length === 1 ? 'order' : 'orders'} ${item.linkedJobIds.slice(0, 2).join(', ')}${
        item.linkedJobIds.length > 2 ? ` and ${item.linkedJobIds.length - 2} more` : ''
      }`,
    );
  }
  return parts.join(' — ');
}
