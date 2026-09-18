import { assignMyobRunDate, readyAt } from './calc';
import { blastOutstanding, cureState, rackIsClosed } from './curing';
import { formatDayFull, relativeDays } from './dates';
import { compareNatural, round } from './format';
import type { Batch, Product, ProductUnit, Settings } from './types';

/**
 * The weekly MYOB run.
 *
 * Once a week somebody sits down with the ready stock and keys it into MYOB. The
 * app cannot do that typing, so the whole job here is to make the run
 * unambiguous: which racks are in this week's run and which are next week's, what
 * the totals are per item code, and what the shop will paste into MYOB. Then the
 * racks are marked entered, so the next week starts from what is actually still
 * sitting in the shop.
 *
 * The run date is **derived, never stored** — it is the next entry weekday after
 * the moment the rack became ready, rolled a week if it came ready after the
 * cut-off. Storing it would give two answers to the same question, and they would
 * drift the first time a cure day was corrected or a blast was recorded late.
 * `batchRepo.markEntered` writes `myobRunDate` on the rack, because at that point
 * the date stops being a plan and becomes a record of what was keyed.
 */

/** A rack that is waiting to be keyed into MYOB, and the run it belongs to. */
export interface EntryRow {
  batch: Batch;
  /** Epoch ms of the entry weekday this rack belongs to. */
  runDate: number;
}

/** One line of the copy-out: one item code, all the racks behind it. */
export interface ExportLine {
  code: string;
  description: string;
  unit: ProductUnit;
  qty: number;
  /** How many racks the quantity is made of, and their numbers. */
  racks: number;
  batchNos: string[];
  memo: string;
}

/** The run's headline numbers, for the header sentence. */
export interface RunTotals {
  racks: number;
  trays: number;
  /** Quantity total per unit — a shop carries m² and lineal metres together. */
  byUnit: Array<{ unit: ProductUnit; qty: number }>;
  codes: number;
}

/**
 * Whether a rack is waiting to be keyed.
 *
 * Off the racks, not written off, not taken back, and not keyed already.
 */
export function awaitsEntry(batch: Batch): boolean {
  return batch.deleted !== true && batch.enteredAt === null && batch.stage === 'ready';
}

/**
 * Which run a rack belongs to.
 *
 * `readyAt` says when the rack became usable; `assignMyobRunDate` says which
 * entry weekday that lands on, pushing to the following week when it came ready
 * after that day's cut-off. A rack whose `readyAt` says it is not ready has no
 * run at all — the caller decides what to do with it, because it has no business
 * being in the queue.
 */
export function runDateFor(batch: Batch, settings: Settings, now = Date.now()): number | null {
  const at = readyAt(batch, settings, now);
  return at === null ? null : assignMyobRunDate(at, settings);
}

/** The queue, in run order and then oldest make first within a run. */
export function entryQueue(batches: Batch[], settings: Settings, now = Date.now()): EntryRow[] {
  return batches
    .filter(awaitsEntry)
    .map((batch) => ({ batch, runDate: runDateFor(batch, settings, now) }))
    .filter((row): row is EntryRow => row.runDate !== null)
    .sort((a, b) => a.runDate - b.runDate || a.batch.madeAt - b.batch.madeAt || compareNatural(a.batch.batchNo, b.batch.batchNo));
}

/**
 * Racks on the ready pile that their own rules say are not ready.
 *
 * A rack can get here by the stage being set ahead of its cure — an imported row, a
 * corrected cure day, a blast recorded after the fact. They cannot be keyed:
 * `enterProblem` would refuse every one. So they are left out of the queue, and the
 * screen is expected to *name* them, because a queue that is quietly shorter than
 * the ready pile is the kind of difference that ends in somebody trusting MYOB.
 */
export function heldBack(batches: Batch[], settings: Settings, now = Date.now()): Batch[] {
  return batches.filter((b) => awaitsEntry(b) && runDateFor(b, settings, now) === null);
}

/** The queue split by run date, soonest run first. */
export function entryRuns(rows: EntryRow[]): Array<{ runDate: number; rows: EntryRow[] }> {
  const runs = new Map<number, EntryRow[]>();
  for (const row of rows) {
    const list = runs.get(row.runDate);
    if (list === undefined) runs.set(row.runDate, [row]);
    else list.push(row);
  }
  return [...runs.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([runDate, list]) => ({ runDate, rows: list }));
}

/**
 * The run's headline numbers.
 *
 * `unitOf` comes in from the caller because a batch carries a product *code*, not
 * a unit — the screen has the products loaded and passes the lookup. Quantities in
 * different units are not added together; each unit gets its own figure, because
 * 40 m² and 30 lineal metres is not 70 of anything.
 */
export function runTotals(rows: EntryRow[], unitOf: (code: string) => ProductUnit): RunTotals {
  const units = new Map<ProductUnit, number>();
  const codes = new Set<string>();
  let trays = 0;
  for (const { batch } of rows) {
    trays += batch.trays;
    codes.add(batch.code);
    const unit = unitOf(batch.code);
    units.set(unit, (units.get(unit) ?? 0) + batch.qty);
  }
  return {
    racks: rows.length,
    trays,
    byUnit: [...units.entries()]
      .sort((a, b) => compareNatural(a[0], b[0]))
      .map(([unit, qty]) => ({ unit, qty: round(qty, 3) })),
    codes: codes.size,
  };
}

/**
 * What gets copied out: one line per item code, not one per rack.
 *
 * MYOB is keyed by item number and quantity, so the run is grouped by code. The
 * racks behind a line are kept on it because a person checking the run at the
 * racks needs to be able to point at the pallets, and because two racks of the
 * same code can be two different Fridays — which is why the grouping is done per
 * run, by the caller.
 */
export function groupForExport(rows: EntryRow[], products: Product[], settings: Settings, runDate: number): ExportLine[] {
  const byCode = new Map<string, ExportLine>();
  const memo = memoFor(settings.myobEntry.memoTemplate, runDate);
  for (const { batch } of rows) {
    const product = products.find((p) => p.code === batch.code);
    const line = byCode.get(batch.code) ?? {
      code: batch.code,
      description: product?.description ?? '',
      unit: product?.unit ?? 'pieces',
      qty: 0,
      racks: 0,
      batchNos: [],
      memo,
    };
    line.qty = round(line.qty + batch.qty, 3);
    line.racks += 1;
    line.batchNos.push(batch.batchNo);
    byCode.set(batch.code, line);
  }
  return [...byCode.values()].sort((a, b) => compareNatural(a.code, b.code));
}

/** The memo MYOB sees. `{runDate}` is the only token; anything else is literal. */
export function memoFor(template: string, runDate: number): string {
  return template.replaceAll('{runDate}', formatDayFull(runDate)).trim();
}

/**
 * One cell of the copy-out.
 *
 * Settings choose the columns and their order, so a key the app does not know has
 * to be answered honestly rather than silently blanked: the header still appears,
 * with nothing under it, and the row beside it makes the gap obvious.
 */
export function exportCell(line: ExportLine, key: string): string {
  switch (key) {
    case 'code':
      return line.code;
    case 'description':
      return line.description;
    case 'qty':
      return String(line.qty);
    case 'unit':
      return line.unit;
    case 'memo':
      return line.memo;
    case 'racks':
      return String(line.racks);
    case 'batches':
      return line.batchNos.join(' ');
    default:
      return '';
  }
}

/** Tab-separated, for pasting straight into the MYOB grid. */
export function copyOutTsv(lines: ExportLine[], columns: Array<{ key: string; header: string }>): string {
  const cells = (pick: (c: { key: string; header: string }) => string): string =>
    columns.map((c) => escapeTsv(pick(c))).join('\t');
  return [cells((c) => c.header), ...lines.map((l) => cells((c) => exportCell(l, c.key)))].join('\r\n');
}

/** Comma-separated, for the file. Quoted the way Excel wants it. */
export function copyOutCsv(lines: ExportLine[], columns: Array<{ key: string; header: string }>): string {
  const cells = (pick: (c: { key: string; header: string }) => string): string =>
    columns.map((c) => escapeCsv(pick(c))).join(',');
  return [cells((c) => c.header), ...lines.map((l) => cells((c) => exportCell(l, c.key)))].join('\r\n');
}

function escapeTsv(value: string): string {
  return value.replace(/[\t\r\n]/g, ' ');
}

function escapeCsv(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/**
 * Why a rack cannot go into this run, in a sentence, or null when it can.
 *
 * Same shape as `moveProblem`: the screen asks it before drawing a button, and the
 * writer asks it again inside its transaction, so the sentence a person reads is
 * the sentence the writer would have thrown.
 */
export function enterProblem(batch: Batch, settings: Settings, now = Date.now()): string | null {
  // Answered before the shared closed-rack check on purpose: the usual reason a
  // rack turns up here twice is that it was keyed and the queue was refreshed.
  if (batch.enteredAt !== null) {
    return `${batch.batchNo} is already keyed into MYOB${batch.myobRunDate === null ? '' : ` for ${formatDayFull(batch.myobRunDate)}`}. Take it back out first if that was a mistake.`;
  }
  const closed = rackIsClosed(batch, 'enter');
  if (closed !== null) return closed;
  if (batch.stage === 'entered_myob') {
    return `${batch.batchNo} is marked in MYOB but has no entry time on it. Put it back on the racks and bring it through again.`;
  }

  const state = cureState(batch, settings, now);
  if (state.needsBlast) {
    return `${batch.batchNo} still has ${blastOutstanding(batch)} to go through the blaster.`;
  }
  if (!state.ready) {
    return state.planDate === null
      ? `${batch.batchNo} is not ready yet.`
      : `${batch.batchNo} is still curing — due ${relativeDays(state.planDate, now)}.`;
  }
  return null;
}

/** Why a keyed rack cannot be taken back out of a run. */
export function unenterProblem(batch: Batch): string | null {
  if (batch.deleted === true) return 'That rack has been taken back, so there is nothing to take out of MYOB.';
  if (batch.enteredAt === null) return `${batch.batchNo} has not been keyed into MYOB, so there is nothing to take back.`;
  return null;
}

/**
 * Racks keyed since the MYOB stock export was taken.
 *
 * The export is a photograph of MYOB at a moment; anything keyed after it was
 * taken is real in MYOB and invisible in the export, so it has to be added back
 * by hand wherever stock is counted. This is the list of what that is, and the
 * reason the keyed pile stays on screen for a while rather than vanishing.
 */
export function keyedSince(batches: Batch[], stockCapturedAt: number | null | undefined, now = Date.now()): Batch[] {
  return batches
    .filter((b) => b.deleted !== true && b.enteredAt !== null && (stockCapturedAt == null || b.enteredAt > stockCapturedAt))
    .filter((b) => now - (b.enteredAt ?? 0) < 28 * 86_400_000)
    .sort((a, b) => (b.enteredAt ?? 0) - (a.enteredAt ?? 0) || compareNatural(a.batchNo, b.batchNo));
}
