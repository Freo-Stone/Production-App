import { addDays, dayStart } from './dates';
import { formatBatchNo } from './ids';
import { qtyFromTrays, readyAt } from './calc';
import type { Batch, BatchStage, Product, ProductRoute, Settings } from './types';

/**
 * The make side, as pure functions: what a number of trays typed on a floor
 * becomes as a record, and when that record is finished.
 *
 * Three rules decide the shape of this file, and all three come from the shop:
 *
 * 1. **The cure clock starts when it is made.** Not when someone remembers to
 *    put it on a rack. So a make's `cureDueAt` is fixed at entry from
 *    `madeAt + cureDays`, and the clock is never recomputed afterwards.
 * 2. **The product's settings are copied, not referenced.** `cureDaysSnapshot`
 *    and `routeSnapshot` exist so that changing a product next month cannot
 *    rewrite what a batch was. A rack of pavers made under a 2-day cure stays a
 *    2-day batch even after the shop moves that product to 3.
 * 3. **Blasting runs alongside curing, not after it.** So a shotblast make is
 *    born needing both, and whether it is *ready* is derived from `readyAt` in
 *    `calc.ts` — never from a stage that blasting has to wait for.
 *
 * Nothing in here touches IndexedDB. `src/data/batchRepo.ts` does the writing,
 * and gates it.
 */

/** How the shop measures its cure period. `hours` is for a fast-turn product. */
export type CureUnit = Settings['production']['cureTimeUnit'];

/** When a make becomes sellable-age. Fixed at entry, never recomputed. */
export function cureDueAt(madeAt: number, cureDays: number, unit: CureUnit = 'days'): number {
  const days = Number.isFinite(cureDays) && cureDays > 0 ? cureDays : 0;
  // Hours are counted from the moment it was made; days are counted from the
  // start of that day, so a batch made at 3pm with a 1-day cure is due at the
  // start of tomorrow, not at 3pm — which is how a rack is read on a Monday.
  if (unit === 'hours') return madeAt + days * 3_600_000;
  return addDays(dayStart(madeAt), days);
}

/**
 * Which stage a fresh make starts in.
 *
 * A manufacture-only product goes straight onto the cure clock. A shotblast
 * product is born needing its blast as well, and `awaiting_shotblast` is the
 * stage the blaster's queue reads — it is still curing at the same time, because
 * stage and cure are two different questions.
 */
export function startingStage(route: Exclude<ProductRoute, 'unset'>): BatchStage {
  return route === 'shotblast' ? 'awaiting_shotblast' : 'curing';
}

/**
 * What each stage is called to the people on the floor.
 *
 * The stage machine in `types.ts` is written for the code; these words are for a
 * rack label and a screen a person reads in a hard hat. Two names in particular
 * carry the shop's own language: `awaiting_shotblast` is *needs blast*, and
 * `entered_myob` is *in MYOB* — not "completed", because a batch in MYOB has not
 * necessarily been delivered, it has been written down.
 */
export const STAGE_LABELS: Record<BatchStage, string> = {
  green: 'Made, not racked',
  curing: 'Curing',
  awaiting_shotblast: 'Needs blast',
  blasting: 'On the blaster',
  ready: 'Ready',
  entered_myob: 'In MYOB',
  written_off: 'Written off',
};

/** Why this row cannot be logged, in the words the screen shows. `null` = log it. */
export function entryRowProblem(input: {
  product: Product | undefined;
  trays: number | null;
}): string | null {
  const { product, trays } = input;
  if (product === undefined) return 'pick a product';
  if (trays == null || !Number.isFinite(trays) || trays <= 0) return 'how many trays?';
  if (!Number.isInteger(trays)) return 'trays are whole ones';
  if (product.route === 'unset') return `${product.code} has no route — set it on Products`;
  if (!(product.trayYield > 0)) return `${product.code} has no tray yield — set it on Products`;
  return null;
}

/** One row of the entry sheet, as the screen holds it before anything is written. */
export interface EntryDraft {
  /** Stable key for the row, so typing in one row does not move another. */
  key: string;
  code: string;
  trays: number | null;
}

/** What one draft row will become, and whether it can. */
export interface EntryLine {
  draft: EntryDraft;
  product?: Product;
  /** Quantity this row adds, in the product's unit. 0 when the row cannot be used. */
  qty: number;
  problem: string | null;
}

/** Resolve the drafts against the product list. Pure, so the totals the floor
 *  reads while typing are the same numbers the writer will use. */
export function resolveEntryRows(rows: EntryDraft[], products: Product[]): EntryLine[] {
  const byCode = new Map(products.map((p) => [p.code, p]));
  return rows.map((draft) => {
    const product = byCode.get(draft.code);
    const problem = entryRowProblem({ product, trays: draft.trays });
    const qty = problem === null ? qtyFromTrays(draft.trays ?? 0, product!.trayYield) : 0;
    return { draft, ...(product ? { product } : {}), qty, problem };
  });
}

/** The totals under the sheet: trays, and the quantity that will be logged. */
export function entryTotals(lines: EntryLine[]): { trays: number; qty: number; problems: number } {
  let trays = 0;
  let qty = 0;
  let problems = 0;
  for (const line of lines) {
    if (line.problem !== null) {
      problems++;
      continue;
    }
    trays += line.draft.trays ?? 0;
    qty += line.qty;
  }
  return { trays, qty, problems };
}

/**
 * The date part of a batch number — everything the pattern holds except the
 * sequence token at the end, whatever width that token is (`nn`, `nnn`).
 */
export function batchNoPrefix(dateMs: number, pattern: string): string {
  const d = new Date(dateMs);
  const pad = (n: number, len: number): string => String(n).padStart(len, '0');
  return pattern
    .replace('yyyy', String(d.getFullYear()))
    .replace('mm', pad(d.getMonth() + 1, 2))
    .replace('dd', pad(d.getDate(), 2))
    .replace(/n+$/, '');
}

/**
 * The next same-day sequence for a batch number.
 *
 * Counted on the day, not globally: batch numbers are printed on the rack and
 * read out over noise, so `2026-09-18-03` has to mean the third make of the
 * 18th. Two devices logging on the same day may both choose `-03`; the numbers
 * are a label, and the id is the identity.
 */
export function nextBatchSequence(batches: Batch[], madeAt: number, pattern: string): number {
  const prefix = batchNoPrefix(madeAt, pattern);
  let highest = 0;
  for (const batch of batches) {
    if (!batch.batchNo.startsWith(prefix)) continue;
    const tail = batch.batchNo.slice(prefix.length);
    const n = Number(tail);
    if (Number.isFinite(n) && n > highest) highest = n;
  }
  return highest + 1;
}

/**
 * Build the record. Takes its identity and its sequence as arguments rather than
 * reading the clock or the database, so the whole rule is testable in one call.
 */
export function batchFromEntry(input: {
  id: string;
  product: Product;
  lineId: string;
  trays: number;
  madeAt: number;
  sequence: number;
  settings: Settings;
  operator: string;
  note?: string;
}): Batch {
  const { id, product, lineId, trays, madeAt, sequence, settings, operator } = input;
  const route = product.route === 'unset' ? 'manufacture' : product.route;
  const cureDays = product.cureDays > 0 ? product.cureDays : settings.production.defaultCureDays;
  return {
    id,
    batchNo: formatBatchNo(madeAt, sequence, settings.production.batchNumberFormat),
    code: product.code,
    lineId,
    trays,
    qty: qtyFromTrays(trays, product.trayYield),
    // An override would mean the floor typed a quantity rather than trays. Entry
    // always happens in trays, so this is false by construction — the field is
    // here because the shape allows a hand-keyed quantity later.
    qtyOverridden: false,
    routeSnapshot: route,
    stage: startingStage(route),
    madeAt,
    cureDaysSnapshot: cureDays,
    cureDueAt: cureDueAt(madeAt, cureDays, settings.production.cureTimeUnit),
    blastedQty: 0,
    blastedAt: null,
    myobRunDate: null,
    enteredAt: null,
    enteredRef: '',
    operator,
    note: input.note ?? '',
    rank: 0,
    parentBatchId: null,
    updatedAt: madeAt,
  };
}

/**
 * Whether a logged make can still be taken back.
 *
 * Only a batch that has not gone anywhere: not blasted, not put on a MYOB run,
 * not keyed into MYOB. Past that point the record is evidence — a pallet has
 * been moved on the strength of it — so it is corrected by writing off, which
 * leaves both records and a ledger line, not by deleting.
 */
export function canUndo(batch: Batch): boolean {
  if (batch.deleted === true) return false;
  if (batch.enteredAt !== null || batch.myobRunDate !== null) return false;
  if (batch.blastedQty > 0 || batch.blastedAt !== null) return false;
  return batch.stage === 'curing' || batch.stage === 'awaiting_shotblast' || batch.stage === 'green';
}

/**
 * Which batches are due to be treated as ready.
 *
 * `readyAt` is the only judge, so the shotblast rule stays in one place: a
 * shotblast batch is ready when it has been fully blasted (and, if the shop has
 * said blasting does not finish the cure, when its cure is due as well), and a
 * make-only batch is ready when its cure is due.
 */
export function dueToAdvance(batches: Batch[], settings: Settings, now = Date.now()): Batch[] {
  return batches.filter((b) => {
    if (b.deleted === true) return false;
    // Only the ones still on the racks or in the queue. Anything already ready,
    // entered or written off is not waiting for this decision.
    if (b.stage !== 'green' && b.stage !== 'curing' && b.stage !== 'awaiting_shotblast' && b.stage !== 'blasting') {
      return false;
    }
    // `readyAt` answers *when*, and on the shotblast route that can be a date in
    // the future: a batch blasted on day one of a two-day cure is ready on day
    // two, not the moment it comes out of the blaster. Due means the time is here.
    const ready = readyAt(b, settings, now);
    return ready !== null && ready <= now;
  });
}
