/**
 * The shop's own machine, as the store.
 *
 * Same four calls as the repository — read the shop document, write it if nothing
 * changed underneath me, get and put the two MYOB workbooks — answered by the Node
 * server in `server/`, which serves this app and keeps the data two metres away.
 * It replaces GitHub for a deployment; it does not replace it in the codebase, and
 * nothing here pretends otherwise: {@link detectStore} asks the machine it is
 * standing on and {@link ShopStore.kind} says out loud which one this is.
 *
 * What is deliberately *not* here: any understanding of the shop's data. The server
 * stores a document it cannot read, and the numbers inside it are hashed on the
 * device that typed them, as they have always been. A box at work holding the
 * shop's passcodes would be a worse box than one holding the shop's trays.
 *
 * One difference from the repository is worth stating because it will come up: the
 * repository's history is a person's ability to say "give me Tuesday's version".
 * The server keeps an append-only log of every write (who, when, which sha) and the
 * current files, not every old version. `docs/server.md` calls that out; a shop that
 * wants versions back needs the backup rota, not this file.
 */

import type { BinarySlot, ShopStore, StateSlot } from './store';
import { StoreError } from './store';
import {
  ConflictError,
  decodeStateDocument,
  globalFetch,
  type FetchInit,
  type FetchLike,
  type FetchResponse,
  type TokenCheck,
} from './github';
import type { StateDocument } from './merge';

/** Where the server answers. Always the origin root, whatever path the app is under. */
const HEALTH = '/api/health';
const TIMEOUT_MS = 2_500;

export interface ServerHealth {
  ok: boolean;
  store: string;
  version: string;
}

let healthPromise: Promise<ServerHealth | null> | null = null;

/**
 * Is there a server underneath this copy of the app?
 *
 * Cached for the life of the page, because it decides which store every later call
 * goes to, and a store that changed its mind halfway through a session is worse
 * than either of them. A missing `/api/health` is the ordinary answer on GitHub
 * Pages — that is a 404, not a failure, and it is how the same build knows to use
 * the repository there.
 */
/**
 * `base` is empty for the ordinary case — the app and the API come from the same
 * origin, so every path is relative and there is nothing to remember. It exists
 * because a build served from one place has to be able to talk to a shop server in
 * another while a deployment is being tried out, and in Node a relative URL is not
 * a URL at all.
 */
export function detectStore(fetchImpl: FetchLike = globalFetch, base = ''): Promise<ServerHealth | null> {
  healthPromise ??= ask(fetchImpl, base);
  return healthPromise;
}

/** Forget the probe. Tests and the Settings screen's "check again" use this. */
export function forgetStoreProbe(): void {
  healthPromise = null;
}

async function ask(fetchImpl: FetchLike, base = ''): Promise<ServerHealth | null> {
  const signal = abortAfter(TIMEOUT_MS);
  if (!signal) return null;
  try {
    const res = await fetchImpl(`${base}${HEALTH}`, { method: 'GET', headers: { Accept: 'application/json' }, signal: signal.signal });
    if (res.status !== 200) return null;
    const body = jsonOf<Partial<ServerHealth>>(await res.text());
    // Anything that answers is not necessarily *our* server, so it has to say so.
    return body?.store === 'server' ? { ok: true, store: 'server', version: String(body.version ?? 'unknown') } : null;
  } catch {
    return null;
  } finally {
    signal.stop();
  }
}

/** Which of the two workbooks a repository path refers to. */
function kindOf(path: string): 'location' | 'future' {
  const bare = path.trim().toLowerCase();
  if (bare.endsWith('location.xlsx')) return 'location';
  if (bare.endsWith('future.xlsx')) return 'future';
  throw new StoreError(
    `this store keeps two workbooks, the stock file and the jobs file, so "${path}" is not something it can hold`,
    400,
  );
}

/**
 * The store that runs in the shop.
 *
 * `message` and `device` travel as query parameters rather than inside the body or a
 * header: the body has to stay the document or the workbook itself, and an HTTP
 * header may not carry the em dashes and the ≥ that commit messages have in them.
 */
export class ServerStore implements ShopStore {
  readonly kind = 'server' as const;

  /** Exactly what the server last said the shop document was, character for character. */
  private raw = '';

  /** Empty for the ordinary same-origin case; see the constructor. */
  private readonly baseUrl: string;

  constructor(
    private readonly token: string,
    private readonly deviceName: string,
    private readonly fetchImpl: FetchLike = globalFetch,
    baseUrl = '',
  ) {
    // A person types this into a settings field, and people type trailing slashes.
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async getState(): Promise<StateSlot | null> {
    const res = await this.send('/api/state', { method: 'GET' });
    if (res.status === 404) return null;
    await this.raiseIfBad(res, 'read the shop document');
    const text = await res.text();
    const body = jsonOf<{ sha?: unknown; content?: unknown }>(text);
    if (!body || typeof body.sha !== 'string') throw new StoreError('the server answered a shop document with no sha', 502);
    // Straight back through the app's own gatekeeper, so a server running a newer
    // document than this build understands fails the same way the repository does.
    const content = decodeStateDocument(JSON.stringify(body.content ?? {}));
    // Kept so that proving we can write does not *change* anything: see
    // {@link validateToken}. Round-tripping the decoded document instead would add
    // the fields the decoder fills in, and a test connection would be a real edit.
    this.raw = JSON.stringify(body.content ?? {});
    return { sha: body.sha, content };
  }

  async putState(content: StateDocument, sha: string | null, message: string): Promise<{ sha: string }> {
    const res = await this.send(`/api/state${this.tail(message)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...match(sha) },
      body: JSON.stringify(content),
    });
    await this.raiseIfBad(res, 'save the shop document');
    const body = jsonOf<{ sha?: unknown }>(await res.text());
    return { sha: typeof body?.sha === 'string' ? body.sha : '' };
  }

  async getBinaryFile(path: string): Promise<BinarySlot | null> {
    const res = await this.send(`/api/exports/${kindOf(path)}`, { method: 'GET' });
    if (res.status === 404) return null;
    await this.raiseIfBad(res, `read ${path}`);
    const buffer = await res.arrayBuffer?.();
    if (!buffer) throw new StoreError('this browser could not hand over the workbook as bytes', 500);
    const sha = etagOf(res);
    if (sha === '') throw new StoreError('the server sent a workbook without saying which version it was', 502);
    return { sha, bytes: new Uint8Array(buffer) };
  }

  /**
   * The number a workbook is worth, without its megabytes.
   *
   * A folder watch asks this before it asks anything else, and pulling the current
   * copy down to compare it with the file in the folder would be the slowest possible
   * way to say "the same". The history endpoint answers with the current sha.
   */
  async getEntrySha(path: string): Promise<string | null> {
    const kind = kindOf(path);
    const res = await this.send(`/api/history?path=${encodeURIComponent(`exports/${kind}.xlsx`)}&limit=1`, { method: 'GET' });
    if (res.status === 404) return null;
    await this.raiseIfBad(res, `ask what ${path} is worth`);
    const body = jsonOf<{ entries?: unknown }>(await res.text());
    const entries = Array.isArray(body?.entries) ? (body.entries as { sha?: unknown }[]) : [];
    const sha = entries[0]?.sha;
    return typeof sha === 'string' && sha !== '' ? sha : null;
  }

  async putBinaryFile(path: string, bytes: Uint8Array, sha: string | null, message: string): Promise<{ sha: string }> {
    const res = await this.send(`/api/exports/${kindOf(path)}${this.tail(message)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', ...match(sha) },
      body: bytes,
    });
    await this.raiseIfBad(res, `send ${path}`);
    const body = jsonOf<{ sha?: unknown }>(await res.text());
    return { sha: typeof body?.sha === 'string' ? body.sha : '' };
  }

  /**
   * Can this device reach the shop's server, and write to it?
   *
   * The read half is one small history request. The write half writes the document it
   * just read, byte for byte, against the sha it just read: if that is refused, this
   * device cannot push anything, and if it is accepted the file is unchanged — a
   * compare-and-set against yourself is the least destructive proof there is.
   */
  async validateToken(probe = false): Promise<TokenCheck> {
    if (this.token === '') return { ok: false, reason: 'this device has not been given a key to the server yet' };
    try {
      const health = await detectStore(this.fetchImpl);
      if (!health) return { ok: false, reason: 'no shop server answered at /api/health on this address' };
      if (!probe) return { ok: true, canWrite: true };
      const current = await this.getState();
      if (!current) return { ok: true, canWrite: true };
      const res = await this.send(`/api/state${this.tail(`connection test from ${this.deviceName || 'a device'}`)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...match(current.sha) },
        body: this.raw,
      });
      await this.raiseIfBad(res, 'test a write');
      return { ok: true, canWrite: true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  private headers(extra: Record<string, string>): Record<string, string> {
    return { ...(this.token === '' ? {} : { Authorization: `Bearer ${this.token}` }), ...extra };
  }

  private send(path: string, init: FetchInit): Promise<FetchResponse> {
    return this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers: this.headers(init.headers ?? {}) });
  }

  /** `?message=…&device=…`, for the log line the server keeps. */
  private tail(message: string): string {
    const params = new URLSearchParams();
    if (message.trim() !== '') params.set('message', message.trim());
    if (this.deviceName.trim() !== '') params.set('device', this.deviceName.trim());
    const q = params.toString();
    return q === '' ? '' : `?${q}`;
  }

  private async raiseIfBad(res: FetchResponse, doing: string): Promise<void> {
    if (res.status >= 200 && res.status < 300) return;
    const text = await res.text().catch(() => '');
    if (res.status === 409) {
      throw new ConflictError(`the shop document changed on the server while we were working on it`, shaOf(text), text);
    }
    if (res.status === 401) {
      throw new StoreError('the server refused this device — its key is not one it recognises', 401);
    }
    throw new StoreError(`the server would not ${doing} (${String(res.status)})${reasonOf(text)}`, res.status);
  }
}

/** `If-Match` for a replacement, `If-None-Match: *` for a first write. */
function match(sha: string | null): Record<string, string> {
  return sha ? { 'If-Match': `"${sha}"` } : { 'If-None-Match': '*' };
}

/** The quoted blob sha the server gives a workbook, with the quotes taken off. */
function etagOf(res: FetchResponse): string {
  return (res.headers?.get('etag') ?? '').replace(/[^0-9a-f]/g, '');
}

/** The body, or nothing — never an exception on a body that was not JSON. */
function jsonOf<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

function shaOf(body: string): string | null {
  return body.match(/"sha"\s*:\s*"([0-9a-f]{4,40})"/)?.[1] ?? null;
}

function reasonOf(body: string): string {
  const message = body.match(/"message"\s*:\s*"([^"]{1,200})"/)?.[1];
  return message ? ` — ${message}` : '';
}

/** `AbortSignal.timeout` is newer than some of the browsers this app runs on. */
function abortAfter(ms: number): { signal: AbortSignal; stop: () => void } | null {
  if (typeof AbortController !== 'function') return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, stop: () => clearTimeout(timer) };
}

/**
 * Swap the paste-a-token screen for the one thing a server deployment needs: the
 * eight-character code printed on the box's console when it first starts.
 *
 * Kept out of the sign-in screen so the exchange can be tested without a browser,
 * and so the wording lives in one place. The code works once: after that the first
 * device has to introduce the next one, which is the same rule the repository's
 * token has always had, only said out loud.
 */
export async function redeemSetupCode(
  code: string,
  deviceName: string,
  fetchImpl: FetchLike = globalFetch,
  base = '',
): Promise<{ ok: true; token: string; deviceId: string } | { ok: false; reason: string }> {
  try {
    const res = await fetchImpl(`${base}/api/device/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code.trim().toUpperCase(), name: deviceName.trim() }),
    });
    const body = jsonOf<{ token?: unknown; deviceId?: unknown; error?: { message?: unknown } }>(
      await res.text().catch(() => ''),
    );
    if (res.status < 200 || res.status >= 300) {
      const reason = typeof body?.error?.message === 'string' ? body.error.message : `the server said ${String(res.status)}`;
      return { ok: false, reason };
    }
    if (typeof body?.token !== 'string' || body.token === '') return { ok: false, reason: 'the server answered with no token' };
    return { ok: true, token: body.token, deviceId: typeof body.deviceId === 'string' ? body.deviceId : '' };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'the shop server did not answer' };
  }
}
