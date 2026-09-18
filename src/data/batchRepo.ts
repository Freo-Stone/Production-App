import {
  batchFromEntry,
  canUndo,
  nextBatchSequence,
  resolveEntryRows,
  type EntryDraft,
  type EntryLine,
} from '@/core/batches';
import { dayStart } from '@/core/dates';
import { uid } from '@/core/ids';
import type { Batch } from '@/core/types';
import { db, getSettings } from '@/data/db';
import { logEvent } from '@/data/events';
import { actorStamp, assertCan } from '@/data/principal';

/**
 * Writing production down.
 *
 * This is the only place in the app that creates a batch, and the only place that
 * takes one back. Everything the rest of the make side needs — curing, shotblast,
 * the MYOB queue, the log — reads records that were made here, which is why the
 * rules are kept narrow and loud:
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
