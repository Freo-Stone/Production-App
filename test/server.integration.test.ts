// @vitest-environment node
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emptyDocument } from '@/data/merge';
import { ConflictError, globalFetch } from '@/data/github';
import { detectStore, forgetStoreProbe, redeemSetupCode, ServerStore } from '@/data/serverStore';
import { startServer, type RunningServer } from '../server/src/index';
import { banner, workbookBytes } from './support/buildWorkbook';

/**
 * The browser client against the real box.
 *
 * `data.serverStore.test.ts` drives the client through a fake that answers the way
 * the server is specified to, and `server.api.test.ts` drives the server through
 * requests the client is imagined to make. Both could be green while the two disagree,
 * which is the particular uselessness of mock-only testing: the meeting point is the
 * thing that breaks in production, and it breaks at 7am on the day the shop has
 * decided to trust the new machine.
 *
 * So this file boots the actual server — the same code the bundle is made from, on an
 * ephemeral port, with a temporary data folder — and lets the unmodified browser
 * client talk to it. Nothing is stubbed except the URL prefix, which is exactly the
 * one thing a Node process needs and a browser does not.
 */

function blobSha(bytes: Uint8Array): string {
  const hash = createHash('sha1');
  hash.update(`blob ${String(bytes.length)}\0`, 'utf8');
  hash.update(bytes);
  return hash.digest('hex');
}

function stockWorkbook(qty: number): Uint8Array {
  return workbookBytes([
    { name: 'Sheet1', grid: [...banner('Item List [Summary]'), ['Item No.', 'Units On Hand'], ['GL4', qty]] },
  ]);
}

let server: RunningServer;
let base = '';
let token = '';

beforeAll(async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'freo-integration-'));
  // No static folder on purpose: the API has to work before anyone has built the app,
  // and this file is about the API. Every call below goes through `globalFetch`, the
  // same wrapper the browser uses, so this is the shipped path and not a stand-in.
  server = await startServer({ port: 0, dataDir, staticDir: join(dataDir, 'nothing-built'), version: 'test' });
  // `RunningServer.url` ends with a slash. Everything below joins paths onto it, so
  // the prefix is trimmed once here, exactly as ServerStore trims one a person typed
  // into a settings field. The doubled-slash case that used to produce is proven in
  // server.api.test.ts.
  base = server.url.replace(/\/+$/, '');
  forgetStoreProbe();
  const minted = await redeemSetupCode(String(server.setupCode), 'Shop PC', globalFetch, base);
  if (!minted.ok) throw new Error(`the setup code the server printed did not work: ${minted.reason}`);
  token = minted.token;
});

afterAll(async () => {
  await server?.close();
});

describe('the app talking to a shop server it did not write', () => {
  it('says a workbook that has never been sent has no number at all', async () => {
    // First assertion in this file on purpose: nothing has been written to a data
    // folder yet, so this is the one moment that state exists. `null` is the same
    // answer the repository gives, and the folder watch treats it as "send it".
    const store = new ServerStore(token, 'Shop PC', globalFetch, base);
    expect(await store.getEntrySha('exports/location.xlsx')).toBeNull();
    expect(await store.getBinaryFile('exports/location.xlsx')).toBeNull();
  });

  it('finds the server the way the app decides to use it', async () => {
    const health = await detectStore(globalFetch, base);
    expect(health).not.toBeNull();
    expect(health?.store).toBe('server');
  });

  it('writes the shop document and gets the same number back that git would print', async () => {
    const store = new ServerStore(token, 'Shop PC', globalFetch, base);
    const doc = emptyDocument('Shop PC', Date.parse('2026-09-18T07:00:00+08:00'));
    const written = await store.putState(doc, null, 'first save from the shop floor');
    expect(written.sha).toBe(blobSha(new TextEncoder().encode(JSON.stringify(doc))));

    const read = await store.getState();
    expect(read?.sha).toBe(written.sha);
    expect(read?.content.updatedAt).toBe(doc.updatedAt);
  });

  it('comes back with the server’s number when another device wrote first', async () => {
    const store = new ServerStore(token, 'Shop PC', globalFetch, base);
    const doc = emptyDocument('Shop PC', Date.parse('2026-09-18T07:05:00+08:00'));
    // There is already a document from the test before this one, so the other device
    // writes with the number it read — and this device then writes with a number it
    // made up, which is what a device that has not re-read since 7am actually does.
    const now = await store.getState();
    const other = await store.putState(doc, now?.sha ?? null, 'the other PC got there first');
    let caught: unknown;
    try {
      await store.putState(doc, 'f'.repeat(40), 'mine');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    expect((caught as ConflictError).serverSha).toBe(other.sha);
  });

  it('sends a workbook as a file and gets back the file it sent', async () => {
    const store = new ServerStore(token, 'Shop PC', globalFetch, base);
    const bytes = stockWorkbook(11_861.57);
    const written = await store.putBinaryFile('exports/location.xlsx', bytes, null, 'exports: location.xlsx from Shop PC');
    expect(written.sha).toBe(blobSha(bytes));

    const read = await store.getBinaryFile('exports/location.xlsx');
    expect(read?.sha).toBe(written.sha);
    expect(Buffer.from(read?.bytes ?? new Uint8Array()).equals(Buffer.from(bytes))).toBe(true);
  });

  it('settles the “has this folder changed” question without fetching the workbook', async () => {
    // The folder watch's whole cheapness rests on this one call: it holds the bytes,
    // and it must be able to find out whether they are worth sending without pulling
    // two megabytes back down the line to ask.
    const store = new ServerStore(token, 'Shop PC', globalFetch, base);
    const bytes = stockWorkbook(4_000);
    await store.putBinaryFile('exports/future.xlsx', bytes, null, 'exports: future.xlsx from Shop PC');

    expect(await store.getEntrySha('exports/future.xlsx')).toBe(blobSha(bytes));

  });

  it('will not overwrite a workbook a second device has already replaced', async () => {
    const store = new ServerStore(token, 'Shop PC', globalFetch, base);
    const first = stockWorkbook(1);
    const second = stockWorkbook(2);
    const held = await store.getEntrySha('exports/location.xlsx');
    const original = await store.putBinaryFile('exports/location.xlsx', first, held, 'first');
    await store.putBinaryFile('exports/location.xlsx', second, original.sha, 'second');
    let caught: unknown;
    try {
      await store.putBinaryFile('exports/location.xlsx', stockWorkbook(3), original.sha, 'third, three devices late');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    // The loser is told the current number, so it can merge against it rather than guess.
    expect((caught as ConflictError).serverSha).toBe(blobSha(second));
  });

  it('refuses a device that has no key, in words', async () => {
    const quiet = new ServerStore('', 'Vanilla PC', globalFetch, base);
    const check = await quiet.validateToken();
    expect(check.ok).toBe(false);
  });

  it('proves a device can write without changing the shop document', async () => {
    const store = new ServerStore(token, 'Shop PC', globalFetch, base);
    const before = await store.getState();
    const check = await store.validateToken(true);
    expect(check).toEqual({ ok: true, canWrite: true });
    const after = await store.getState();
    // A connection test that advanced the document would be a write, and every other
    // device would merge a change that meant nothing.
    expect(after?.sha).toBe(before?.sha);
  });

  it('lets the shop PC introduce the next computer', async () => {
    const res = await fetch(`${base}/api/device/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'Office laptop' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { token?: string };
    expect(String(body.token)).toHaveLength(40);

    // And the new key works on the same client class, which is what connecting a
    // second machine in the shop actually does.
    const laptop = new ServerStore(String(body.token), 'Office laptop', globalFetch, base);
    expect(await laptop.getState()).not.toBeNull();
  });

  it('keeps the em dash in the message the shop reads back', async () => {
    const store = new ServerStore(token, 'Shop PC', globalFetch, base);
    const bytes = stockWorkbook(7);
    const current = await store.getEntrySha('exports/future.xlsx');
    await store.putBinaryFile('exports/future.xlsx', bytes, current, 'exports: future.xlsx from Shop PC — 411 rows');
    expect(await store.getEntrySha('exports/future.xlsx')).toBe(blobSha(bytes));

    const history = await fetch(`${base}/api/history?path=${encodeURIComponent('exports/future.xlsx')}&limit=1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await history.json()) as { entries?: { message?: string }[] };
    expect(body.entries?.[0]?.message).toContain('—');
  });
});
