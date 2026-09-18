import { dayStart, relativeDays } from './dates';
import { formatNumber, round } from './format';
import { needsBlast, onTheRacks, rackIsClosed } from './curing';
import type { Batch } from './types';

/**
 * The blaster's own queue.
 *
 * Shotblast sits *beside* the cure, not after it: a rack can go through the
 * blaster while it is still hardening, and on this shop's settings (`blasting-
 * CompletesCure`, which is how they run it) coming out of the blaster stands in
 * for the rest of the cure. So this screen is not a stage the rack must pass —
 * it is a job that is owed, and the only question it asks is *which racks still
 * owe time in the blaster, and what do we do about them*.
 *
 * Two things this module decides, both because guessing is worse than asking:
 *
 * - **Order.** The rack whose cure has already finished is at the top. It is
 *   finished hardening and only the blast stands in the way of selling it, so it
 *   is the one holding up an invoice. A rack still curing can be blasted too,
 *   but nothing is being held up yet.
 * - **A part-blast.** The floor counts trays, so the blaster is asked how many
 *   trays went through. Fewer than the rack holds means the rack is split: the
 *   blasted trays keep the number written on the label, and the rest becomes a
 *   new batch with its own number, because a half-blasted pallet needs its own
 *   label or it will be read as blasted next time somebody walks past.
 */

/** A rack on the floor that still owes time in the blaster. */
export function awaitsBlast(batch: Batch): boolean {
  return onTheRacks(batch) && needsBlast(batch);
}

/** A rack that is in the blaster right now. */
export function onTheBlaster(batch: Batch): boolean {
  return awaitsBlast(batch) && batch.stage === 'blasting';
}

/** The three lists the screen shows. */
export interface BlastLists {
  /** In the blaster now, the one that went in first at the top. */
  blasting: Batch[];
  /** Waiting, and the cure is done: only the blast is in the way. */
  cureFinished: Batch[];
  /** Waiting, still curing. It can be blasted beside the cure, and nothing is held up. */
  stillCuring: Batch[];
}

export function blastLists(batches: Batch[], now = Date.now()): BlastLists {
  const waiting = batches.filter((b) => awaitsBlast(b) && b.stage !== 'blasting');
  const done = relativeCure(waiting, true, now);
  return {
    blasting: batches
      .filter(onTheBlaster)
      .sort((a, b) => a.updatedAt - b.updatedAt || a.madeAt - b.madeAt),
    cureFinished: done,
    stillCuring: relativeCure(waiting, false, now),
  };
}

/** Cure order: the one whose cure finished longest ago first, then by make. */
function relativeCure(batches: Batch[], finished: boolean, now: number): Batch[] {
  return batches
    .filter((b) => (b.cureDueAt <= now) === finished)
    .sort((a, b) => a.cureDueAt - b.cureDueAt || a.madeAt - b.madeAt);
}

/** What the header counts. */
export interface BlastSummary {
  waiting: number;
  onBlaster: number;
  /** Trays in the whole queue, the racks waiting and the one running. */
  trays: number;
  /** Waiting racks whose cure is already done. */
  urgent: number;
  /** How long the most overdue waiting rack has been sitting, in whole days. */
  oldestDays: number;
}

export function blastSummary(batches: Batch[], now = Date.now()): BlastSummary {
  const lists = blastLists(batches, now);
  const all = [...lists.blasting, ...lists.cureFinished, ...lists.stillCuring];
  const waiting = [...lists.cureFinished, ...lists.stillCuring];
  // The rack whose cure ended longest ago is the one being held up, so the queue
  // is measured from the *earliest* due date, not the latest.
  const earliest = waiting.reduce((min, b) => Math.min(min, b.cureDueAt), Number.POSITIVE_INFINITY);
  return {
    waiting: waiting.length,
    onBlaster: lists.blasting.length,
    trays: all.reduce((sum, b) => sum + b.trays, 0),
    urgent: lists.cureFinished.length,
    // Counted between midnights: a rack whose cure ended three midnights ago has
    // waited three days, whatever time of day the screen is opened at.
    oldestDays: Number.isFinite(earliest) ? Math.max(0, Math.round((dayStart(now) - earliest) / 86_400_000)) : 0,
  };
}

/**
 * What one rack went through, and what is left.
 *
 * The batch's own quantity per tray is what is split — not the product's current
 * tray yield. A rack entered against one yield must not be split by a yield that
 * changed since, or the two halves would not add up to the rack that was made.
 */
export interface BlastSplit {
  blastedTrays: number;
  blastedQty: number;
  remainderTrays: number;
  remainderQty: number;
  /** The whole rack went through, so nothing is split. */
  whole: boolean;
}

export function splitBlast(batch: Batch, trays: number): BlastSplit {
  const whole = trays >= batch.trays;
  if (whole || batch.trays <= 0) {
    return { blastedTrays: batch.trays, blastedQty: batch.qty, remainderTrays: 0, remainderQty: 0, whole: true };
  }
  const perTray = batch.qty / batch.trays;
  // The remainder is the difference rather than another multiplication, so the
  // two halves add back to the quantity that was logged exactly.
  const blastedQty = round(perTray * trays, 3);
  return {
    blastedTrays: trays,
    blastedQty,
    remainderTrays: batch.trays - trays,
    remainderQty: round(batch.qty - blastedQty, 3),
    whole: false,
  };
}

/**
 * Why this rack cannot be blasted, or how much of it cannot be. `null` means
 * record it. The screen uses this to gray out a control and print the sentence
 * under the row; the writer uses the same function inside its transaction, so a
 * rack that changed hands in another window is refused in the same words.
 */
export function blastProblem(batch: Batch, trays: number | null): string | null {
  const closed = rackIsClosed(batch, 'blast');
  if (closed !== null) return closed;
  if (batch.routeSnapshot !== 'shotblast') {
    return `${batch.batchNo} is not a shotblast make, so it does not go through the blaster.`;
  }
  if (!needsBlast(batch)) return `${batch.batchNo} has already had its blast.`;
  if (trays === null) return null;
  if (!Number.isInteger(trays)) return 'Trays are whole ones.';
  if (trays < 1) return 'How many trays went through the blaster?';
  if (trays > batch.trays) return `Only ${formatNumber(batch.trays, 0)} trays are on that rack.`;
  return null;
}

/**
 * The sentence beside the trays box. It says what is about to happen to the rest
 * of the rack, because a split is the part a person gets surprised by.
 */
export function blastPreview(batch: Batch, trays: number): string {
  const split = splitBlast(batch, trays);
  if (split.whole) {
    return `All ${formatNumber(batch.trays, 0)} trays come out blasted. The rack is done.`;
  }
  return `${formatNumber(split.blastedTrays, 0)} trays come out blasted and keep ${
    batch.batchNo
  }. The other ${formatNumber(split.remainderTrays, 0)} become their own rack, still to be blasted.`;
}

/** What the cure has to say about a rack in the queue, for the row. */
export function blastCureWords(batch: Batch, now = Date.now()): string {
  return batch.cureDueAt <= now
    ? `cure finished ${relativeDays(batch.cureDueAt, now)}`
    : `cure due ${relativeDays(batch.cureDueAt, now)}`;
}
