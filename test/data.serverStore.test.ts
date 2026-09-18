// @vitest-environment node
import 'fake-indexeddb/auto';
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@/core/defaults';
import { db } from '@/data/db';
import { clientForDevice, setDeviceToken } from '@/data/auth';
import { ConflictError, type FetchInit, type FetchLike, type FetchResponse } from '@/data/github';
import { detectStore, forgetStoreProbe, redeemSetupCode, ServerStore } from '@/data/serverStore';
import { StoreError } from '@/data/store';
import { emptyDocument, type StateDocument } from '@/data/merge';
import { banner, workbookBytes } from './support/buildWorkbook';
import { signInForTests, signOutForTests } from './support/who';

/**
 * The second store.
 *
 * Everything here is about the seam: the app must be able to put the shop's numbers
 * on a machine the shop owns and get exactly the same guarantees back — the same
 * compare-and-set, the same "empty is not an error", the same sha meaning. The
 * server itself has its own tests; these are for the client half, driven by a fake
 * that answers the way `server/` does.
 *
 * Two rules get more attention than their size deserves, because both fail quietly:
 * the sha has to be the git blob sha of the bytes (the folder watch compares one it
 * computed in the browser against one the server computed, and two different digest
 * conventions would look like a file that never stops changing), and a workbook has
 * to arrive as bytes rather than as text that happens to look like a workbook.
 */

/** The same digest GitHub used, so both stores speak the same number. */
function blobSha(bytes: Uint8Array): string {
  const hash = createHash('sha1');
  hash.update(`blob ${String(bytes.length)}\0`, 'utf8');
  hash.update(bytes);
  return hash.digest('hex');
}

interface Recorded {
  method: string;
  url: string;
  path: string;
  query: URLSearchParams;
  body?: string | Uint8Array;
  headers: Record<string, string>;
}

/** The parts of the shop server the client talks to, and nothing else. */
class FakeShopServer {
  readonly calls: Recorded[] = [];
  state: { sha: string; json: string } | null = null;
  readonly exports = new Map<string, Uint8Array>();
  readonly devices = new Map<string, string>();
  healthOk = true;
  firstCode = 'K7QM2XBT';
  /** A server that answers state but has no `arrayBuffer` on its responses. */
  bytesCapable = true;

  fetch(): FetchLike {
    return async (url: string, init?: FetchInit): Promise<FetchResponse> => {
      const method = (init?.method ?? 'GET').toUpperCase();
      const [path = '', queryText = ''] = url.split('?');
      const headers = (init?.headers ?? {}) as Record<string, string>;
      this.calls.push({ method, url, path, query: new URLSearchParams(queryText), body: init?.body, headers });

      const reply = (status: number, body = '', etag?: string): FetchResponse => {
        const response: Record<string, unknown> = {
          status,
          ok: status >= 200 && status < 300,
          headers: { get: (name: string) => (name.toLowerCase() === 'etag' ? (etag ?? null) : null) },
          text: async () => body,
        };
        if (this.bytesCapable) {
          response.arrayBuffer = async (): Promise<ArrayBuffer> => {
            const buffer = new ArrayBuffer(body.length);
            const view = new Uint8Array(buffer);
            for (let i = 0; i < body.length; i += 1) view[i] = body.charCodeAt(i) & 0xff;
            return buffer;
          };
        }
        return response as unknown as FetchResponse;
      };

      const bytes = typeof init?.body === 'string' ? init.body : init?.body;

      // Every route but health and the first device wants a key, which is the rule
      // the real box runs by.
      if (!path.startsWith('/api/')) return reply(404, 'not found');
      if (path !== '/api/health' && path !== '/api/device/token' && !(headers.Authorization ?? '').startsWith('Bearer ')) {
        return reply(401, '{"error":{"code":"no-key","message":"this device has no key the server recognises"}}');
      }

      if (path === '/api/health') {
        return this.healthOk
          ? reply(200, JSON.stringify({ ok: true, store: 'server', version: 'test' }))
          : reply(404, '<html>there is no api here</html>');
      }
      if (path === '/api/device/token') {
        const want = JSON.parse(String(bytes ?? '{}')) as { code?: string; name?: string };
        const ownerExists = this.devices.size > 0;
        if (!ownerExists) {
          if (String(want.code).toUpperCase() !== this.firstCode) return reply(401, '{"error":{"code":"bad-code","message":"the setup code is not the one this server printed"}}');
          const token = 't'.repeat(40);
          this.devices.set(token, want.name ?? 'an unnamed device');
          return reply(200, JSON.stringify({ token, deviceId: 'dev_1', role: 'owner' }));
        }
        const bearer = (headers.Authorization ?? '').replace('Bearer ', '');
        if (!this.devices.has(bearer)) return reply(401, '{"error":{"code":"no-key","message":"this device has no key the server recognises"}}');
        const token = `t${String(this.devices.size).padStart(39, '0')}`;
        this.devices.set(token, want.name ?? 'an unnamed device');
        return reply(200, JSON.stringify({ token, deviceId: `dev_${String(this.devices.size)}`, role: 'device' }));
      }
      if (path === '/api/state' && method === 'GET') {
        return this.state ? reply(200, JSON.stringify({ sha: this.state.sha, content: JSON.parse(this.state.json) })) : reply(404, '{"error":{"code":"empty","message":"no shop document has been written yet"}}');
      }
      if (path === '/api/state' && method === 'PUT') {
        const ifMatch = headers['If-Match'];
        const ifNone = headers['If-None-Match'];
        if (this.state && ifNone === '*') return reply(409, JSON.stringify({ sha: this.state.sha }));
        if (this.state && ifMatch !== `"${this.state.sha}"`) return reply(409, JSON.stringify({ sha: this.state.sha }));
        if (!this.state && !ifNone) return reply(428, '{"error":{"code":"no-condition","message":"say what version you are replacing"}}');
        const text = String(bytes);
        try {
          JSON.parse(text);
        } catch {
          return reply(400, '{"error":{"code":"bad-json","message":"the shop document is not JSON"}}');
        }
        const sha = blobSha(new TextEncoder().encode(text));
        this.state = { sha, json: text };
        return reply(200, JSON.stringify({ sha }));
      }
      const exportMatch = path.match(/^\/api\/exports\/(location|future)$/);
      if (exportMatch) {
        const kind = (exportMatch[1] ?? 'location') as 'location' | 'future';
        const held = this.exports.get(kind);
        if (method === 'GET') {
          if (!held) return reply(404, '{"error":{"code":"empty","message":"nothing has been sent yet"}}');
          return reply(200, Buffer.from(held).toString('latin1'), blobSha(held));
        }
        const incoming = (bytes ?? new Uint8Array()) as Uint8Array;
        if (held && headers['If-Match'] !== `"${blobSha(held)}"`) return reply(409, JSON.stringify({ sha: blobSha(held) }));
        this.exports.set(kind, incoming);
        return reply(200, JSON.stringify({ sha: blobSha(incoming) }));
      }
      if (path === '/api/history') {
        const want = pathOfQuery(new URLSearchParams(queryText));
        const kind = want.includes('location') ? 'location' : want.includes('future') ? 'future' : '';
        const held = kind === '' ? undefined : this.exports.get(kind);
        const entries = held ? [{ at: '2026-09-18T07:12:00+08:00', sha: blobSha(held), device: 'Shop PC', message: 'exports: from the folder' }] : [];
        return reply(200, JSON.stringify({ entries }));
      }
      return reply(404, `{"error":{"code":"no-route","message":"nothing at ${path ?? ''}"}}`);
    };
  }

  last(): Recorded {
    const call = this.calls[this.calls.length - 1];
    if (!call) throw new Error('the client made no request at all');
    return call;
  }
}

function pathOfQuery(query: URLSearchParams): string {
  return query.get('path') ?? '';
}

const DOC: StateDocument = emptyDocument('Shop PC', Date.parse('2026-09-18T07:00:00+08:00'));

function storeFor(server: FakeShopServer, deviceName = 'Shop PC'): ServerStore {
  return new ServerStore('t'.repeat(40), deviceName, server.fetch());
}

beforeEach(async () => {
  forgetStoreProbe();
  await db.delete();
  await db.open();
  await signOutForTests();
});

describe('choosing a store', () => {
  it('uses the shop server when one answers at /api/health', async () => {
    const server = new FakeShopServer();
    await signInForTests('maker');
    await setDeviceToken('t'.repeat(40));
    const client = await clientForDevice({ ...DEFAULT_SETTINGS }, server.fetch());
    expect(client?.kind).toBe('server');
  });

  it('falls back to the repository when nothing answers, which is what Pages looks like', async () => {
    const server = new FakeShopServer();
    server.healthOk = false;
    await signInForTests('maker');
    await setDeviceToken('ghp_repostoken');
    const settings = { ...DEFAULT_SETTINGS, sync: { ...DEFAULT_SETTINGS.sync, githubOwner: 'Freo-Stone', githubRepo: 'Production-App-Data' } };
    const client = await clientForDevice(settings, server.fetch());
    expect(client?.kind).toBe('github');
  });

  it('refuses to invent a store for a device with no key', async () => {
    const server = new FakeShopServer();
    await signInForTests('maker');
    expect(await clientForDevice({ ...DEFAULT_SETTINGS }, server.fetch())).toBeNull();
  });

  it('asks once, and is not fooled by something else that answers', async () => {
    const server = new FakeShopServer();
    const fetchImpl = server.fetch();
    expect((await detectStore(fetchImpl))?.store).toBe('server');
    // The page has decided. A second probe would risk a store changing underneath a
    // session that is already reading and writing.
    server.healthOk = false;
    expect((await detectStore(fetchImpl))?.store).toBe('server');
    expect(server.calls.filter((c) => c.path === '/api/health').length).toBe(1);

    forgetStoreProbe();
    expect(await detectStore(fetchImpl)).toBeNull();
  });

  it('does not believe an answer that does not say it is the shop server', async () => {
    const server = new FakeShopServer();
    const original = server.fetch();
    const fetchImpl: FetchLike = async (url, init) => {
      const res = await original(url, init);
      if (url !== '/api/health') return res;
      return { status: 200, ok: true, text: async () => '{"store":"something-else"}' } as unknown as FetchResponse;
    };
    expect(await detectStore(fetchImpl)).toBeNull();
  });
});

describe('the shop document', () => {
  it('says "nothing yet" without calling it an error', async () => {
    const server = new FakeShopServer();
    expect(await storeFor(server).getState()).toBeNull();
  });

  it('reads back the document and the number that makes a write safe', async () => {
    const server = new FakeShopServer();
    const store = storeFor(server);
    const written = await store.putState(DOC, null, 'first write from the shop floor');
    expect(server.state?.sha).toBe(blobSha(new TextEncoder().encode(JSON.stringify(DOC))));
    const read = await store.getState();
    expect(read?.sha).toBe(written.sha);
    // Not `toEqual(DOC)`: the decoder fills in whatever the document left out, so a
    // read is the document *understood*, not the bytes that went in. The stamp and
    // the version are the parts that have to survive.
    expect(read?.content.version).toBe(1);
    expect(read?.content.updatedAt).toBe(DOC.updatedAt);
  });

  it('asks for a first write with If-None-Match and a replacement by the sha it read', async () => {
    const server = new FakeShopServer();
    const store = storeFor(server);
    await store.putState(DOC, null, 'first');
    expect(server.last().headers['If-None-Match']).toBe('*');
    const first = server.state?.sha;
    await store.putState(DOC, first ?? '', 'second');
    expect(server.last().headers['If-Match']).toBe(`"${String(first)}"`);
    expect(server.last().query.get('message')).toBe('second');
    expect(server.last().query.get('device')).toBe('Shop PC');
  });

  it('comes back with the number the server holds when someone else wrote first', async () => {
    const server = new FakeShopServer();
    const store = storeFor(server);
    await store.putState(DOC, null, 'first');
    const stale = `${blobSha(new TextEncoder().encode('somebody else'))}`;
    let caught: unknown;
    try {
      await store.putState(DOC, stale, 'mine');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    expect((caught as ConflictError).serverSha).toBe(server.state?.sha);
  });

  it('names the problem when the server refuses, instead of a bare status code', async () => {
    const server = new FakeShopServer();
    const store = new ServerStore('', 'Shop PC', server.fetch());
    let caught: unknown;
    try {
      await store.getState();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StoreError);
    expect((caught as StoreError).message).toMatch(/key|device/i);
  });
});

describe('the two workbooks', () => {
  function stockBytes(): Uint8Array {
    return workbookBytes([
      { name: 'Sheet1', grid: [...banner('Item List [Summary]'), ['Item No.', 'Units On Hand'], ['GL4', 12]] },
    ]);
  }

  it('sends the file itself, not a copy of it described in JSON', async () => {
    const server = new FakeShopServer();
    const store = storeFor(server);
    const bytes = stockBytes();
    const written = await store.putBinaryFile('exports/location.xlsx', bytes, null, 'exports: location.xlsx from Shop PC');
    expect(ArrayBuffer.isView(server.last().body)).toBe(true);
    expect(server.exports.get('location')).toEqual(bytes);
    expect(written.sha).toBe(blobSha(bytes));
    expect(server.last().query.get('message')).toBe('exports: location.xlsx from Shop PC');
  });

  it('reads a workbook back as the same bytes it was, and with the same sha', async () => {
    const server = new FakeShopServer();
    const store = storeFor(server);
    const bytes = stockBytes();
    await store.putBinaryFile('exports/location.xlsx', bytes, null, 'sent');
    const read = await store.getBinaryFile('exports/location.xlsx');
    expect(read?.bytes).toEqual(bytes);
    expect(read?.sha).toBe(blobSha(bytes));
  });

  it('asks what a workbook is worth without pulling it down', async () => {
    const server = new FakeShopServer();
    const store = storeFor(server);
    const bytes = stockBytes();
    await store.putBinaryFile('exports/future.xlsx', bytes, null, 'sent');
    server.calls.length = 0;
    const sha = await store.getEntrySha('exports/future.xlsx');
    expect(sha).toBe(blobSha(bytes));
    expect(server.calls.every((c) => c.path === '/api/history')).toBe(true);
    expect(server.calls[0]?.query.get('path')).toBe('exports/future.xlsx');
  });

  it('says there is no sha when the file has never been sent', async () => {
    const server = new FakeShopServer();
    expect(await storeFor(server).getEntrySha('exports/location.xlsx')).toBeNull();
  });

  it('refuses to pretend a third file is one of the two it keeps', async () => {
    const server = new FakeShopServer();
    let caught: unknown;
    try {
      await storeFor(server).getBinaryFile('exports/whatever.xlsx');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StoreError);
    expect((caught as StoreError).message).toMatch(/two workbooks/);
  });

  it('says so when the response cannot be handed over as bytes', async () => {
    const server = new FakeShopServer();
    server.bytesCapable = false;
    const store = storeFor(server);
    await store.putBinaryFile('exports/location.xlsx', stockBytes(), null, 'sent');
    await expect(store.getBinaryFile('exports/location.xlsx')).rejects.toThrow(/bytes/);
  });
});

describe('connecting a device', () => {
  it('trades the code on the box for a key, once', async () => {
    const server = new FakeShopServer();
    const first = await redeemSetupCode('k7qm2xbt', 'Shop PC', server.fetch());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.token).toHaveLength(40);

    // The code has been spent. A second owner is not a thing this box allows.
    const second = await redeemSetupCode('K7QM2XBT', 'Another PC', server.fetch());
    expect(second.ok).toBe(false);
  });

  it('lets the first device introduce the next one', async () => {
    const server = new FakeShopServer();
    const owner = await redeemSetupCode('K7QM2XBT', 'Shop PC', server.fetch());
    if (!owner.ok) throw new Error('the owner should have been created');
    const fetchImpl = server.fetch();
    const next = await fetchImpl('/api/device/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({ name: 'Office laptop' }),
    });
    expect(next.status).toBe(200);
    expect(server.devices.size).toBe(2);
  });

  it('reports a refusal in words, not as a thrown number', async () => {
    const server = new FakeShopServer();
    const bad = await redeemSetupCode('NOPE1234', 'Shop PC', server.fetch());
    expect(bad).toEqual({ ok: false, reason: 'the setup code is not the one this server printed' });
  });
});

describe('reaching the shop server', () => {
  it('says what to do when the address is not a shop server', async () => {
    const server = new FakeShopServer();
    server.healthOk = false;
    forgetStoreProbe();
    const check = await storeFor(server).validateToken();
    expect(check).toEqual({ ok: false, reason: 'no shop server answered at /api/health on this address' });
  });

  it('proves a write by writing the same bytes back', async () => {
    const server = new FakeShopServer();
    const store = storeFor(server, 'Shop PC');
    await store.putState(DOC, null, 'first');
    const before = server.state?.sha;
    const check = await store.validateToken(true);
    expect(check).toEqual({ ok: true, canWrite: true });
    // The document did not change — a compare-and-set against yourself.
    expect(server.state?.sha).toBe(before);
    expect(server.last().query.get('message')).toBe('connection test from Shop PC');
  });

  it('will not claim a device with no key can write', async () => {
    const server = new FakeShopServer();
    const check = await new ServerStore('', 'Shop PC', server.fetch()).validateToken(true);
    expect(check.ok).toBe(false);
  });
});
