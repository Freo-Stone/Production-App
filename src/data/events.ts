import { uid } from '@/core/ids';
import { db } from '@/data/db';
import { actorStamp } from '@/data/principal';
import type { BatchStage, EventAction, EventLog } from '@/core/types';

/**
 * Append-only audit ledger.

 * Who did it comes from `src/data/principal.ts` — the signed-in account, not a name
 * typed into a box. This used to read `localStorage['freo.device']`, while the app
 * has always written `freo.deviceId`: every ledger row since then has said the word
 * "device" instead of naming a device, and the account name was whatever the person
 * had typed, including nothing at all.
 *
 * Never updated or deleted, and merged as a union across devices, so "who moved
 * this batch, when" survives any amount of last-write-wins on the records
 * themselves.
 */
export async function logEvent(
  action: EventAction,
  fields: {
    batchId?: string | null;
    code?: string | null;
    fromStage?: BatchStage | null;
    toStage?: BatchStage | null;
    qty?: number;
    trays?: number;
    detail?: string;
  } = {},
): Promise<EventLog> {
  const entry: EventLog = {
    id: uid('ev'),
    at: Date.now(),
    action,
    batchId: fields.batchId ?? null,
    code: fields.code ?? null,
    fromStage: fields.fromStage ?? null,
    toStage: fields.toStage ?? null,
    qty: fields.qty ?? 0,
    trays: fields.trays ?? 0,
    detail: fields.detail ?? '',
    ...actorStamp(),
  };
  await db.events.add(entry);
  return entry;
}

/** How many lines this device holds, for a header that says "of 1,204". */
export async function ledgerSize(): Promise<number> {
  return db.events.count();
}

/**
 * The newest `limit` lines, newest first.
 *
 * The log is read through a live query, so this runs again on every write. Reading
 * the whole table and sorting it in memory — which is what the old helper did — is
 * fine for forty lines and silly for a shop that has been logging for a year, so it
 * walks the `at` index backwards and stops at the window. The screen asks for more
 * when somebody presses *Show earlier lines*.
 */
export async function ledgerWindow(limit = 400): Promise<EventLog[]> {
  const want = Math.max(1, Math.min(5_000, Math.round(limit)));
  return db.events.orderBy('at').reverse().limit(want).toArray();
}

/**
 * One rack's whole history, newest first.
 *
 * Deliberately not the window filtered down: the line that says who moved a rack
 * three weeks ago is exactly the line that a busy fortnight has pushed out of the
 * newest four hundred.
 */
export async function ledgerForBatch(batchId: string, limit = 500): Promise<EventLog[]> {
  const rows = await db.events.where('batchId').equals(batchId).toArray();
  return rows.sort((a, b) => b.at - a.at).slice(0, limit);
}
