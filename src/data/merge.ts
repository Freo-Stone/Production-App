/**
 * Shared-state merge engine.
 *
 * Two devices can be offline at the same time and then both push, so the merge
 * has to be *commutative* and *lossless*: `mergeDocuments(A, B)` and
 * `mergeDocuments(B, A)` must land on the same record set, otherwise whichever
 * device pushes last silently rewrites the other's history.
 *
 * Pure on purpose — no DOM, no Dexie, no clock — so it can be unit-tested and
 * reused by the restore-from-commit screen.
 */
import { DEFAULT_SETTINGS } from '@/core/defaults';
import type { Batch, EventLog, Line, PlanItem, Product, Settings } from '@/core/types';
// ViewRecord lives next to the Dexie table it keys. `import type` is erased by
// the compiler, so this module still has no runtime dependency on Dexie.
import type { FreoDB, ViewRecord } from '@/data/db';

export const STATE_DOC_VERSION = 1 as const;

/** Everything the shop shares, as one JSON file in git. */
export interface StateDocument {
  version: 1;
  /** Write-out stamp, not edit time. Settings have no stamp of their own, so
   *  this is what gives field-level settings precedence to the last writer. */
  updatedAt: number;
  products: Product[];
  lines: Line[];
  batches: Batch[];
  events: EventLog[];
  planItems: PlanItem[];
  views: ViewRecord[];
  settings: Settings;
  /** Device that produced this revision — provenance for the audit trail. */
  device: string;
}

export type CollectionName = 'products' | 'lines' | 'batches' | 'events' | 'planItems' | 'views' | 'settings';

/** Namespace a dirty key by collection, so ids that repeat across tables
 *  (batches and plan items are both uuids) stay distinct in the queue. */
export function dirtyName(entity: CollectionName, key = '*'): string {
  return `${entity}:${key}`;
}

/** Minimum a record must carry to take part in last-write-wins. */
interface Stamp {
  updatedAt: number;
  deleted?: boolean;
}

type Keyed<T> = (record: T) => string;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Content-order tiebreak. Used wherever two records tie on time, so the
 *  winner never depends on which document happened to be the "local" one. */
const fingerprint = (record: unknown): string => JSON.stringify(record);

/**
 * True when `a` should displace `b`.
 *
 * A tombstone beats an *older* edit — otherwise a delete racing an update on
 * another device would resurrect the record on the next sync — but loses to a
 * newer real edit, which is the deliberate "they fixed it after I deleted it"
 * case. On an exact tie the deletion wins.
 */
function wins(a: Stamp, b: Stamp): boolean {
  const aGone = a.deleted === true;
  const bGone = b.deleted === true;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt;
  if (aGone !== bGone) return aGone;
  return fingerprint(a) <= fingerprint(b);
}

/** Per-record last-write-wins, sorted by key so the git diff stays readable. */
export function mergeList<T extends Stamp>(local: T[], remote: T[], keyOf: Keyed<T>): T[] {
  const byKey = new Map<string, T>();
  for (const row of remote) byKey.set(keyOf(row), row);
  for (const row of local) {
    const key = keyOf(row);
    const other = byKey.get(key);
    if (!other || wins(row, other)) byKey.set(key, row);
  }
  return [...byKey.values()].sort((a, b) => cmp(keyOf(a), keyOf(b)));
}

/**
 * The ledger is append-only, so events are a straight union: dropping one would
 * erase the audit trail. Ids are uuids, so a repeated id is the same fact
 * arriving twice; on the rare content mismatch the lower-serialising copy wins
 * to keep the merge commutative.
 */
export function mergeEvents(local: EventLog[], remote: EventLog[]): EventLog[] {
  const byId = new Map<string, EventLog>();
  for (const row of remote) byId.set(row.id, row);
  for (const row of local) {
    const other = byId.get(row.id);
    if (!other || fingerprint(row) < fingerprint(other)) byId.set(row.id, row);
  }
  return [...byId.values()].sort((a, b) => a.at - b.at || cmp(a.id, b.id));
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep overlay: `top` wins per leaf, keys only present in `base` are kept. */
export function overlay<T>(base: T, top: T): T {
  if (!isPlain(base) || !isPlain(top)) return top;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(top)) {
    if (value === undefined) continue;
    const existing = out[key];
    out[key] = isPlain(existing) && isPlain(value) ? overlay(existing, value) : value;
  }
  return out as T;
}

/**
 * Settings are one shared singleton with no per-field stamp, so the merge is a
 * deep overlay: whatever the winning document does not describe — a subtree an
 * older build never wrote — survives from the other side. Because a real
 * Settings object describes every field, a field *both* devices changed resolves
 * to the newer document. That is the one place a settings edit can be lost, and
 * an equal stamp is broken by content rather than argument order so the result
 * stays commutative.
 */
export function mergeSettings(local: Settings, remote: Settings, localAt: number, remoteAt: number): Settings {
  const localWins = localAt === remoteAt ? fingerprint(local) > fingerprint(remote) : localAt > remoteAt;
  return localWins ? overlay(remote, local) : overlay(local, remote);
}

const byCode: Keyed<Product> = (p) => p.code;
const byId = <T extends { id: string }>(r: T): string => r.id;
const byKey: Keyed<ViewRecord> = (v) => v.key;

/** Stable order on write-out: git diffs of state.json stay line-comparable. */
export function sortForWrite(doc: StateDocument): StateDocument {
  return {
    ...doc,
    // Products merge on the MYOB item number: it *is* the identity and can never
    // change, whereas a device-generated id would duplicate an item on reimport.
    products: [...doc.products].sort((a, b) => cmp(a.code, b.code)),
    lines: [...doc.lines].sort((a, b) => cmp(a.id, b.id)),
    batches: [...doc.batches].sort((a, b) => cmp(a.id, b.id)),
    events: [...doc.events].sort((a, b) => a.at - b.at || cmp(a.id, b.id)),
    planItems: [...doc.planItems].sort((a, b) => cmp(a.id, b.id)),
    views: [...doc.views].sort((a, b) => cmp(a.key, b.key)),
  };
}

export function mergeDocuments(local: StateDocument, remote: StateDocument): StateDocument {
  return sortForWrite({
    version: STATE_DOC_VERSION,
    updatedAt: Math.max(local.updatedAt, remote.updatedAt),
    products: mergeList(local.products, remote.products, byCode),
    lines: mergeList(local.lines, remote.lines, byId),
    batches: mergeList(local.batches, remote.batches, byId),
    events: mergeEvents(local.events, remote.events),
    // A view key already carries its owner (`screen|device`), so two users
    // editing their own views never contend for the same record.
    views: mergeList(local.views, remote.views, byKey),
    planItems: mergeList(local.planItems, remote.planItems, byId),
    settings: mergeSettings(local.settings, remote.settings, local.updatedAt, remote.updatedAt),
    device: local.device,
  });
}

export function emptyDocument(device: string, now = 0): StateDocument {
  return {
    version: STATE_DOC_VERSION,
    updatedAt: now,
    products: [],
    lines: [],
    batches: [],
    events: [],
    planItems: [],
    views: [],
    settings: structuredClone(DEFAULT_SETTINGS),
    device,
  };
}

function maxStamp(rows: ReadonlyArray<{ updatedAt?: number; at?: number }>): number {
  let max = 0;
  for (const row of rows) max = Math.max(max, row.updatedAt ?? row.at ?? 0);
  return max;
}

/** Newest thing anywhere in the document, ignoring the write-out stamp. */
export function latestTouch(doc: StateDocument): number {
  return Math.max(
    maxStamp(doc.products),
    maxStamp(doc.lines),
    maxStamp(doc.batches),
    maxStamp(doc.events),
    maxStamp(doc.planItems),
    maxStamp(doc.views),
  );
}

export function changedSince(doc: StateDocument, timestamp: number): boolean {
  return latestTouch(doc) > timestamp;
}

/** How many records a push would actually carry. Lets the engine stay quiet
 *  when a scheduled sync has nothing new to say. */
export function countPending(doc: StateDocument, watermark: number): number {
  const lists: Array<ReadonlyArray<{ updatedAt?: number; at?: number }>> = [
    doc.products,
    doc.lines,
    doc.batches,
    doc.events,
    doc.planItems,
    doc.views,
  ];
  let n = 0;
  for (const list of lists) for (const row of list) if ((row.updatedAt ?? row.at ?? 0) > watermark) n += 1;
  return n;
}

export interface ReconcileResult {
  doc: StateDocument;
  /** Local rows the merge could not account for, put back. */
  restored: string[];
  /** Unpushed local edits that beat a remote tombstone. */
  defended: string[];
  /** Unpushed local edits that lost to a newer shared copy (LWW honoured). */
  overwritten: string[];
}

/**
 * Belt-and-braces pass over the merge result. `mergeDocuments` cannot drop a
 * key by construction, but the *remote* document can be behind (an older app
 * build, or a state.json edited by hand), so anything the local device had and
 * the merge cannot explain is restored and reported.
 *
 * A local record that has been edited but not yet pushed is never deleted by a
 * remote tombstone: a sync must not throw away work nobody has seen. The
 * operator can still delete it deliberately afterwards.
 */
export function reconcileLocal(
  local: StateDocument,
  merged: StateDocument,
  dirty: ReadonlySet<string>,
): ReconcileResult {
  const restored: string[] = [];
  const defended: string[] = [];
  const overwritten: string[] = [];

  function protect<T extends Stamp>(name: CollectionName, localRows: T[], mergedRows: T[], keyOf: Keyed<T>): T[] {
    const index = new Map<string, T>();
    for (const row of mergedRows) index.set(keyOf(row), row);
    for (const row of localRows) {
      const key = keyOf(row);
      const label = `${name} ${key}`;
      const theirs = index.get(key);
      if (!theirs) {
        // Absent *and* not locally deleted means the merge lost it. A local
        // tombstone is a legitimate absence: the key may be gone for good.
        if (row.deleted !== true) {
          restored.push(label);
          index.set(key, row);
        }
        continue;
      }
      if (theirs.updatedAt < row.updatedAt) {
        restored.push(label);
        index.set(key, row);
        continue;
      }
      const editedLocally = dirty.has(dirtyName(name, key));
      if (editedLocally && fingerprint(theirs) !== fingerprint(row)) {
        if (theirs.deleted === true) {
          // An unsynced local edit is never deleted by a remote tombstone.
          index.set(key, row);
          defended.push(label);
        } else {
          overwritten.push(label);
        }
      }
    }
    return [...index.values()].sort((a, b) => cmp(keyOf(a), keyOf(b)));
  }

  const doc: StateDocument = {
    ...merged,
    products: protect('products', local.products, merged.products, byCode),
    lines: protect('lines', local.lines, merged.lines, byId),
    batches: protect('batches', local.batches, merged.batches, byId),
    planItems: protect('planItems', local.planItems, merged.planItems, byId),
    views: protect('views', local.views, merged.views, byKey),
  };
  return { doc: sortForWrite(doc), restored, defended, overwritten };
}

/* ── Database bridge ───────────────────────────────────────────────────────── */

export const SETTINGS_KEY = 'settings';
export const WATERMARK_KEY = 'sync.watermark';

/** Structural view of the tables sync touches. Tests hand in an in-memory fake;
 *  the real Dexie tables satisfy it too (checked at compile time below). */
type TableLike<T> = {
  toArray(): Promise<T[]>;
  bulkPut(rows: readonly T[]): Promise<unknown>;
};

export interface SyncDatabase {
  products: TableLike<Product>;
  lines: TableLike<Line>;
  batches: TableLike<Batch>;
  events: TableLike<EventLog>;
  planItems: TableLike<PlanItem>;
  views: TableLike<ViewRecord>;
  meta: {
    get(key: string): Promise<{ key: string; value: unknown } | undefined>;
    put(row: { key: string; value: unknown }): Promise<unknown>;
  };
}

type StrictlyTrue<T extends true> = T;
export type DexieSatisfiesSyncDatabase = StrictlyTrue<FreoDB extends SyncDatabase ? true : false>;

function sortEvents(events: EventLog[]): EventLog[] {
  return [...events].sort((a, b) => a.at - b.at || cmp(a.id, b.id));
}

/** Read the whole local database into a document, in write-out order. */
export async function documentFromDb(
  dexie: SyncDatabase,
  opts: { device: string; now?: number },
): Promise<StateDocument> {
  const [products, lines, batches, events, planItems, views, row] = await Promise.all([
    dexie.products.toArray(),
    dexie.lines.toArray(),
    dexie.batches.toArray(),
    dexie.events.toArray(),
    dexie.planItems.toArray(),
    dexie.views.toArray(),
    dexie.meta.get(SETTINGS_KEY),
  ]);
  const stored = (row?.value ?? {}) as unknown as Settings;
  // Same overlay getSettings() uses, so a field added in a later build is never
  // undefined in a document handed to another device.
  const settings = overlay(structuredClone(DEFAULT_SETTINGS), stored);
  const doc: StateDocument = {
    version: STATE_DOC_VERSION,
    updatedAt: Math.max(
      opts.now ?? Date.now(),
      maxStamp(products),
      maxStamp(lines),
      maxStamp(batches),
      maxStamp(planItems),
      maxStamp(views),
    ),
    products,
    lines,
    batches,
    events: sortEvents(events),
    planItems,
    views,
    settings,
    device: opts.device,
  };
  return sortForWrite(doc);
}

/**
 * Write a merged document back. Deliberately additive: deletions travel as
 * tombstones, and where a record type has no tombstone field (`ViewRecord`)
 * sync never removes anything — resurrecting a view is recoverable, losing one
 * is not.
 */
export async function applyDocumentToDb(dexie: SyncDatabase, doc: StateDocument): Promise<void> {
  await dexie.products.bulkPut(doc.products);
  await dexie.lines.bulkPut(doc.lines);
  await dexie.batches.bulkPut(doc.batches);
  await dexie.events.bulkPut(doc.events);
  await dexie.planItems.bulkPut(doc.planItems);
  await dexie.views.bulkPut(doc.views);
  await dexie.meta.put({ key: SETTINGS_KEY, value: doc.settings });
}
