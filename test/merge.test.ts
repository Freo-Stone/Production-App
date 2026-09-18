import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, defaultView } from '@/core/defaults';
import type {
  Account,
  Batch,
  DeviceRecord,
  EventLog,
  Line,
  PlanItem,
  Product,
  Settings,
  ViewDef,
} from '@/core/types';
import type { ViewRecord } from '@/data/db';
import {
  applyDocumentToDb,
  changedSince,
  countPending,
  documentFromDb,
  emptyDocument,
  latestTouch,
  mergeDocuments,
  mergeEvents,
  mergeList,
  mergeSettings,
  reconcileLocal,
  sortForWrite,
  withCollections,
  type StateDocument,
} from '@/data/merge';

/* ── Fixtures ──────────────────────────────────────────────────────────────── */

function product(code: string, over: Partial<Product> = {}): Product {
  return {
    code,
    description: `PAVER ${code}`,
    enabled: true,
    route: 'manufacture',
    usesBaseline10000: false,
    unit: 'm2',
    trayYield: 1.44,
    target: 1000,
    cureDays: 2,
    notes: '',
    rank: 1000,
    seenInJobs: false,
    updatedAt: 1000,
    ...over,
  };
}

function batch(id: string, over: Partial<Batch> = {}): Batch {
  return {
    id,
    batchNo: `2026-09-17-${id}`,
    code: 'S3',
    lineId: 'line-1',
    trays: 10,
    qty: 14.4,
    qtyOverridden: false,
    routeSnapshot: 'manufacture',
    stage: 'curing',
    madeAt: 1000,
    cureDaysSnapshot: 2,
    cureDueAt: 3000,
    blastedQty: 0,
    blastedAt: null,
    myobRunDate: null,
    enteredAt: null,
    enteredRef: '',
    operator: 'jo',
    note: '',
    rank: 1000,
    parentBatchId: null,
    updatedAt: 1000,
    ...over,
  };
}

function line(id: string, over: Partial<Line> = {}): Line {
  return { id, name: id, kind: 'standard', active: true, rank: 1000, updatedAt: 1000, ...over };
}

function planItem(id: string, over: Partial<PlanItem> = {}): PlanItem {
  return {
    id,
    code: 'S3',
    qty: 100,
    latestStartDate: null,
    promisedFor: null,
    route: 'manufacture',
    status: 'planned',
    linkedJobIds: [],
    note: '',
    rank: 1000,
    updatedAt: 1000,
    ...over,
  };
}

function event(id: string, at: number, over: Partial<EventLog> = {}): EventLog {
  return {
    id,
    at,
    action: 'batch.create',
    batchId: 'b1',
    code: 'S3',
    fromStage: null,
    toStage: 'curing',
    qty: 14.4,
    trays: 10,
    device: 'dev-a',
    actor: 'jo',
    detail: '',
    ...over,
  };
}

function view(screen: string, owner: string, over: Partial<ViewDef> = {}): ViewRecord {
  return {
    ...defaultView(screen, ['code', 'description', 'qty']),
    key: `${screen}|${owner}`,
    screen,
    owner,
    isDefault: owner === 'shared',
    ...over,
  };
}

function account(id: string, over: Partial<Account> = {}): Account {
  return {
    id,
    name: 'Test Person',
    role: 'maker',
    passcode: { salt: 'c2FsdHNhbHRzYWx0YTE=', hash: 'aGFzaA==', iterations: 1_000 },
    disabled: false,
    note: '',
    createdAt: 1000,
    createdBy: 'acct-owner',
    updatedAt: 1000,
    ...over,
  };
}

function device(id: string, over: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    id,
    label: 'Shop floor PC',
    userId: 'acct-owner',
    signedInAt: 1000,
    lastSeenAt: 1000,
    revoked: false,
    updatedAt: 1000,
    ...over,
  };
}

function doc(over: Partial<StateDocument> = {}): StateDocument {
  return { ...emptyDocument('dev-a', 1000), ...over };
}

function settings(over: Partial<Settings> = {}): Settings {
  return { ...structuredClone(DEFAULT_SETTINGS), ...over };
}

/** Records only — the fields a merge must agree on regardless of argument order. */
const records = (d: StateDocument): unknown => ({
  products: d.products,
  lines: d.lines,
  batches: d.batches,
  events: d.events,
  planItems: d.planItems,
  views: d.views,
  users: d.users,
  devices: d.devices,
  settings: d.settings,
  updatedAt: d.updatedAt,
});

/* ── Last write wins ───────────────────────────────────────────────────────── */

describe('mergeDocuments — record level', () => {
  it('keeps the newer edit when two devices change the same product', () => {
    // Products merge on the MYOB code: it is the identity, so both devices are
    // genuinely describing the same item.
    const local = doc({ products: [product('S3', { target: 4752, updatedAt: 2000 })] });
    const remote = doc({
      device: 'dev-b',
      products: [product('S3', { target: 5000, updatedAt: 3000 })],
    });

    const merged = mergeDocuments(local, remote);

    expect(merged.products).toHaveLength(1);
    expect(merged.products[0]?.target).toBe(5000);
  });

  it('keeps both when the devices edited different products', () => {
    const local = doc({ products: [product('S3', { target: 4752, updatedAt: 2000 })] });
    const remote = doc({ device: 'dev-b', products: [product('M6', { target: 200, updatedAt: 2000 })] });

    const merged = mergeDocuments(local, remote);

    expect(merged.products.map((p) => p.code)).toEqual(['M6', 'S3']);
  });

  it('lets a delete beat an older edit on another device', () => {
    // Without the tombstone rule the older edit would resurrect the row on the
    // next push from the device that never saw the delete.
    const local = doc({ products: [product('S3', { deleted: true, updatedAt: 3000 })] });
    const remote = doc({ device: 'dev-b', products: [product('S3', { target: 900, updatedAt: 2000 })] });

    const merged = mergeDocuments(local, remote);

    expect(merged.products).toHaveLength(1);
    expect(merged.products[0]?.deleted).toBe(true);
  });

  it('lets a newer edit beat an older delete, in both argument orders', () => {
    // "Someone fixed it after I decided to delete it" — the edit is the later
    // fact, and the merge must not depend on which side is local.
    const deleted = doc({ products: [product('S3', { deleted: true, updatedAt: 2000 })] });
    const edited = doc({ device: 'dev-b', products: [product('S3', { target: 900, updatedAt: 3000 })] });

    expect(mergeDocuments(deleted, edited).products[0]?.deleted).toBeFalsy();
    expect(mergeDocuments(edited, deleted).products[0]?.deleted).toBeFalsy();
    expect(mergeDocuments(deleted, edited).products[0]?.target).toBe(900);
  });

  it('breaks an exact timestamp tie by content, so both orders agree', () => {
    const a = doc({ lines: [line('line-1', { name: 'Handmade', updatedAt: 5000 })] });
    const b = doc({ device: 'dev-b', lines: [line('line-1', { name: 'Curing shed', updatedAt: 5000 })] });

    expect(mergeDocuments(a, b).lines[0]?.name).toBe(mergeDocuments(b, a).lines[0]?.name);
  });

  it('merges batches, lines and plan items on id', () => {
    const local = doc({
      lines: [line('line-1', { active: false, updatedAt: 2000 })],
      batches: [batch('b1', { trays: 12, updatedAt: 2000 })],
      planItems: [planItem('p1', { qty: 200, updatedAt: 2000 })],
    });
    const remote = doc({
      device: 'dev-b',
      lines: [line('line-2', { updatedAt: 1500 })],
      batches: [batch('b1', { trays: 4, updatedAt: 1000 }), batch('b2', { updatedAt: 1500 })],
      planItems: [planItem('p1', { qty: 50, updatedAt: 1500 })],
    });

    const merged = mergeDocuments(local, remote);

    expect(merged.lines.map((l) => l.id)).toEqual(['line-1', 'line-2']);
    expect(merged.batches.map((b) => [b.id, b.trays])).toEqual([
      ['b1', 12],
      ['b2', 10],
    ]);
    expect(merged.planItems[0]?.qty).toBe(200);
  });
});

/* ── The audit ledger ──────────────────────────────────────────────────────── */

describe('events', () => {
  it('unions the ledger and never drops an entry', () => {
    const local = doc({ events: [event('e1', 1000), event('e3', 3000, { action: 'batch.move' })] });
    const remote = doc({ device: 'dev-b', events: [event('e2', 2000, { device: 'dev-b' })] });

    const merged = mergeDocuments(local, remote);

    expect(merged.events.map((e) => e.id)).toEqual(['e1', 'e2', 'e3']);
    expect(merged.events.map((e) => e.at), 'sorted by time, not by arrival').toEqual([1000, 2000, 3000]);
  });

  it('keeps a shared event exactly once and survives the same fact twice', () => {
    const shared = event('e1', 1000);
    const merged = mergeEvents([shared, event('e2', 1500)], [shared, event('e3', 1800)]);
    expect(merged.map((e) => e.id)).toEqual(['e1', 'e2', 'e3']);
  });

  it('does not invent an updatedAt on ledger rows', () => {
    // Events order on `at`; they are immutable facts, so they carry no merge stamp.
    const merged = mergeDocuments(doc({ events: [event('e1', 9000)] }), doc({ device: 'dev-b' }));
    expect(merged.events[0]).not.toHaveProperty('updatedAt');
  });
});

/* ── Views are per-owner ───────────────────────────────────────────────────── */

describe('views', () => {
  it('never lets one user’s column layout collide with another’s', () => {
    const local = doc({
      views: [view('matrix', 'dev-a', { density: 'compact', updatedAt: 2000 }), view('matrix', 'shared', { updatedAt: 1000 })],
    });
    const remote = doc({
      device: 'dev-b',
      views: [view('matrix', 'dev-b', { density: 'roomy', updatedAt: 2500 }), view('jobs', 'dev-b', { updatedAt: 2500 })],
    });

    const merged = mergeDocuments(local, remote);

    expect(merged.views.map((v) => v.key)).toEqual(['jobs|dev-b', 'matrix|dev-a', 'matrix|dev-b', 'matrix|shared']);
    expect(merged.views.find((v) => v.key === 'matrix|dev-a')?.density).toBe('compact');
    expect(merged.views.find((v) => v.key === 'matrix|dev-b')?.density).toBe('roomy');
    expect(merged.views.find((v) => v.key === 'matrix|shared')?.updatedAt).toBe(1000);
  });

  it('resolves two edits to the same owner’s view by timestamp', () => {
    const local = doc({ views: [view('matrix', 'shared', { density: 'compact', updatedAt: 4000 })] });
    const remote = doc({ device: 'dev-b', views: [view('matrix', 'shared', { density: 'roomy', updatedAt: 3000 })] });
    expect(mergeDocuments(local, remote).views[0]?.density).toBe('compact');
  });
});

/* ── Settings ──────────────────────────────────────────────────────────────── */

describe('settings', () => {
  it('merges nested fields instead of replacing the settings block wholesale', () => {
    // A document written by an older build simply has no `appearance` or
    // `myobEntry`. The overlay must keep what the newer document never
    // described instead of falling back to defaults for those parts.
    const described = settings({ appearance: { ...DEFAULT_SETTINGS.appearance, theme: 'light' } });
    const partial = structuredClone(DEFAULT_SETTINGS) as Partial<Settings>;
    delete partial.appearance;
    delete partial.myobEntry;

    const merged = mergeSettings(described, partial as Settings, 2000, 3000);

    expect(merged.appearance.theme, 'the newer document says nothing about appearance').toBe('light');
    expect(merged.myobEntry.memoTemplate).toBe(DEFAULT_SETTINGS.myobEntry.memoTemplate);
    expect(merged.production.defaultCureDays).toBe(DEFAULT_SETTINGS.production.defaultCureDays);
  });

  it('is commutative on settings when both documents carry the same stamp', () => {
    // Settings have no per-field stamp, so a field both devices changed resolves
    // to one side. That is the one place a settings edit can be lost — which is
    // exactly why the merge result must not depend on argument order either.
    const a = settings({ planning: { ...DEFAULT_SETTINGS.planning, bufferDays: 1 } });
    const b = settings({ planning: { ...DEFAULT_SETTINGS.planning, bufferDays: 4 } });
    expect(mergeSettings(a, b, 5000, 5000)).toEqual(mergeSettings(b, a, 5000, 5000));
    expect(mergeSettings(a, b, 5000, 5000).planning.bufferDays).toBe(4);
  });

  it('gives the newer document the field both devices changed', () => {
    const older = settings({ production: { ...DEFAULT_SETTINGS.production, defaultCureDays: 2 } });
    const newer = settings({ production: { ...DEFAULT_SETTINGS.production, defaultCureDays: 5 } });
    expect(mergeSettings(older, newer, 1000, 2000).production.defaultCureDays).toBe(5);
    expect(mergeSettings(newer, older, 2000, 1000).production.defaultCureDays).toBe(5);
  });

  it('replaces a list wholesale rather than inventing element merge', () => {
    // exportColumns order *is* the meaning of the field.
    const local = settings({
      sources: { ...DEFAULT_SETTINGS.sources, stockLocations: ['HQ', 'GW'] },
    });
    const remote = settings({ sources: { ...DEFAULT_SETTINGS.sources, stockLocations: ['HQ'] } });
    expect(mergeSettings(local, remote, 1000, 2000).sources.stockLocations).toEqual(['HQ']);
    expect(mergeSettings(local, remote, 2000, 1000).sources.stockLocations).toEqual(['HQ', 'GW']);
  });
});

/* ── Determinism ───────────────────────────────────────────────────────────── */

describe('determinism', () => {
  const busier = (): StateDocument =>
    doc({
      updatedAt: 5000,
      products: [product('S3', { target: 4752, updatedAt: 4000 }), product('M6', { deleted: true, updatedAt: 5000 })],
      batches: [batch('b1', { trays: 9, updatedAt: 4500 })],
      events: [event('e1', 1000), event('e2', 2000)],
      planItems: [planItem('p1', { status: 'started', updatedAt: 4000 })],
      views: [view('matrix', 'dev-a', { updatedAt: 4000 })],
    });

  const other = (): StateDocument =>
    doc({
      device: 'dev-b',
      updatedAt: 5000,
      products: [product('S3', { target: 1500, updatedAt: 4000 }), product('I3', { updatedAt: 4200 })],
      batches: [batch('b1', { trays: 3, updatedAt: 4600 }), batch('b2', { updatedAt: 4100 })],
      events: [event('e2', 2000), event('e3', 2100)],
      planItems: [planItem('p1', { qty: 10, updatedAt: 4100 })],
      views: [view('matrix', 'dev-b', { updatedAt: 4000 })],
    });

  it('merging A into B equals merging B into A', () => {
    // Not a nicety: if the two orders differed, each device would keep flipping
    // the shared file and every push would show as a change.
    expect(records(mergeDocuments(busier(), other()))).toEqual(records(mergeDocuments(other(), busier())));
  });

  it('is idempotent — merging a document with itself changes nothing', () => {
    const a = busier();
    const once = mergeDocuments(a, other());
    expect(records(mergeDocuments(once, once))).toEqual(records(once));
  });

  it('writes collections in a stable order so git diffs stay readable', () => {
    const unsorted = doc({
      products: [product('S3'), product('A3'), product('M6')],
      events: [event('e2', 2000), event('e1', 1000)],
    });
    const sorted = sortForWrite(unsorted);
    expect(sorted.products.map((p) => p.code)).toEqual(['A3', 'M6', 'S3']);
    expect(sorted.events.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(mergeDocuments(unsorted, doc()).products.map((p) => p.code)).toEqual(['A3', 'M6', 'S3']);
  });

  it('sorts mergeList by key regardless of input order', () => {
    const rows = [line('line-3'), line('line-1'), line('line-2')];
    expect(mergeList(rows, [], (l) => l.id).map((l) => l.id)).toEqual(['line-1', 'line-2', 'line-3']);
  });
});

/* ── Never lose an entry ───────────────────────────────────────────────────── */

describe('reconcileLocal', () => {
  it('puts back a record the merge cannot account for', () => {
    // The realistic version of this: a state.json written by an older build, or
    // edited by hand, that simply does not contain the record.
    const local = doc({ batches: [batch('b1'), batch('b2')] });
    const merged = doc({ batches: [batch('b1')] });

    const audit = reconcileLocal(local, merged, new Set());

    expect(audit.doc.batches.map((b) => b.id)).toEqual(['b1', 'b2']);
    expect(audit.restored).toEqual(['batches b2']);
  });

  it('does not report a locally deleted record that the merge dropped', () => {
    // A tombstone whose key is gone from the document is finished with.
    const local = doc({ products: [product('S3', { deleted: true, updatedAt: 5000 })] });
    const audit = reconcileLocal(local, doc({ products: [] }), new Set());
    expect(audit.restored).toEqual([]);
  });

  it('restores a local record the merge resolved to something older', () => {
    const local = doc({ batches: [batch('b1', { trays: 20, updatedAt: 5000 })] });
    const merged = doc({ batches: [batch('b1', { trays: 1, updatedAt: 4000 })] });

    const audit = reconcileLocal(local, merged, new Set());

    expect(audit.doc.batches[0]?.trays).toBe(20);
    expect(audit.restored).toEqual(['batches b1']);
  });

  it('never lets a remote delete wipe a local edit that was never pushed', () => {
    const local = doc({ batches: [batch('b1', { trays: 20, updatedAt: 4000 })] });
    const merged = doc({ batches: [batch('b1', { deleted: true, updatedAt: 5000 })] });

    const audit = reconcileLocal(local, merged, new Set(['batches:b1']));

    expect(audit.doc.batches[0]?.deleted).toBeFalsy();
    expect(audit.doc.batches[0]?.trays).toBe(20);
    expect(audit.defended).toEqual(['batches b1']);
    expect(audit.overwritten).toEqual([]);
  });

  it('honours last-write-wins for a pushed-clean record but still audits it', () => {
    // Nothing was at risk here, so the newer remote content stands; the ledger
    // entry is what tells a human the two devices disagreed.
    const local = doc({ batches: [batch('b1', { trays: 20, updatedAt: 4000 })] });
    const merged = doc({ batches: [batch('b1', { trays: 7, updatedAt: 5000 })] });

    const audit = reconcileLocal(local, merged, new Set(['batches:b1']));

    expect(audit.doc.batches[0]?.trays).toBe(7);
    expect(audit.overwritten).toEqual(['batches b1']);
    expect(audit.restored).toEqual([]);
    expect(audit.defended).toEqual([]);
  });

  it('leaves records alone when the key was not in the dirty batch', () => {
    const local = doc({ products: [product('S3', { target: 100, updatedAt: 4000 })] });
    const merged = doc({ products: [product('S3', { target: 700, updatedAt: 5000 })] });
    const audit = reconcileLocal(local, merged, new Set(['batches:b1']));
    expect(audit.doc.products[0]?.target).toBe(700);
    expect(audit.overwritten).toEqual([]);
  });
});

/* ── Change detection ──────────────────────────────────────────────────────── */

describe('change detection', () => {
  const touched = doc({
    products: [product('S3', { updatedAt: 1500 })],
    events: [event('e1', 1200)],
    updatedAt: 9000,
  });

  it('reads the newest record rather than the write-out stamp', () => {
    // `updatedAt` advances on every write-out, so it cannot answer "did anyone
    // change anything since the last pull".
    expect(latestTouch(touched)).toBe(1500);
    expect(changedSince(touched, 1400)).toBe(true);
    expect(changedSince(touched, 1500)).toBe(false);
    expect(changedSince(touched, 9500)).toBe(false);
  });

  it('counts the records a push would carry', () => {
    expect(countPending(touched, 0)).toBe(2);
    expect(countPending(touched, 1300)).toBe(1);
    expect(countPending(touched, 1500)).toBe(0);
  });
});

/* ── Database bridge ───────────────────────────────────────────────────────── */

function fakeTable<T>(rows: T[], keyOf: (row: T) => string) {
  const store = new Map<string, T>();
  for (const row of rows) store.set(keyOf(row), row);
  return {
    store,
    toArray: async (): Promise<T[]> => [...store.values()],
    bulkPut: async (items: readonly T[]): Promise<number> => {
      for (const item of items) store.set(keyOf(item), item);
      return store.size;
    },
  };
}

function fakeDb(
  seed: Partial<
    Record<'products' | 'lines' | 'batches' | 'events' | 'planItems' | 'views' | 'users' | 'devices', unknown[]>
  > = {},
) {
  const tables = {
    products: fakeTable((seed.products ?? []) as Product[], (row: Product) => row.code),
    lines: fakeTable((seed.lines ?? []) as Line[], (row: Line) => row.id),
    batches: fakeTable((seed.batches ?? []) as Batch[], (row: Batch) => row.id),
    events: fakeTable((seed.events ?? []) as EventLog[], (row: EventLog) => row.id),
    planItems: fakeTable((seed.planItems ?? []) as PlanItem[], (row: PlanItem) => row.id),
    views: fakeTable((seed.views ?? []) as ViewRecord[], (row: ViewRecord) => row.key),
    users: fakeTable((seed.users ?? []) as Account[], (row: Account) => row.id),
    devices: fakeTable((seed.devices ?? []) as DeviceRecord[], (row: DeviceRecord) => row.id),
  };
  const meta = new Map<string, unknown>();
  return {
    ...tables,
    meta: {
      get: async (key: string) => (meta.has(key) ? { key, value: meta.get(key) } : undefined),
      put: async (row: { key: string; value: unknown }) => {
        meta.set(row.key, row.value);
        return row.key;
      },
    },
    metaStore: meta,
  };
}

describe('database bridge', () => {
  it('reads a document out of the tables in write-out order', async () => {
    const db = fakeDb({
      products: [product('S3'), product('A3')],
      events: [event('e2', 2000), event('e1', 1000)],
      views: [view('matrix', 'dev-a')],
    });

    const read = await documentFromDb(db, { device: 'dev-a', now: 8000 });

    expect(read.device).toBe('dev-a');
    expect(read.products.map((p) => p.code)).toEqual(['A3', 'S3']);
    expect(read.events.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(read.views).toHaveLength(1);
    // A settings row that has never been written still produces a complete
    // Settings object, so another device never receives undefined fields.
    expect(read.settings.planning.placeholderYears).toEqual(DEFAULT_SETTINGS.planning.placeholderYears);
  });

  it('round-trips a document through the tables without loss', async () => {
    const db = fakeDb();
    const source = doc({
      products: [product('S3'), product('M6', { deleted: true })],
      lines: [line('line-1')],
      batches: [batch('b1'), batch('b2')],
      events: [event('e1', 1000)],
      planItems: [planItem('p1')],
      views: [view('matrix', 'dev-a')],
      settings: settings({ companyName: 'Freo Stone Pty Ltd' }),
    });

    await applyDocumentToDb(db, source);
    const read = await documentFromDb(db, { device: 'dev-a', now: 9000 });

    // The read comes back in write-out order, which the source deliberately is not.
    expect(records(read)).toEqual(records({ ...sortForWrite(source), updatedAt: read.updatedAt }));
    expect(db.metaStore.get('settings')).toEqual(source.settings);
  });

  it('is additive: applying a document that lacks a row does not delete it', () => {
    // Deletions travel as tombstones. Silently pruning rows here would turn one
    // device's stale document into everyone's data loss.
    const db = fakeDb({ products: [product('S3')] });
    return applyDocumentToDb(db, doc({ products: [] })).then(() => {
      expect([...db.products.store.keys()]).toEqual(['S3']);
    });
  });
});

/* ── Accounts and devices ──────────────────────────────────────────────────── */

describe('accounts and devices', () => {
  // Two devices that each added a person must end up with both, in either order: the
  // shop's account list is the one thing that cannot quietly lose somebody.
  it('unions accounts created on different devices, both ways round', () => {
    const local = doc({ users: [account('acct-a', { name: 'Test Maker', updatedAt: 2000 })] });
    const remote = doc({
      device: 'dev-b',
      users: [account('acct-b', { name: 'Test Viewer', role: 'viewer', updatedAt: 1500 })],
    });

    expect(mergeDocuments(local, remote).users.map((u) => u.id)).toEqual(['acct-a', 'acct-b']);
    expect(records(mergeDocuments(local, remote))).toEqual(records(mergeDocuments(remote, local)));
  });

  it('keeps the newer rename of an account, and agrees on a tie', () => {
    const local = doc({ users: [account('acct-a', { name: 'Test Maker', updatedAt: 3000 })] });
    const remote = doc({ device: 'dev-b', users: [account('acct-a', { name: 'Test Foreman', updatedAt: 2000 })] });

    expect(mergeDocuments(local, remote).users[0]?.name).toBe('Test Maker');
    expect(mergeDocuments(remote, local).users[0]?.name).toBe('Test Maker');

    const tie = doc({ users: [account('acct-a', { name: 'Test Maker', updatedAt: 3000 })] });
    const other = doc({ device: 'dev-b', users: [account('acct-a', { name: 'Test Foreman', updatedAt: 3000 })] });
    expect(mergeDocuments(tie, other).users[0]?.name).toBe(mergeDocuments(other, tie).users[0]?.name);
  });

  it('honours a newer deletion of an account but not an older one', () => {
    const local = doc({ users: [account('acct-a', { deleted: true, updatedAt: 3000 })] });
    const remote = doc({ device: 'dev-b', users: [account('acct-a', { name: 'Test Maker', updatedAt: 2000 })] });
    expect(mergeDocuments(local, remote).users[0]?.deleted).toBe(true);
    expect(mergeDocuments(remote, local).users[0]?.deleted).toBe(true);

    // An account deleted before the owner renamed it was not deleted knowing about the
    // rename: the edit wins, and the account comes back rather than disappearing on a
    // device that was behind.
    const older = doc({ users: [account('acct-a', { deleted: true, updatedAt: 1000 })] });
    const renamed = doc({ device: 'dev-b', users: [account('acct-a', { name: 'Test Foreman', updatedAt: 2000 })] });
    const revived = mergeDocuments(older, renamed);
    expect(revived.users[0]?.deleted).toBeFalsy();
    expect(revived.users[0]?.name).toBe('Test Foreman');
  });

  it('carries a revoked device the same way as any other change', () => {
    const local = doc({ devices: [device('dev-b', { revoked: true, updatedAt: 4000 })] });
    const remote = doc({ device: 'dev-b', devices: [device('dev-b', { label: 'Shop phone', updatedAt: 3000 })] });

    const merged = mergeDocuments(local, remote).devices[0];
    expect(merged).toMatchObject({ revoked: true, label: 'Shop floor PC' });
  });

  // The file in the shop's repository today was written before accounts existed. A
  // missing collection is an empty one, not a crash in the middle of a sync.
  it('reads a state.json that has no accounts or devices in it at all', () => {
    const fromRepo = {
      version: 1,
      updatedAt: 1234,
      products: [],
      lines: [],
      batches: [],
      events: [],
      planItems: [],
      views: [],
      settings: settings(),
      device: 'dev-a',
    } as unknown as Partial<StateDocument>;

    const whole = withCollections(fromRepo);
    expect(whole.users).toEqual([]);
    expect(whole.devices).toEqual([]);

    // And it merges against a device that does have accounts without losing them.
    const mine = doc({ users: [account('acct-a')], devices: [device('dev-a')] });
    const merged = mergeDocuments(whole, mine);
    expect(merged.users.map((u) => u.id)).toEqual(['acct-a']);
    expect(merged.devices.map((d) => d.id)).toEqual(['dev-a']);
  });
});
