import { dayStart, relativeDays } from './dates';
import { readyAt } from './calc';
import { STAGE_LABELS } from './batches';
import type { Batch, BatchStage, Settings } from './types';

/**
 * What is on the racks, and when it comes off them.
 *
 * The cure screen answers one question for the floor: *what can I take out
 * today?* Everything here is derived, never stored — a batch's stage says where
 * it is in the shop, and `calc.readyAt` says when it is sellable. Those two are
 * allowed to disagree, and the disagreement is the useful part: a rack that is
 * chemically ready but still needs its blast is not ready, and a rack marked
 * `curing` whose cure is over is waiting for someone.
 *
 * The screen does not move anything by itself. `dueToAdvance` in `batches.ts`
 * says what is due, and a person decides — a pallet of pavers does not leave the
 * racks because a timer fired.
 */

/** Stages that still hold a rack on the floor. */
const ON_THE_RACKS: readonly BatchStage[] = ['green', 'curing', 'awaiting_shotblast', 'blasting'];

export function onTheRacks(batch: Batch): boolean {
  return batch.deleted !== true && ON_THE_RACKS.includes(batch.stage);
}

/**
 * How much of a shotblast batch has not been through the blaster.
 *
 * A partial blast splits the remainder into its own batch, so this is normally
 * zero or the whole quantity — but the comparison is on the batch itself so a
 * half-blasted rack is never reported as blasted.
 */
export function blastOutstanding(batch: Batch): number {
  if (batch.routeSnapshot !== 'shotblast') return 0;
  return Math.max(0, batch.qty - batch.blastedQty);
}

export function needsBlast(batch: Batch): boolean {
  return blastOutstanding(batch) > 1e-6;
}

/** What the cure clock says about one rack, in the terms the screen uses. */
export interface CureState {
  /** Sellable now: cure done, and its blast done too if it needs one. */
  ready: boolean;
  /** When it becomes ready, or null while something is still missing. */
  readyAtMs: number | null;
  needsBlast: boolean;
  /** The cure itself, whether or not the blast is in the way. */
  cureDone: boolean;
  /**
   * The date a person can plan around, or null when something has to happen
   * first. For a rack that still needs its blast there is no date — the blast is
   * decided by the blaster, not by the calendar — so it is left blank rather than
   * guessed at with the cure date.
   */
  planDate: number | null;
  /** -1 → the cure is over and nobody has moved it; 0 → due today. */
  cureDaysLeft: number;
  /** 0–1 through its own cure, for the bar. Past the end, it reads 1. */
  progress: number;
}

export function cureState(batch: Batch, settings: Settings, now = Date.now()): CureState {
  const at = readyAt(batch, settings, now);
  const start = dayStart(batch.madeAt);
  const span = Math.max(1, batch.cureDueAt - start);
  const blast = needsBlast(batch);
  return {
    ready: at !== null && at <= now,
    readyAtMs: at,
    planDate: blast ? null : (at ?? batch.cureDueAt),
    needsBlast: blast,
    cureDone: now >= batch.cureDueAt,
    cureDaysLeft: Math.round((batch.cureDueAt - dayStart(now)) / 86_400_000),
    progress: Math.min(1, Math.max(0, (now - start) / span)),
  };
}

/**
 * Where a rack belongs in the list.
 *
 * Grouped by when it can be used, not by when the cure ends — because a rack
 * that still needs its blast has no date anyone can plan around, and putting it
 * under "Thursday" would be a promise the shop cannot keep.
 */
export type CureBucket = 'waiting' | 'now' | 'today' | 'tomorrow' | 'week' | 'later';

export const BUCKET_LABELS: Record<CureBucket, string> = {
  waiting: 'Waits for something',
  now: 'Off the racks now',
  today: 'Still on today',
  tomorrow: 'Tomorrow',
  week: 'Later this week',
  later: 'Further out',
};

const BUCKET_ORDER: readonly CureBucket[] = ['waiting', 'now', 'today', 'tomorrow', 'week', 'later'];

export function cureBucket(state: CureState, now = Date.now()): CureBucket {
  if (state.planDate === null) return 'waiting';
  if (state.planDate <= now) return 'now';
  const days = Math.round((dayStart(state.planDate) - dayStart(now)) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days <= 7) return 'week';
  return 'later';
}

export interface CureGroup {
  bucket: CureBucket;
  label: string;
  rows: Batch[];
}

/**
 * The racks, grouped and ordered.
 *
 * Inside a group, soonest first, then by batch number so two racks with the same
 * date read in the order they were made rather than by whatever the database
 * happened to return.
 */
export function groupForCure(
  batches: Batch[],
  settings: Settings,
  now = Date.now(),
): CureGroup[] {
  const groups = new Map<CureBucket, Batch[]>();
  for (const batch of batches) {
    if (!onTheRacks(batch)) continue;
    const bucket = cureBucket(cureState(batch, settings, now), now);
    (groups.get(bucket) ?? groups.set(bucket, []).get(bucket)!).push(batch);
  }
  return BUCKET_ORDER.filter((b) => (groups.get(b) ?? []).length > 0).map((bucket) => ({
    bucket,
    label: BUCKET_LABELS[bucket],
    rows: (groups.get(bucket) ?? []).sort(byCureOrder(settings, now)),
  }));
}

/** Soonest first; a rack still waiting for its blast sits at the end. */
export function byCureOrder(settings: Settings, now = Date.now()) {
  return (a: Batch, b: Batch): number => {
    const at = cureState(a, settings, now).planDate;
    const bt = cureState(b, settings, now).planDate;
    if (at === null || bt === null) {
      if (at === bt) return a.batchNo.localeCompare(b.batchNo);
      return at === null ? 1 : -1;
    }
    return at - bt || a.batchNo.localeCompare(b.batchNo);
  };
}

/** The figures above the list. Units are left out unless the racks agree. */
export interface CureSummary {
  racks: number;
  trays: number;
  qty: number;
  /** Ready and still sitting where it was cured. */
  due: number;
  /** Racks with blast still outstanding. */
  awaitingBlast: number;
  /** How long the most overdue rack has been waiting, in whole days. */
  overdueDays: number;
}

 // The total quantity has no unit here on purpose — the racks on a shop floor are
 // counted in whatever their products are counted in, and adding m² to lm is a
 // number nobody can check. Trays is the unit the whole list genuinely shares, and
 // each row carries its own quantity with its own unit.


export function cureSummary(
  batches: Batch[],
  settings: Settings,
  now = Date.now(),
): CureSummary {
  const onRacks = batches.filter(onTheRacks);
  let overdueDays = 0;
  let due = 0;
  let awaitingBlast = 0;
  for (const b of onRacks) {
    const state = cureState(b, settings, now);
    if (state.needsBlast) awaitingBlast += 1;
    if (state.ready) {
      due += 1;
      overdueDays = Math.max(overdueDays, -Math.min(0, state.cureDaysLeft));
    }
  }
  return {
    racks: onRacks.length,
    trays: onRacks.reduce((s, b) => s + b.trays, 0),
    qty: onRacks.reduce((s, b) => s + b.qty, 0),
    due,
    awaitingBlast,
    overdueDays,
  };
}

/**
 * Why a rack cannot be moved to a given stage, in a sentence, or null when it
 * can.
 *
 * The refusal is the point of this function, not the yes. A screen that only
 * knows the allowed transitions renders a greyed button and says nothing; a
 * sentence naming the quantity still in the blaster is something a person can
 * act on.
 */
export function moveProblem(
  batch: Batch,
  to: BatchStage,
  settings: Settings,
  now = Date.now(),
): string | null {
  const label = STAGE_LABELS[to];
  if (batch.deleted === true) return 'That rack has been taken back, so there is nothing to move.';
  if (batch.stage === 'written_off') {
    return `${batch.batchNo} was written off. If it turned up after all, log it as a new make — the write-off stays in the ledger either way.`;
  }
  if (batch.enteredAt !== null) {
    return `${batch.batchNo} is keyed into MYOB. Correct it there, or write it off — moving it here would leave the two records disagreeing.`;
  }
  if (batch.stage === to) return `It is already marked ${label.toLowerCase()}.`;
  if (to === 'entered_myob') {
    return 'A rack goes into MYOB from the MYOB entry queue, where it joins the week’s run.';
  }
  const state = cureState(batch, settings, now);
  if (to === 'ready') {
    if (state.needsBlast) {
      // No unit noun here on purpose: this is the batch's own quantity, which is
      // m² for one product and lineal metres for another. The row beside it carries
      // the unit; the sentence has to stay true for both.
      return `${batch.batchNo} still has ${blastOutstanding(batch)} to go through the blaster.`;
    }
    if (!state.ready) {
      // The cure date is the useful one: `readyAt` answers "when did it become
      // ready", which is null for anything still curing, while the cure due date is
      // the day a person can write on a rack label.
      return state.planDate === null
        ? `${batch.batchNo} is not ready yet.`
        : `${batch.batchNo} is still curing — due ${relativeDays(state.planDate, now)}.`;
    }
    return null;
  }

  if (to === 'awaiting_shotblast' || to === 'blasting') {
    return state.needsBlast
      ? null
      : `${batch.batchNo} has already had its blast, so it does not belong in the blaster’s queue.`;
  }

  // Back onto the racks: allowed, and it has to be. Someone marking a rack ready
  // a day early needs to be able to undo it without a phone call.
  return null;
}
