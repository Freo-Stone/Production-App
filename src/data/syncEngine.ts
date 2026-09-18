/**
 * Sync orchestration: pull → merge → push, with the local database always
 * written first.
 *
 * Nothing here waits on the network to make the app usable. A floor write lands
 * in IndexedDB, gets queued as dirty, and the engine finds a moment to push it:
 * after an idle window, at most once per rate-limit window, immediately on
 * `flush()` or on reconnect. Clock and connectivity are injected so the timing
 * rules are testable rather than merely believed.
 */
import { ConflictError, GitHubError, type GitHubErrorKind } from './github';
import {
  applyDocumentToDb,
  dirtyName,
  documentFromDb,
  emptyDocument,
  mergeDocuments,
  mergeEvents,
  reconcileLocal,
  WATERMARK_KEY,
  type CollectionName,
  type StateDocument,
  type SyncDatabase,
} from './merge';
import type { EventLog } from '@/core/types';

export type SyncPhase = 'idle' | 'syncing' | 'offline' | 'error' | 'conflict';

export interface SyncStatus {
  state: SyncPhase;
  pendingCount: number;
  lastPulledAt: number | null;
  lastPushedAt: number | null;
  message: string;
  /** Last failure, so a settings screen can show the HTTP status without
   *  re-throwing anything at the UI. */
  lastError?: { kind: GitHubErrorKind; status: number; message: string } | null;
}

export type TimerHandle = unknown;

/** Injectable clock. `Date.now`/`setTimeout` are never reached directly, so a
 *  test owns the timing completely. */
export interface SyncTimers {
  now(): number;
  setTimeout(handler: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** `navigator.onLine` in interface form: the engine is handed a source instead
 *  of poking a global, which keeps it testable and usable from a worker. */
export interface ConnectionSource {
  isOnline(): boolean;
  subscribe(listener: (online: boolean) => void): () => void;
}

/** The two calls the engine makes. `GitHubClient` satisfies it as-is. */
export interface SyncTransport {
  getState(): Promise<{ sha: string; content: StateDocument } | null>;
  putState(content: StateDocument, sha: string | null, message: string): Promise<{ sha: string }>;
}

export interface SyncEngineOptions {
  transport: SyncTransport;
  database: SyncDatabase;
  device: string;
  timers?: SyncTimers;
  connection?: ConnectionSource;
  /** Idle window before an automatic push. Default 20s. */
  debounceMs?: number;
  /** Minimum spacing between pushes. Default 60s. */
  minPushGapMs?: number;
  /** Push attempts per cycle including the first. Default 3. */
  maxAttempts?: number;
  newConflictId?: () => string;
}

export interface SyncEngine {
  status(): SyncStatus;
  subscribe(listener: (status: SyncStatus) => void): () => void;
  /** Call *after* the local write has been committed to IndexedDB. */
  markDirty(entity: CollectionName, key?: string): void;
  pull(): Promise<void>;
  /** Push now, bypassing both the idle window and the rate limit. */
  flush(): Promise<void>;
  /** Start listening for connectivity. Returns the teardown. */
  start(): () => void;
}

export const DEFAULT_DEBOUNCE_MS = 20_000;
export const DEFAULT_PUSH_GAP_MS = 60_000;
export const DEFAULT_MAX_ATTEMPTS = 3;

const systemTimers: SyncTimers = {
  now: () => Date.now(),
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Default when no connectivity source is supplied: never block a push. */
const alwaysOnline: ConnectionSource = { isOnline: () => true, subscribe: () => () => undefined };

function asGitHubError(cause: unknown): GitHubError {
  if (cause instanceof GitHubError) return cause;
  return new GitHubError(String(cause instanceof Error ? cause.message : cause), { status: 0, kind: 'network' });
}

/** FNV-1a over the conflict label. Two devices can hit the same conflict shape,
 *  so the id carries the device as well as the record it was about. */
function conflictIdFor(device: string, label: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < label.length; i += 1) {
    hash ^= label.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `syncconflict_${device}_${(hash >>> 0).toString(36)}`;
}

/** Browser wiring, opt-in so importing this module never touches a global. */
export function browserConnection(): ConnectionSource {
  const listeners = new Set<(online: boolean) => void>();
  const emit = (): void => {
    for (const listener of [...listeners]) listener(globalThis.navigator?.onLine ?? true);
  };
  const listen = (add: boolean): void => {
    // Added and removed with the last subscriber, so an engine teardown (or a
    // hot reload) cannot leave handlers on window forever.
    for (const type of ['online', 'offline']) {
      if (add) globalThis.addEventListener?.(type, emit);
      else globalThis.removeEventListener?.(type, emit);
    }
  };
  return {
    isOnline: () => globalThis.navigator?.onLine ?? true,
    subscribe: (listener) => {
      const first = listeners.size === 0;
      listeners.add(listener);
      if (first) listen(true);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) listen(false);
      };
    },
  };
}

export function createSyncEngine(options: SyncEngineOptions): SyncEngine {
  const timers = options.timers ?? systemTimers;
  const connection = options.connection ?? alwaysOnline;
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const minPushGapMs = options.minPushGapMs ?? DEFAULT_PUSH_GAP_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  let status: SyncStatus = { state: 'idle', pendingCount: 0, lastPulledAt: null, lastPushedAt: null, message: 'not synced yet', lastError: null };
  const listeners = new Set<(status: SyncStatus) => void>();
  const dirty = new Set<string>();

  let timer: TimerHandle | null = null;
  let cycle: Promise<void> = Promise.resolve();
  let hydrated = false;
  let lastPushAt = 0;
  let lastPullAt = 0;

  function emit(patch: Partial<SyncStatus>): void {
    status = { ...status, ...patch, pendingCount: dirty.size };
    for (const listener of listeners) listener(status);
  }

  function clearTimer(): void {
    if (timer === null) return;
    timers.clearTimeout(timer);
    timer = null;
  }

  /**
   * Only the first unsynced change arms the timer. Pushing the deadline out on
   * every write would let a busy floor postpone the sync indefinitely.
   */
  function schedule(delay: number): void {
    if (timer !== null) return;
    timer = timers.setTimeout(() => {
      timer = null;
      void enqueue(false);
    }, Math.max(0, delay));
  }

  /** Cycles run one at a time; a caller gets its own cycle's completion. */
  function enqueue(force: boolean): Promise<void> {
    const run = cycle.then(() => cycleOnce(force));
    cycle = run.catch(() => undefined);
    return run;
  }

  function conflictEvent(detail: string): EventLog {
    return {
      // Ids are derived from the detail, so the same conflict seen again on a
      // later retry merges into one ledger row instead of spamming the trail.
      id: options.newConflictId?.() ?? conflictIdFor(options.device, detail),
      at: timers.now(),
      action: 'sync.conflict',
      batchId: null,
      code: null,
      fromStage: null,
      toStage: null,
      qty: 0,
      trays: 0,
      device: options.device,
      actor: 'sync',
      detail,
    };
  }

  /** Watermarks live in local meta, not in `Settings.sync`: that row is shared,
   *  so one device's push would reset another device's change detection. */
  async function hydrate(): Promise<void> {
    if (hydrated) return;
    hydrated = true;
    const row = await options.database.meta.get(WATERMARK_KEY);
    const value = row?.value as { lastPushedAt?: number; lastPulledAt?: number } | undefined;
    if (!value) return;
    lastPushAt = Number(value.lastPushedAt ?? 0);
    lastPullAt = Number(value.lastPulledAt ?? 0);
    emit({ lastPushedAt: lastPushAt || null, lastPulledAt: lastPullAt || null });
  }

  async function writeWatermark(): Promise<void> {
    await options.database.meta.put({
      key: WATERMARK_KEY,
      value: { lastPushedAt: lastPushAt, lastPulledAt: lastPullAt },
    });
  }

  /** Pull → merge → protect local data → write back. */
  async function mergeRemote(remote: { sha: string; content: StateDocument } | null, batch: ReadonlySet<string>) {
    const at = timers.now();
    const local = await documentFromDb(options.database, { device: options.device, now: at });
    const merged = mergeDocuments(local, remote?.content ?? emptyDocument(options.device, at));
    const audit = reconcileLocal(local, merged, batch);
    const notes = [
      ...audit.restored.map((label) => conflictEvent(`restored local ${label}: the shared document did not contain it`)),
      ...audit.defended.map((label) => conflictEvent(`kept unpushed local ${label}: the shared copy had deleted it`)),
      ...audit.overwritten.map((label) => conflictEvent(`shared copy overwrote unpushed local ${label}`)),
    ];
    if (notes.length > 0) audit.doc.events = mergeEvents(audit.doc.events, notes);
    audit.doc.updatedAt = Math.max(audit.doc.updatedAt, at);
    await applyDocumentToDb(options.database, audit.doc);
    lastPullAt = at;
    return {
      doc: audit.doc,
      sha: remote?.sha ?? null,
      at,
      restored: audit.restored.length,
      defended: audit.defended.length,
      overwritten: audit.overwritten.length,
    };
  }

  /** Plain-language conflict summary: what was saved and what was lost, so a
   *  floor screen can say so without re-deriving it from the ledger. */
  const isConflict = (counts: { restored: number; defended: number; overwritten: number }): boolean =>
    counts.restored + counts.defended + counts.overwritten > 0;

  function conflictNotice(counts: { restored: number; defended: number; overwritten: number }): string {
    const { restored, defended, overwritten } = counts;
    if (restored + defended + overwritten === 0) return 'synced';
    const parts = [
      restored > 0 ? `restored ${String(restored)} local record(s) the shared document had lost` : null,
      defended > 0 ? `kept ${String(defended)} unpushed local edit(s) the shared copy had deleted` : null,
      overwritten > 0
        ? `${String(overwritten)} unpushed local edit(s) overwritten by the shared copy — see the audit log`
        : null,
    ].filter((part): part is string => part !== null);
    return `pushed with conflicts: ${parts.join('; ')}`;
  }

  function commitMessage(batch: readonly string[]): string {
    const head = batch.slice(0, 3).join(', ');
    const listed = head === '' ? '' : ` [${head}${batch.length > 3 ? ', …' : ''}]`;
    return `sync(${options.device}): ${String(batch.length)} record(s)${listed}`;
  }

  function fail(cause: unknown): void {
    const error = asGitHubError(cause);
    const hint = error.retryAfterMs && error.retryAfterMs > 0 ? ` Retrying in ${String(Math.ceil(error.retryAfterMs / 1000))}s.` : '';
    emit({
      state: 'error',
      message: `${error.message}${hint}`,
      lastError: { kind: error.kind, status: error.status, message: error.message },
    });
  }

  async function cycleOnce(force: boolean): Promise<void> {
    await hydrate();
    if (!connection.isOnline()) {
      clearTimer();
      emit({ state: 'offline', message: `${String(dirty.size)} change(s) queued offline` });
      return;
    }
    // Rate limit: roughly one push per window. There is nothing to space out
    // before the first push has ever happened.
    const sincePush = lastPushAt === 0 ? minPushGapMs : timers.now() - lastPushAt;
    if (sincePush < minPushGapMs && !force) {
      // Deferred, never dropped — the queue still holds every change.
      schedule(minPushGapMs - sincePush);
      return;
    }
    if (dirty.size === 0 && !force) return;

    // Snapshot the queue: changes made while these calls are in flight stay
    // queued and ride the next push instead of being marked as sent.
    const batch = [...dirty];
    emit({ state: 'syncing', message: 'syncing…' });
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const remote = await options.transport.getState();
        const merged = await mergeRemote(remote, new Set(batch));
        await options.transport.putState(merged.doc, merged.sha, commitMessage(batch));
        for (const name of batch) dirty.delete(name);
        lastPushAt = timers.now();
        await writeWatermark();
        emit({
          state: isConflict(merged) ? 'conflict' : 'idle',
          lastPulledAt: merged.at,
          lastPushedAt: lastPushAt,
          message: conflictNotice(merged),
          lastError: null,
        });
        if (dirty.size > 0) schedule(debounceMs);
        return;
      } catch (cause) {
        // A 409 means the sha we sent is stale: the only correct move is to
        // read again, re-merge and try once more — a bounded number of times.
        if (cause instanceof ConflictError && attempt < maxAttempts) {
          emit({ state: 'conflict', message: 'another device pushed first — re-reading' });
          continue;
        }
        // Retrying a 409 forever would be worse than failing: two devices
        // pushing continuously can starve each other indefinitely.
        fail(
          cause instanceof ConflictError
            ? new GitHubError(`state.json kept changing — still conflicting after ${String(attempt)} attempts`, { status: 409, kind: 'http' })
            : cause,
        );
        if (dirty.size > 0 && asGitHubError(cause).kind !== 'unauthorized') schedule(debounceMs);
        return;
      }
    }
  }

  async function pullOnce(): Promise<void> {
    await hydrate();
    if (!connection.isOnline()) {
      emit({ state: 'offline', message: 'offline — pull skipped' });
      return;
    }
    emit({ state: 'syncing', message: 'pulling…' });
    try {
      const merged = await mergeRemote(await options.transport.getState(), new Set(dirty));
      await writeWatermark();
      emit({
        state: isConflict(merged) ? 'conflict' : 'idle',
        lastPulledAt: merged.at,
        message: isConflict(merged) ? `pulled; ${conflictNotice(merged)}` : 'pulled',
      });
    } catch (cause) {
      fail(cause);
    }
  }

  return {
    status: () => status,
    // No initial callback: a status read is `status()`, and emitting on
    // subscribe would be a spurious render under useSyncExternalStore.
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    markDirty: (entity, key = '*') => {
      dirty.add(dirtyName(entity, key));
      if (!connection.isOnline()) {
        emit({ state: 'offline' });
        return;
      }
      schedule(debounceMs);
      emit({});
    },
    pull: pullOnce,
    flush: () => enqueue(true),
    start: () => {
      void hydrate();
      const unsubscribe = connection.subscribe((online) => {
        if (!online) {
          clearTimer();
          emit({ state: 'offline', message: `${String(dirty.size)} change(s) queued offline` });
          return;
        }
        // Reconnect: replay the accumulated queue straight away.
        void enqueue(dirty.size > 0);
      });
      if (dirty.size > 0) schedule(0);
      return () => {
        unsubscribe();
        clearTimer();
      };
    },
  };
}
