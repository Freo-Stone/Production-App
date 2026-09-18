import {
  batchFromEntry,
  canUndo,
  dueToAdvance,
  nextBatchSequence,
  resolveEntryRows,
  STAGE_LABELS,
  type EntryDraft,
  type EntryLine,
} from '@/core/batches';
import { assignMyobRunDate } from '@/core/calc';
import { moveProblem, onTheRacks } from '@/core/curing';
import { dayStart, formatDayFull } from '@/core/dates';
import { formatNumber } from '@/core/format';
import { formatBatchNo, uid } from '@/core/ids';
import { enterProblem, runDateFor, unenterProblem } from '@/core/myobQueue';
import { awaitsBlast, blastProblem, splitBlast } from '@/core/shotblast';
import type { Batch, BatchStage } from '@/core/types';
import { db, getSettings } from '@/data/db';
import { logEvent } from '@/data/events';
import { actorStamp, assertCan } from '@/data/principal';

/**
 * Writing production down.
 *
 * This is the only place in the app that writes a batch: creating one, moving it
 * between stages, putting it through the blaster — including splitting a rack when
 * only part of it went through — writing it off, and taking one back. Everything the rest of the
 * make side needs — curing, shotblast, the MYOB queue, the log — reads records
 * that were written here, which is why the rules are kept narrow and loud:
 *
 * Every one of them goes through `assertCan` before anything is read, and through
 * the same pure rule the screen used to decide whether to offer the button — so a
 * button that appeared can only be refused for something that happened after it
 * was drawn, and the refusal is a sentence either way:
 *
 * - **The whole sheet is one transaction.** A day that is half logged is worse
 *   than a day that was refused: the racks say one thing and the board says
 *   another, and neither can be trusted afterwards.
 * - **A row that cannot be logged is refused, not fixed.** No defaulting a route,
 *   no assuming a tray yield. It comes back in the receipt with the reason the
 *   Products screen gives, because guessing on the floor is how a shop ends up
 *   with 400 m² of pavers it never made.
 * - **Who logged it comes from the login, not a box.** The ledger has always had
 *   the account; the batch row now carries the same name, so the log and the
 *   record agree.
 */

/** What happened to each row of a submitted sheet. */
export interface EntryReceipt {
  created: Batch[];
  refused: Array<{ key: string; problem: string }>;
}

/** A sheet that could not be accepted at all — the line is not one of the shop's. */
export class EntryRefusedError extends Error {}

/** A rack that could not be moved — the sentence is the reason, and it is shown. */
export class MoveRefusedError extends Error {}

/**
 * Log a day's making on one line.
 *
 * `madeAt` is the moment the last tray came off, which the screen knows because
 * it is the moment the floor pressed the button; a back-dated sheet is entered by
 * changing the date on the screen, deliberately, not by a stray clock.
 */
export async function recordEntry(input: {
  lineId: string;
  rows: EntryDraft[];
  madeAt?: number;
}): Promise<EntryReceipt> {
  assertCan('production.record');
  const madeAt = input.madeAt ?? Date.now();

  // `db.meta` is in the scope because the settings are read inside the same
  // transaction: a sheet logged under the settings it read, and not the ones that
  // changed while it was being typed.
  return db.transaction('rw', db.batches, db.lines, db.products, db.events, db.meta, async () => {
    const line = await db.lines.get(input.lineId);
    if (line === undefined || line.deleted === true) {
      throw new EntryRefusedError('That line is not one of the shop’s. Pick the line it was made on.');
    }
    if (!line.active) {
      throw new EntryRefusedError(`${line.name} is switched off in Settings. Switch it back on, or log it on the line that ran.`);
    }

    const codes = [...new Set(input.rows.map((r) => r.code))];
    const products = await db.products.bulkGet(codes);
    const known = products.filter((p): p is NonNullable<typeof p> => p !== undefined && p.deleted !== true);

    const lines: EntryLine[] = resolveEntryRows(input.rows, known);
    const refused = lines
      .filter((l) => l.problem !== null)
      .map((l) => ({ key: l.draft.key, problem: l.problem as string }));

    const usable = lines.filter((l) => l.problem === null);
    // Sequences continue from what the day already holds, so the number printed on
    // the rack means "the fourth one today" whatever else the day has had.
    if (usable.length === 0) return { created: [], refused };

    const sameDay = await db.batches
      .where('madeAt')
      .between(dayStart(madeAt), dayStart(madeAt) + 86_400_000, true, false)
      .toArray();
    const s = await getSettings();

    const stamp = actorStamp();
    const operator = stamp.actor;
    let sequence = nextBatchSequence(sameDay, madeAt, s.production.batchNumberFormat);

    const created: Batch[] = [];
    for (const entry of usable) {
      const batch = batchFromEntry({
        id: uid('batch'),
        product: entry.product as NonNullable<EntryLine['product']>,
        lineId: line.id,
        trays: entry.draft.trays as number,
        madeAt,
        sequence: sequence++,
        settings: s,
        operator,
      });
      await db.batches.add(batch);
      await logEvent('batch.create', {
        batchId: batch.id,
        code: batch.code,
        qty: batch.qty,
        trays: batch.trays,
        toStage: batch.stage,
        detail: `${batch.batchNo} · ${batch.trays} trays of ${batch.code} on ${line.name}`,
      });
      created.push(batch);
    }

    return { created, refused };
  });
}

/**
 * Take a logged make back.
 *
 * Only while it has gone nowhere — see `canUndo`. After that point a batch is
 * corrected by writing it off, which keeps both records and says why, because a
 * pallet has already been moved on the strength of it.
 */
export async function undoEntry(batchId: string, note = ''): Promise<Batch> {
  assertCan('production.record');
  return db.transaction('rw', db.batches, db.events, async () => {
    const batch = await db.batches.get(batchId);
    if (batch === undefined) throw new EntryRefusedError('That batch is not on this device.');
    if (!canUndo(batch)) {
      throw new EntryRefusedError(
        `${batch.batchNo} has been ${batch.enteredAt !== null ? 'keyed into MYOB' : batch.myobRunDate !== null ? 'put on a MYOB run' : batch.blastedQty > 0 ? 'blasted' : 'moved on'} since it was logged. Write it off instead, so both records stay.`,
      );
    }
    const cleared: Batch = { ...batch, deleted: true, updatedAt: Date.now() };
    await db.batches.put(cleared);
    await logEvent('batch.undo', {
      batchId: batch.id,
      code: batch.code,
      qty: batch.qty,
      trays: batch.trays,
      fromStage: batch.stage,
      detail: `${batch.batchNo} taken back${note === '' ? '' : ` — ${note}`}`,
    });
    return cleared;
  });
}

/** Everything made on a day, newest first, ignoring what has been taken back. */
export async function batchesOnDay(dayMs: number): Promise<Batch[]> {
  const from = dayStart(dayMs);
  const rows = await db.batches.where('madeAt').between(from, from + 86_400_000, true, false).toArray();
  // Newest first, and the same order in the tie-break: a rack logged a second ago
  // belongs at the top of the list, and two logged in the same second read in the
  // order the numbers were handed out, latest first.
  return rows.filter((b) => b.deleted !== true).sort((a, b) => b.madeAt - a.madeAt || b.batchNo.localeCompare(a.batchNo));
}

/** What one line has already logged today, so the sheet can show it and not twice. */
export async function batchesOnLineOnDay(lineId: string, dayMs: number): Promise<Batch[]> {
  return (await batchesOnDay(dayMs)).filter((b) => b.lineId === lineId);
}

/**
 * Moving a rack between stages.
 *
 * A move is a small, auditable act: one rack, one stage, one ledger line. The
 * sentence that explains why a move was refused is the same one the screen would
 * have shown, because `moveProblem` is the only place the rules live — a greyed
 * button and a thrown error must never disagree with each other.
 */
export async function moveBatchStage(batchId: string, to: BatchStage, note = ''): Promise<Batch> {
  assertCan('production.record');
  return db.transaction('rw', db.batches, db.events, db.meta, async () => {
    const batch = await db.batches.get(batchId);
    if (batch === undefined) throw new MoveRefusedError('That rack is not on this device.');
    const settings = await getSettings();
    const problem = moveProblem(batch, to, settings);
    if (problem !== null) throw new MoveRefusedError(problem);

    const moved: Batch = { ...batch, stage: to, updatedAt: Date.now() };
    await db.batches.put(moved);
    await logEvent('batch.move', {
      batchId: batch.id,
      code: batch.code,
      qty: batch.qty,
      trays: batch.trays,
      fromStage: batch.stage,
      toStage: to,
      detail: moveDetail(batch, to, note),
    });
    return moved;
  });
}

/**
 * Write a rack off.
 *
 * This is the honest end of a batch's life: it stays in the database with its
 * quantity, its date and the reason it went missing, and the ledger says who did
 * it. A reason is required because a write-off without one is how stock quietly
 * disappears twice.
 */
export async function writeOffBatch(batchId: string, reason: string): Promise<Batch> {
  assertCan('production.record');
  const why = reason.trim();
  if (why === '') {
    throw new MoveRefusedError('A write-off needs a reason. It is the only place the shop writes down why stock went missing.');
  }
  return db.transaction('rw', db.batches, db.events, db.meta, async () => {
    const batch = await db.batches.get(batchId);
    if (batch === undefined) throw new MoveRefusedError('That rack is not on this device.');
    const settings = await getSettings();
    const problem = moveProblem(batch, 'written_off', settings);
    if (problem !== null) throw new MoveRefusedError(problem);

    const off: Batch = { ...batch, stage: 'written_off', updatedAt: Date.now() };
    await db.batches.put(off);
    await logEvent('batch.writeOff', {
      batchId: batch.id,
      code: batch.code,
      qty: batch.qty,
      trays: batch.trays,
      fromStage: batch.stage,
      toStage: 'written_off',
      detail: `${batch.batchNo} written off — ${why}`,
    });
    return off;
  });
}

/**
 * The offered sweep: everything that has come off the cure, moved to Ready.
 *
 * The screen asks; this does not happen on a timer. `dueToAdvance` decides what
 * is due and this re-checks each one inside the transaction — a rack that got
 * blasted in another window between the question and the answer is reported
 * rather than moved on a stale read.
 */
export async function advanceDueBatches(
  lineId?: string,
  now = Date.now(),
): Promise<{ moved: Batch[]; refused: Array<{ batchNo: string; problem: string }> }> {
  assertCan('production.record');
  return db.transaction('rw', db.batches, db.events, db.meta, async () => {
    const settings = await getSettings();
    const all = await db.batches.toArray();
    const due = dueToAdvance(all, settings, now).filter((b) => lineId === undefined || b.lineId === lineId);
    const moved: Batch[] = [];
    const refused: Array<{ batchNo: string; problem: string }> = [];
    for (const batch of due) {
      const problem = moveProblem(batch, 'ready', settings, now);
      if (problem !== null) {
        refused.push({ batchNo: batch.batchNo, problem });
        continue;
      }
      const next: Batch = { ...batch, stage: 'ready', updatedAt: now };
      await db.batches.put(next);
      await logEvent('batch.move', {
        batchId: batch.id,
        code: batch.code,
        qty: batch.qty,
        trays: batch.trays,
        fromStage: batch.stage,
        toStage: 'ready',
        detail: `${batch.batchNo} off the racks — ${formatNumber(batch.trays, 0)} trays ready`,
      });
      moved.push(next);
    }
    return { moved, refused };
  });
}

/** Everything still on the racks, for the screens that read them. */
export async function racksOnTheClock(): Promise<Batch[]> {
  return (await db.batches.toArray()).filter(onTheRacks);
}

/**
 * Racks that have come off the cure and have not been keyed into MYOB yet — the
 * ready pile. Oldest make first: that is the one holding up an invoice.
 *
 * The Curing screen lists these under the racks still on the clock, so a rack
 * taken off by mistake has somewhere to be put back. The MYOB entry queue works
 * through the same list.
 */
export async function readyRacks(): Promise<Batch[]> {
  const rows = await db.batches.where('stage').equals('ready').toArray();
  return rows.filter((b) => b.deleted !== true).sort((a, b) => a.madeAt - b.madeAt);
}

/**
 * Put a rack on the blaster.
 *
 * The queue is the same list whether or not anyone tracks the booth minute to
 * minute, so this is optional: a shop that marks the rack as going in can, and a
 * shop that only writes down what came out can skip it. What it buys is the
 * *In the blaster* list — the thing you look at when somebody asks whether the
 * machine is free.
 */
export async function startBlast(batchId: string, now = Date.now()): Promise<Batch> {
  assertCan('production.record');
  return db.transaction('rw', db.batches, db.events, db.meta, async () => {
    const batch = await db.batches.get(batchId);
    if (batch === undefined) throw new MoveRefusedError('That rack is not on this device.');
    const settings = await getSettings();
    const problem = moveProblem(batch, 'blasting', settings, now);
    if (problem !== null) throw new MoveRefusedError(problem);

    const onIt: Batch = { ...batch, stage: 'blasting', updatedAt: now };
    await db.batches.put(onIt);
    await logEvent('batch.blast', {
      batchId: batch.id,
      code: batch.code,
      qty: batch.qty,
      trays: batch.trays,
      fromStage: batch.stage,
      toStage: 'blasting',
      detail: `${batch.batchNo} on the blaster — ${formatNumber(batch.trays, 0)} trays in`,
    });
    return onIt;
  });
}

/**
 * Take a rack out of the blaster, and write down how much of it went through.
 *
 * The floor counts trays, so the blast is counted in trays too. Fewer than the
 * rack holds splits it in two, and which half keeps the number matters: the trays
 * that came out of the machine keep the label that went in, and the rest becomes a
 * new batch with a new number and `parentBatchId` pointing back. A half-blasted
 * pallet that keeps the old number is a pallet that gets read as blasted next time
 * somebody walks past it.
 *
 * The blasted half goes back to `curing`, not `ready`. Whether it can be sold is
 * `readyAt`'s answer — on this shop's settings the blast stands in for the rest of
 * the cure, so the Curing screen will be offering it straight away — and a stage
 * set here would be a second answer to a question one function already answers.
 */
export async function finishBlast(
  batchId: string,
  trays: number,
  now = Date.now(),
): Promise<{ blasted: Batch; remainder: Batch | null }> {
  assertCan('production.record');
  return db.transaction('rw', db.batches, db.events, db.meta, async () => {
    const batch = await db.batches.get(batchId);
    if (batch === undefined) throw new MoveRefusedError('That rack is not on this device.');
    const problem = blastProblem(batch, trays);
    if (problem !== null) throw new MoveRefusedError(problem);

    const settings = await getSettings();
    const split = splitBlast(batch, trays);
    const blasted: Batch = {
      ...batch,
      trays: split.blastedTrays,
      qty: split.blastedQty,
      blastedQty: split.blastedQty,
      blastedAt: now,
      stage: 'curing',
      updatedAt: now,
    };
    await db.batches.put(blasted);
    await logEvent('batch.blast', {
      batchId: blasted.id,
      code: blasted.code,
      qty: blasted.qty,
      trays: blasted.trays,
      fromStage: batch.stage,
      toStage: 'curing',
      detail: split.whole
        ? `${batch.batchNo} through the blaster — all ${formatNumber(blasted.trays, 0)} trays out`
        : `${batch.batchNo} through the blaster — ${formatNumber(split.blastedTrays, 0)} of ${formatNumber(
            batch.trays,
            0,
          )} trays out`,
    });
    if (split.whole) return { blasted, remainder: null };

    // The remainder needs the day's next number, which is a question about every
    // batch on the device — read inside the transaction so two blasts finishing at
    // once cannot both claim it.
    const all = await db.batches.toArray();
    const pattern = settings.production.batchNumberFormat;
    const number = formatBatchNo(batch.madeAt, nextBatchSequence(all, batch.madeAt, pattern), pattern);
    const remainder: Batch = {
      ...batch,
      id: uid('b'),
      batchNo: number,
      trays: split.remainderTrays,
      qty: split.remainderQty,
      blastedQty: 0,
      blastedAt: null,
      stage: 'awaiting_shotblast',
      myobRunDate: null,
      enteredAt: null,
      enteredRef: '',
      parentBatchId: batch.id,
      rank: 0,
      updatedAt: now,
    };
    await db.batches.put(remainder);
    await logEvent('batch.split', {
      batchId: remainder.id,
      code: remainder.code,
      qty: remainder.qty,
      trays: remainder.trays,
      fromStage: batch.stage,
      toStage: 'awaiting_shotblast',
      detail: `${number} — the other ${formatNumber(remainder.trays, 0)} trays off ${batch.batchNo}, still to be blasted`,
    });
    return { blasted, remainder };
  });
}

/** Everything the blaster is owed, for the screen that works through it. */
export async function racksAwaitingBlast(): Promise<Batch[]> {
  return (await db.batches.toArray()).filter(awaitsBlast);
}

/**
 * Key a MYOB run in.
 *
 * One press stands for a morning of typing into MYOB, so it does three things at
 * once: it records that each rack was keyed, which run it was keyed against, and
 * what reference the shop was working from. After it the racks leave the queue —
 * the queue is "what is still sitting in the shop", and stock that is in MYOB is
 * somebody else's problem until the next export.
 *
 * What cannot be entered is refused and reported rather than blocking the run:
 * the list was drawn a minute ago, and one rack that turned out to still owe a
 * blast should not stop forty others being keyed. The refusal comes back in the
 * same words the screen would have used.
 *
 * Each rack records the run date derived for *it*, not one date stamped over the
 * lot, because a run routinely carries racks that came ready in different weeks.
 */
export async function markEntered(
  batchIds: string[],
  ref = '',
  now = Date.now(),
): Promise<{ entered: Batch[]; refused: Array<{ batchNo: string; reason: string }> }> {
  assertCan('myob.enter');
  return db.transaction('rw', db.batches, db.events, db.meta, async () => {
    const settings = await getSettings();
    const reference = ref.trim();
    const entered: Batch[] = [];
    const refused: Array<{ batchNo: string; reason: string }> = [];

    for (const id of new Set(batchIds)) {
      const batch = await db.batches.get(id);
      if (batch === undefined) {
        refused.push({ batchNo: id, reason: 'That rack is not on this device.' });
        continue;
      }
      const problem = enterProblem(batch, settings, now);
      if (problem !== null) {
        refused.push({ batchNo: batch.batchNo, reason: problem });
        continue;
      }
      const runDate = runDateFor(batch, settings, now) ?? assignMyobRunDate(now, settings);
      const keyed: Batch = {
        ...batch,
        stage: 'entered_myob',
        myobRunDate: runDate,
        enteredAt: now,
        enteredRef: reference,
        updatedAt: now,
      };
      await db.batches.put(keyed);
      await logEvent('batch.enterMyob', {
        batchId: keyed.id,
        code: keyed.code,
        qty: keyed.qty,
        trays: keyed.trays,
        fromStage: batch.stage,
        toStage: 'entered_myob',
        detail:
          `${batch.batchNo} keyed into MYOB — run ${formatDayFull(runDate)}` +
          ` · ${formatNumber(keyed.trays, 0)} trays · ${formatNumber(keyed.qty)} ${keyed.code}` +
          (reference === '' ? '' : ` · ref ${reference}`),
      });
      entered.push(keyed);
    }
    return { entered, refused };
  });
}

/**
 * Take a rack back out of a run.
 *
 * Keying goes wrong: a rack counted twice, a rack keyed that never left the yard.
 * Undoing the keying is not undoing an event — nothing moved — so it is allowed
 * with one press, and it leaves a ledger line saying so. The rack goes back to
 * `ready`, which is where the queue picks it up again.
 */
export async function unmarkEntered(batchId: string, now = Date.now()): Promise<Batch> {
  assertCan('myob.enter');
  return db.transaction('rw', db.batches, db.events, db.meta, async () => {
    const batch = await db.batches.get(batchId);
    if (batch === undefined) throw new MoveRefusedError('That rack is not on this device.');
    const problem = unenterProblem(batch);
    if (problem !== null) throw new MoveRefusedError(problem);

    const back: Batch = {
      ...batch,
      stage: 'ready',
      myobRunDate: null,
      enteredAt: null,
      enteredRef: '',
      updatedAt: now,
    };
    await db.batches.put(back);
    await logEvent('batch.undo', {
      batchId: back.id,
      code: back.code,
      qty: back.qty,
      trays: back.trays,
      fromStage: batch.stage,
      toStage: 'ready',
      detail: `${batch.batchNo} taken out of the MYOB run — it was not keyed after all`,
    });
    return back;
  });
}

/**
 * Every rack that has been keyed into MYOB, most recent first.
 *
 * The screen decides what to do with the list: what was keyed after the stock
 * export is still missing from every stock figure in the app, so it has to stay
 * visible for a while rather than vanish the moment it leaves the queue.
 */
export async function keyedRacks(): Promise<Batch[]> {
  return (await db.batches.toArray())
    .filter((b) => b.deleted !== true && b.enteredAt !== null)
    .sort((a, b) => (b.enteredAt ?? 0) - (a.enteredAt ?? 0) || a.batchNo.localeCompare(b.batchNo));
}

/** When the MYOB stock export was taken, or null when there is not one. */
export async function stockCapturedAt(): Promise<number | null> {
  const header = await db.stockSnapshots.orderBy('capturedAt').last();
  return header === undefined ? null : header.capturedAt;
}

/**
 * The ledger line for a move, in the words the log will be read in.
 *
 * Generic moves get the plain form; the two moves people actually search the log
 * for — off the cure and back onto it — say what happened rather than just the
 * stages, because a stage code is not a story.
 */
function moveDetail(batch: Batch, to: BatchStage, note: string): string {
  const extra = note.trim() === '' ? '' : ` — ${note.trim()}`;
  if (to === 'ready') return `${batch.batchNo} off the racks — ${formatNumber(batch.trays, 0)} trays ready${extra}`;
  if (to === 'curing' || to === 'green') return `${batch.batchNo} put back on the racks${extra}`;
  return `${batch.batchNo}: ${STAGE_LABELS[batch.stage]} to ${STAGE_LABELS[to].toLowerCase()}${extra}`;
}
