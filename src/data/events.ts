import { uid } from '@/core/ids';
import { db } from '@/data/db';
import type { BatchStage, EventAction, EventLog } from '@/core/types';

/** Read device-local identity bits without assuming a browser exists (tests run in node). */
function readStored(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Who or what produced an event: the device id plus the name on this browser. */
function actorFields(): { device: string; actor: string } {
  const device = readStored('freo.device') ?? 'device';
  let actor = '';
  try {
    const raw = readStored('freo.session');
    const name = raw ? (JSON.parse(raw)?.state?.name as string | undefined) : undefined;
    actor = name ?? '';
  } catch {
    actor = '';
  }
  return { device, actor };
}

/**
 * Append-only audit ledger.
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
    ...actorFields(),
  };
  await db.events.add(entry);
  return entry;
}

export async function recentEvents(limit = 200): Promise<EventLog[]> {
  const all = await db.events.toArray();
  return all.sort((a, b) => b.at - a.at).slice(0, limit);
}
