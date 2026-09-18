import Dexie, { type Table } from 'dexie';
import { DEFAULT_LINES, DEFAULT_SETTINGS } from '@/core/defaults';
import type {
  Batch,
  EventLog,
  JobsSnapshot,
  JobRow,
  Line,
  PlanItem,
  Product,
  Settings,
  StockRow,
  StockSnapshot,
  ViewDef,
} from '@/core/types';

/**
 * Local-first store. This database is the source of truth for rendering; the
 * shared GitHub document is a merge target, and the MYOB exports are read-only
 * mirrors. Screens therefore paint from IndexedDB with no network round-trip.
 */
export class FreoDB extends Dexie {
  products!: Table<Product, string>;
  lines!: Table<Line, string>;
  batches!: Table<Batch, string>;
  events!: Table<EventLog, string>;
  planItems!: Table<PlanItem, string>;

  stockSnapshots!: Table<Omit<StockSnapshot, 'rows'>, string>;
  stockRows!: Table<StockRowRecord, number>;

  jobsSnapshots!: Table<Omit<JobsSnapshot, 'rows'>, string>;
  jobRows!: Table<JobRowRecord, string>;

  views!: Table<ViewRecord, string>;
  meta!: Table<{ key: string; value: unknown }, string>;

  constructor(name = 'freo-stone') {
    super(name);

    this.version(1).stores({
      products: 'code, enabled, route, rank, updatedAt, deleted',
      lines: 'id, rank, kind',
      batches: 'id, code, stage, madeAt, myobRunDate, rank, updatedAt, lineId',
      events: 'id, at, batchId, action',
      planItems: 'id, code, status',

      // Snapshots keep their header separate from the rows so a 2,693-row stock
      // export can be queried per code without loading the whole document.
      stockSnapshots: 'id, capturedAt',
      stockRows: '++id, snapshotId, [snapshotId+code], code, location',

      jobsSnapshots: 'id, capturedAt',
      // The key is snapshot-scoped: the sales report repeats the same
      // (item, customer, order) line, and the same line reappears in every
      // export, so `id` alone cannot be a primary key across snapshots.
      jobRows: 'key, id, snapshotId, [snapshotId+itemCode], itemCode, promisedDate',

      views: 'key, screen, owner',
      meta: 'key',
    });
  }
}

export interface ViewRecord extends ViewDef {
  /** Composite key: `${screen}|${owner}` where owner is 'shared' or a device id. */
  key: string;
  screen: string;
  owner: 'shared' | string;
  isDefault: boolean;
}

/**
 * A stock row as stored. `id` is left to Dexie's auto-increment: hand-assigning
 * ids collided on the second import (ConstraintError), which would have made
 * every Monday re-export fail.
 */
export interface StockRowRecord extends StockRow {
  snapshotId: string;
  id?: number;
}

/** A job line as stored. `key` is unique per snapshot; `id` stays the app-facing id. */
export interface JobRowRecord extends JobRow {
  snapshotId: string;
  key: string;
}

export const db = new FreoDB();

/** Settings are a singleton row so they merge field-by-field across devices. */
export async function getSettings(): Promise<Settings> {
  const row = await db.meta.get('settings');
  // Merge over defaults so a new setting added in a later build is never undefined.
  return mergeDeep(structuredClone(DEFAULT_SETTINGS), (row?.value ?? {}) as Partial<Settings>) as Settings;
}

/**
 * Merge a patch over the stored settings. The read and the write share a
 * transaction for the same reason as every other read-modify-write here: two
 * saves a moment apart would otherwise both start from the same copy and the
 * later one would erase the earlier one's change.
 */
export async function saveSettings(patch: DeepPartial<Settings>): Promise<Settings> {
  return db.transaction('rw', db.meta, async () => {
    const current = await getSettings();
    const next = mergeDeep(structuredClone(current), patch) as Settings;
    await db.meta.put({ key: 'settings', value: next });
    return next;
  });
}

export async function getMeta<T>(key: string, fallback: T): Promise<T> {
  const row = await db.meta.get(key);
  return row == null ? fallback : (row.value as T);
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await db.meta.put({ key, value });
}

/** First-run seeding: lines and settings only. Products stay empty until an import. */
export async function seedIfEmpty(): Promise<void> {
  const lineCount = await db.lines.count();
  if (lineCount === 0) {
    const now = Date.now();
    await db.lines.bulkAdd(DEFAULT_LINES.map((l) => ({ ...l, updatedAt: now })));
  }
  if ((await db.meta.get('settings')) == null) {
    await db.meta.put({ key: 'settings', value: structuredClone(DEFAULT_SETTINGS) });
  }
}

/* ── Snapshot helpers ──────────────────────────────────────────────────────── */

export async function latestStockSnapshot(): Promise<StockSnapshot | null> {
  const header = await db.stockSnapshots.orderBy('capturedAt').last();
  if (!header) return null;
  const rows = await db.stockRows.where('snapshotId').equals(header.id).toArray();
  return { ...header, rows: rows.map(({ id: _id, snapshotId: _s, ...rest }) => rest) };
}

export async function latestJobsSnapshot(): Promise<JobsSnapshot | null> {
  const header = await db.jobsSnapshots.orderBy('capturedAt').last();
  if (!header) return null;
  const rows = await db.jobRows.where('snapshotId').equals(header.id).toArray();
  return { ...header, rows: rows.map(({ snapshotId: _s, key: _k, ...rest }) => rest) };
}

export async function replaceStockSnapshot(snapshot: StockSnapshot): Promise<void> {
  const { rows, ...header } = snapshot;
  await db.transaction('rw', db.stockSnapshots, db.stockRows, async () => {
    await db.stockSnapshots.add(header);
    // No id: the store is ++id.
    await db.stockRows.bulkAdd(rows.map((r) => ({ ...r, snapshotId: snapshot.id })));
    // Keep the last three exports so "stock as at" can be compared after a re-export.
    const all = await db.stockSnapshots.orderBy('capturedAt').toArray();
    for (const old of all.slice(0, Math.max(0, all.length - 3))) {
      await db.stockRows.where('snapshotId').equals(old.id).delete();
      await db.stockSnapshots.delete(old.id);
    }
  });
}

export async function replaceJobsSnapshot(snapshot: JobsSnapshot): Promise<void> {
  const { rows, ...header } = snapshot;
  await db.transaction('rw', db.jobsSnapshots, db.jobRows, async () => {
    await db.jobsSnapshots.add(header);
    await db.jobRows.bulkAdd(
      rows.map((r) => ({ ...r, snapshotId: snapshot.id, key: `${snapshot.id}|${r.id}` })),
    );
    const all = await db.jobsSnapshots.orderBy('capturedAt').toArray();
    for (const old of all.slice(0, Math.max(0, all.length - 3))) {
      await db.jobRows.where('snapshotId').equals(old.id).delete();
      await db.jobsSnapshots.delete(old.id);
    }
  });
}

/* ── Deep merge used by settings and by the sync layer ─────────────────────── */

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function mergeDeep<T>(target: T, patch: unknown): T {
  if (!isPlainObject(patch)) return target;
  const out = (isPlainObject(target) ? { ...target } : {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(out[k]) && isPlainObject(v) ? mergeDeep(out[k], v) : v;
  }
  return out as T;
}
