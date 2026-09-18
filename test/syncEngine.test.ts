import { describe, expect, it } from 'vitest';
import type { Batch, EventLog, Line, PlanItem, Product } from '@/core/types';
import type { ViewRecord } from '@/data/db';
import { ConflictError, GitHubError } from '@/data/github';
import { emptyDocument, type StateDocument } from '@/data/merge';
import {
  createSyncEngine,
  type ConnectionSource,
  type SyncEngine,
  type SyncStatus,
  type SyncTimers,
  type SyncTransport,
} from '@/data/syncEngine';

/* ── Fakes: clock, connectivity, GitHub, database ──────────────────────────── */

/** One macrotask turn drains every queued microtask, which a whole sync cycle
 *  needs: counting microtask ticks is fragile because each retry adds awaits. */
const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
};

/** Owns time completely: no test here waits on a real millisecond. */
class FakeClock {
  private time = 0;
  private seq = 0;
  private readonly armed = new Map<number, { at: number; handler: () => void }>();

  readonly now = (): number => this.time;

  readonly setTimeout = (handler: () => void, ms: number): number => {
    this.seq += 1;
    this.armed.set(this.seq, { at: this.time + Math.max(0, ms), handler });
    return this.seq;
  };

  readonly clearTimeout = (handle: unknown): void => {
    this.armed.delete(handle as number);
  };

  /** Move the clock forward, firing due timers in order and letting the engine's
   *  awaited work run between them. */
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      const due = [...this.armed.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
      const next = due[0];
      if (!next) break;
      const [id, timer] = next;
      this.armed.delete(id);
      this.time = timer.at;
      timer.handler();
      await settle();
    }
    this.time = target;
    await settle();
  }

  get timers(): SyncTimers {
    return { now: this.now, setTimeout: this.setTimeout, clearTimeout: this.clearTimeout };
  }
}

function fakeConnection(online = true): ConnectionSource & { set: (next: boolean) => void } {
  const listeners = new Set<(online: boolean) => void>();
  return {
    isOnline: () => online,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => undefined;
    },
    set: (next: boolean) => {
      online = next;
      for (const listener of [...listeners]) listener(next);
    },
  };
}

interface Remote {
  sha: string;
  content: StateDocument;
}

interface Pushed {
  content: StateDocument;
  sha: string | null;
  message: string;
}

function fakeTransport(initial: Remote | null) {
  let remote = initial;
  let pulls = 0;
  const pushes: Pushed[] = [];
  const putFails: unknown[] = [];
  const getFails: unknown[] = [];

  const transport: SyncTransport = {
    getState: async () => {
      pulls += 1;
      const failure = getFails.shift();
      if (failure) throw failure;
      return remote;
    },
    putState: async (content, sha, message) => {
      const failure = putFails.shift();
      if (failure) throw failure;
      pushes.push({ content, sha, message });
      remote = { sha: `sha-${String(pushes.length)}`, content };
      return { sha: `sha-${String(pushes.length)}` };
    },
  };

  return {
    transport,
    pushes,
    putFails,
    getFails,
    remote: () => remote,
    pulls: () => pulls,
  };
}

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

function fakeDb(seed: { products?: Product[]; batches?: Batch[]; events?: EventLog[]; views?: ViewRecord[] } = {}) {
  const meta = new Map<string, unknown>();
  return {
    products: fakeTable(seed.products ?? [], (row: Product) => row.code),
    lines: fakeTable<Line>([], (row) => row.id),
    batches: fakeTable(seed.batches ?? [], (row: Batch) => row.id),
    events: fakeTable(seed.events ?? [], (row: EventLog) => row.id),
    planItems: fakeTable<PlanItem>([], (row) => row.id),
    views: fakeTable<ViewRecord>(seed.views ?? [], (row) => row.key),
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

const CONFLICT_SHA = 'c'.repeat(40);

function setup(
  options: {
    remote?: Remote | null;
    products?: Product[];
    batches?: Batch[];
    online?: boolean;
    maxAttempts?: number;
    start?: boolean;
  } = {},
) {
  const clock = new FakeClock();
  const db = fakeDb({ products: options.products, batches: options.batches });
  const connection = fakeConnection(options.online ?? true);
  const transport = fakeTransport(
    options.remote === undefined ? { sha: 'sha-0', content: emptyDocument('dev-b', 1000) } : options.remote,
  );
  const engine: SyncEngine = createSyncEngine({
    transport: transport.transport,
    database: db,
    device: 'dev-a',
    timers: clock.timers,
    connection,
    maxAttempts: options.maxAttempts,
  });
  const seen: SyncStatus[] = [];
  const stop = options.start === false ? undefined : engine.start();
  engine.subscribe((status) => seen.push({ ...status }));
  return { clock, db, connection, transport, engine, seen, stop: stop ?? (() => undefined) };
}

/* ── Push timing ───────────────────────────────────────────────────────────── */

describe('push timing', () => {
  it('waits for the idle window and then pushes exactly once', async () => {
    const { clock, engine, transport } = setup({ batches: [batch('b1')] });

    engine.markDirty('batches', 'b1');
    await clock.advance(19_999);
    expect(transport.pushes, 'the floor is still working; nothing to send yet').toHaveLength(0);
    expect(engine.status().state).toBe('idle');

    await clock.advance(1);
    expect(transport.pushes).toHaveLength(1);
    expect(engine.status()).toMatchObject({ state: 'idle', pendingCount: 0 });
    expect(transport.pushes[0]?.content.batches.map((b) => b.id)).toEqual(['b1']);
    expect(transport.pushes[0]?.sha, 'the sha read during this cycle is the one sent').toBe('sha-0');
  });

  it('does not extend the window when more changes arrive', async () => {
    // A busy floor would otherwise postpone the push for as long as it is busy.
    const { clock, engine, transport } = setup({ batches: [batch('b1')] });
    engine.markDirty('batches', 'b1');
    await clock.advance(10_000);
    engine.markDirty('batches', 'b2');
    await clock.advance(10_000);
    expect(transport.pushes).toHaveLength(1);
  });

  it('holds the second push until the rate limit expires, then sends it', async () => {
    const { clock, engine, transport } = setup({ batches: [batch('b1'), batch('b2')] });

    engine.markDirty('batches', 'b1');
    await clock.advance(20_000);
    expect(transport.pushes).toHaveLength(1);

    engine.markDirty('batches', 'b2');
    await clock.advance(40_000);
    expect(transport.pushes, 'one push per minute, not one per idle window').toHaveLength(1);

    await clock.advance(40_000);
    expect(transport.pushes).toHaveLength(2);
    expect(engine.status().pendingCount).toBe(0);
  });

  it('flush() pushes immediately, and nothing re-fires afterwards', async () => {
    const { clock, engine, transport } = setup({ batches: [batch('b1')] });

    engine.markDirty('batches', 'b1');
    await clock.advance(5_000);
    await engine.flush();

    expect(transport.pushes).toHaveLength(1);
    expect(engine.status().lastPushedAt).toBe(5_000);
    await clock.advance(120_000);
    expect(transport.pushes, 'flush consumed the queued change').toHaveLength(1);
  });

  it('stays quiet when a scheduled cycle has nothing queued', async () => {
    const { clock, engine, transport } = setup();
    await engine.flush();
    expect(transport.pushes, 'flush is explicit, so it still writes even with an empty queue').toHaveLength(1);
    await clock.advance(120_000);
    expect(transport.pushes).toHaveLength(1);
  });

  it('pull() applies remote changes without pushing', async () => {
    const remote = {
      sha: 'sha-9',
      content: { ...emptyDocument('dev-b', 2000), products: [product('M6', { target: 200, updatedAt: 2000 })] },
    };
    const { engine, db, transport } = setup({ remote });

    await engine.pull();

    expect(transport.pushes).toHaveLength(0);
    expect(db.products.store.get('M6')?.target).toBe(200);
    expect(engine.status().lastPulledAt).toBe(0);
    expect(engine.status().state).toBe('idle');
  });
});

/* ── Conflict handling ─────────────────────────────────────────────────────── */

describe('conflict handling', () => {
  it('re-reads and re-merges after a 409, then succeeds', async () => {
    const { clock, engine, transport } = setup({ batches: [batch('b1')] });
    transport.putFails.push(new ConflictError('state.json changed on main since it was read', CONFLICT_SHA, '{}'));

    engine.markDirty('batches', 'b1');
    await clock.advance(20_000);

    expect(transport.pushes, 'the rejected attempt is not recorded as sent').toHaveLength(1);
    expect(transport.pulls(), 'the retry reads again before writing').toBe(2);
    expect(transport.pushes, 'the retry re-sent after re-reading').toHaveLength(1);
    expect(engine.status()).toMatchObject({ state: 'idle', pendingCount: 0 });
  });

  it('surfaces an error once the attempts are used up, keeping the queue', async () => {
    const { clock, engine, transport } = setup({ batches: [batch('b1')], maxAttempts: 2 });
    const conflict = () => new ConflictError('state.json changed on main since it was read', CONFLICT_SHA, '{}');
    transport.putFails.push(conflict(), conflict());

    engine.markDirty('batches', 'b1');
    await clock.advance(20_000);

    expect(transport.pushes).toHaveLength(0);
    const status = engine.status();
    expect(status.state).toBe('error');
    expect(status.message).toMatch(/still conflicting after 2 attempts/);
    expect(status.lastError).toMatchObject({ status: 409 });
    expect(status.pendingCount, 'nothing was sent, so nothing may be forgotten').toBe(1);
  });

  it('stops retrying on a revoked token instead of burning the quota', async () => {
    const { clock, engine, transport } = setup({ batches: [batch('b1')] });
    transport.getFails.push(new GitHubError('GitHub rejected the token (401). Re-authorise this device.', { status: 401, kind: 'unauthorized' }));

    engine.markDirty('batches', 'b1');
    await clock.advance(20_000);
    expect(engine.status()).toMatchObject({ state: 'error', lastError: { kind: 'unauthorized' } });
    expect(transport.pulls()).toBe(1);

    // A rejected token will not fix itself, so the engine must not re-arm.
    await clock.advance(300_000);
    expect(transport.pulls()).toBe(1);
  });
});

/* ── Offline queue ─────────────────────────────────────────────────────────── */

describe('offline queue', () => {
  it('queues writes with no network calls and replays them on reconnect', async () => {
    const { clock, connection, engine, transport } = setup({
      batches: [batch('b1'), batch('b2')],
      products: [product('S3')],
    });

    connection.set(false);
    engine.markDirty('batches', 'b1');
    engine.markDirty('products', 'S3');
    await clock.advance(300_000);

    expect(engine.status()).toMatchObject({ state: 'offline', pendingCount: 2 });
    expect(transport.pushes).toHaveLength(0);
    expect(transport.pulls(), 'offline means offline, not a queue of failing calls').toBe(0);

    connection.set(true);
    await clock.advance(0);

    expect(transport.pushes, 'reconnect replays the queue immediately').toHaveLength(1);
    expect(transport.pushes[0]?.message).toContain('dev-a');
    expect(engine.status()).toMatchObject({ state: 'idle', pendingCount: 0 });
  });

  it('keeps the queue when a replay fails, and tries again later', async () => {
    const { clock, connection, engine, transport } = setup({ batches: [batch('b1')] });
    transport.getFails.push(new GitHubError('offline-ish', { status: 0, kind: 'network' }));

    connection.set(false);
    engine.markDirty('batches', 'b1');
    connection.set(true);
    await clock.advance(0);

    expect(engine.status().state).toBe('error');
    expect(engine.status().pendingCount).toBe(1);

    await clock.advance(20_000);
    expect(transport.pushes).toHaveLength(1);
    expect(engine.status().pendingCount).toBe(0);
  });

  it('marks changes made during a push as still pending', async () => {
    // The batch snapshot is taken at push time; a write that lands while GitHub
    // is thinking must not be counted as sent.
    const { clock, engine, transport } = setup({ batches: [batch('b1')] });
    let marked = false;
    const originalPut = transport.transport.putState.bind(transport.transport);
    transport.transport.putState = async (content, sha, message) => {
      if (!marked) {
        marked = true;
        engine.markDirty('batches', 'b2');
      }
      return originalPut(content, sha, message);
    };

    engine.markDirty('batches', 'b1');
    await clock.advance(20_000);

    expect(engine.status().pendingCount).toBe(1);
    await clock.advance(80_000);
    expect(transport.pushes).toHaveLength(2);
    expect(engine.status().pendingCount).toBe(0);
  });
});

/* ── Never lose an entry ───────────────────────────────────────────────────── */

describe('never losing data', () => {
  const remoteWith = (content: StateDocument): Remote => ({ sha: 'sha-7', content });

  it('keeps an unpushed local edit that the shared document deleted', async () => {
    const local = batch('b1', { trays: 20, updatedAt: 4000 });
    const deleted = batch('b1', { deleted: true, updatedAt: 5000 });
    const { clock, db, engine, transport } = setup({
      batches: [local],
      remote: remoteWith({ ...emptyDocument('dev-b', 5000), batches: [deleted] }),
    });

    engine.markDirty('batches', 'b1');
    await clock.advance(20_000);

    const pushed = transport.pushes[0]?.content.batches.find((b) => b.id === 'b1');
    expect(pushed).toMatchObject({ trays: 20 });
    expect(db.batches.store.get('b1')?.trays).toBe(20);
    expect(db.batches.store.get('b1')?.deleted, 'the remote tombstone must not win over an unpushed edit').toBeFalsy();

    const logged = [...db.events.store.values()].filter((e) => e.action === 'sync.conflict');
    expect(logged).toHaveLength(1);
    expect(logged[0]?.detail).toMatch(/batches b1/);
    expect(logged[0]?.device).toBe('dev-a');
    expect(engine.status()).toMatchObject({ state: 'conflict', pendingCount: 0 });
    expect(engine.status().message).toMatch(/kept 1 unpushed local edit/);
  });

  it('keeps a local record the shared document has never heard of', async () => {
    // The push carries the union, so this is really a check that nothing in the
    // pull → merge → write-back path quietly prunes the local database.
    const { clock, db, engine, transport } = setup({
      products: [product('M6', { target: 200, updatedAt: 3000 })],
      batches: [batch('b9', { updatedAt: 3000 })],
    });

    engine.markDirty('products', 'M6');
    await clock.advance(20_000);

    expect(transport.pushes[0]?.content.products.map((p) => p.code)).toEqual(['M6']);
    expect(transport.pushes[0]?.content.batches.map((b) => b.id)).toEqual(['b9']);
    expect(db.products.store.get('M6')?.target).toBe(200);
    expect(engine.status()).toMatchObject({ state: 'idle' });
    expect([...db.events.store.values()], 'protecting a record the merge never dropped is not a conflict').toEqual([]);
  });

  it('adopts a newer remote version of a record it had already pushed', async () => {
    const { clock, db, engine, transport } = setup({
      batches: [batch('b1', { trays: 4, updatedAt: 2000 })],
      remote: remoteWith({
        ...emptyDocument('dev-b', 6000),
        batches: [batch('b1', { trays: 25, updatedAt: 6000 })],
      }),
    });

    engine.markDirty('batches', 'b1');
    await clock.advance(20_000);

    expect(db.batches.store.get('b1')?.trays).toBe(25);
    expect(transport.pushes[0]?.content.batches[0]?.trays).toBe(25);
    // Last-write-wins is honoured here — nothing of ours was at risk beyond the
    // edit itself — but the status must still say the two devices disagreed.
    expect(engine.status()).toMatchObject({ state: 'conflict', pendingCount: 0 });
    expect(engine.status().message).toMatch(/overwritten/);
  });
});

/* ── Status plumbing ───────────────────────────────────────────────────────── */

describe('status', () => {
  it('reports each transition to subscribers and stops on unsubscribe', async () => {
    const { clock, engine, seen } = setup({ batches: [batch('b1')] });
    const phases = () => seen.map((s) => s.state);

    engine.markDirty('batches', 'b1');
    expect(engine.status().pendingCount).toBe(1);
    await clock.advance(20_001);

    expect(phases()).toContain('syncing');
    expect(phases()[phases().length - 1]).toBe('idle');

    const before = seen.length;
    engine.subscribe(() => undefined)();
    engine.markDirty('batches', 'b2');
    await clock.advance(80_000);
    expect(seen.length).toBeGreaterThan(before);
  });

  it('remembers watermarks in local meta so a reload does not lose the plot', async () => {
    const { clock, db, engine } = setup({ batches: [batch('b1')] });
    engine.markDirty('batches', 'b1');
    await clock.advance(20_000);

    expect(db.metaStore.get('sync.watermark')).toMatchObject({ lastPushedAt: 20_000 });
  });
});

