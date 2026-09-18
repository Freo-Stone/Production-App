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

export async function recentEvents(limit = 200): Promise<EventLog[]> {
  const all = await db.events.toArray();
  return all.sort((a, b) => b.at - a.at).slice(0, limit);
}
