// @vitest-environment node
/**
 * The server, from the outside.
 *
 * Every case here is a request a device in the shop actually makes, against a real
 * port and a real folder, with `fetch` rather than a mock: the seams this server lives
 * on are HTTP ones — `If-Match`, `ETag`, status codes, and a body that has to come
 * back byte for byte — and a mock would test the shape of my own assumptions instead
 * of the thing the app depends on.
 *
 * Two of these are load-bearing in a way the others are not:
 *
 * - **The sha is the git blob sha, recomputed here** with `createHash('sha1')` over
 *   `blob <len>\0` plus the bytes, exactly as `test/core.folderSource.test.ts` pins it
 *   for the browser. If the server and the browser ever disagree about this, nothing
 *   errors — a compare simply never matches, every write conflicts, and the shop's
 *   numbers stop arriving. It has to be checked against the definition, not against
 *   the server's own function, which is what this file does.
 * - **Two concurrent writes, one 200 and one 409.** The whole conflict story is that
 *   nobody silently overwrites anybody. If the check and the write were not one
 *   indivisible step, both writers would be told they won and one floor's work would
 *   be gone with a straight face.
 *
 * Each test gets its own `mkdtemp`, so no case can pass on a file another left
 * behind, and the first-run setup code is genuinely first-run every time.
 */

import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { configFromEnv } from '../server/src/config.js';
import { startServer } from '../server/src/index.js';
import type { RunningServer } from '../server/src/index.js';

const MAX_STATE_BYTES = 8 * 1024 * 1024;

interface Harness {
  /** Origin, `http://127.0.0.1:<the port the OS gave us>`. */
  base: string;
  dataDir: string;
  /** The one-time code this start printed, or `null` if the folder already had devices. */
  setupCode: string | null;
  /** The request lines the server logged, in order. */
  lines: string[];
  /** The lines it printed for the person standing at the console. */
  prints: string[];
  url(path: string): string;
  close(): Promise<void>;
}

const started: { server: RunningServer; dir: string }[] = [];

/**
 * One request through `node:http` rather than `fetch`.
 *
 * `fetch` is the right tool everywhere else in this file because it is what the app
 * uses, but it transparently decompresses and then drops the very headers these cases
 * are about, and it also rewrites a path before sending it. Anything that has to be
 * seen exactly as it goes over the wire is sent here.
 */
function raw(
  harness: Harness,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return new Promise((resolveReq, rejectReq) => {
    const req = request(
      { host: '127.0.0.1', port: new URL(harness.base).port, path, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolveReq({
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string | string[] | undefined>,
            body: Buffer.concat(chunks),
          }),
        );
        res.on('error', rejectReq);
      },
    );
    req.on('error', rejectReq);
    req.end();
  });
}

/**
 * A server on a port nobody else has, in a folder nobody else has.
 *
 * Port 0 and a fresh `mkdtemp` are the two things that let a dozen of these run in one
 * process without interference. `log` is captured rather than printed: a suite that
 * dumps its request lines is a suite nobody reads, and one test wants to count them.
 */
async function boot(options: { open?: boolean } = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'freo-server-test-'));
  const dataDir = join(dir, 'data');
  const staticDir = join(dir, 'static');
  await mkdir(join(staticDir, 'assets'), { recursive: true });
  await writeFile(join(staticDir, 'index.html'), '<!doctype html><title>Freo test shell</title>\n');
  // Big enough that compressing it is worth doing at all, and repetitive enough that
  // gzip demonstrably shrinks it: a bundle-shaped file, not a hello-world.
  await writeFile(join(staticDir, 'assets', 'index-abc123.js'), 'console.log("the app");\n');
  await writeFile(join(staticDir, 'assets', 'big-def456.js'), 'const row = { code: "600x300", area: 0.18 };\n'.repeat(120));
  // Not a PNG, and it does not matter: the type is decided by the extension, and the
  // rule under test is that an already-compressed type is never gzipped again.
  await writeFile(join(staticDir, 'icon-192.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  const open = options.open ?? true;
  // Through `configFromEnv` rather than an object literal, so the documented variable
  // names are the ones under test.
  const config = configFromEnv({ FREO_OPEN: open ? '1' : '0', FREO_DATA: dataDir, FREO_STATIC: staticDir });
  const lines: string[] = [];
  const prints: string[] = [];
  const server = await startServer({
    config,
    port: 0,
    host: '127.0.0.1',
    log: (line) => lines.push(line),
    print: (line) => prints.push(line),
  });
  started.push({ server, dir });

  const origin = `http://127.0.0.1:${String(server.port)}`;
  return {
    base: origin,
    dataDir,
    setupCode: server.setupCode,
    lines,
    prints,
    url: (path: string) => `${origin}${path}`,
    close: server.close,
  };
}

afterEach(async () => {
  const running = started.splice(0, started.length);
  for (const { server, dir } of running) {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/** The number the browser computes: `git hash-object`, over the bytes, not the characters. */
function gitBlobSha(bytes: Uint8Array): string {
  const hash = createHash('sha1');
  hash.update(`blob ${String(bytes.byteLength)}\0`, 'utf8');
  hash.update(bytes);
  return hash.digest('hex');
}

/** A state document with the characters that break a character-count header. */
function shopDocument(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 3,
    products: [{ id: 'p1', name: 'Quartz paver 60×30', area: '42.5 m²', note: 'ready — bays 3–6' }],
    ...overrides,
  });
}

/**
 * The bytes of a workbook that is not a workbook. Size is what the server looks at.
 *
 * No return-type annotation on purpose. Written as `Buffer` it becomes
 * `Buffer<ArrayBufferLike>`, which is a view over somebody's buffer and so is refused
 * by `fetch`; left to be inferred it is a `Buffer` over a buffer of its own, which is
 * what a body has to be. The assertion the tests make is about bytes either way.
 */
function workbookBytes(size: number) {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) bytes[i] = (i * 31 + 7) % 251;
  return bytes;
}

/** Spend the setup code for a device and hand back its token. */
async function ownerToken(harness: Harness, name = 'Shop PC'): Promise<string> {
  const res = await fetch(harness.url('/api/device/token'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: harness.setupCode, name }),
  });
  const body = (await res.json()) as { token?: string };
  expect(res.status).toBe(200);
  expect(typeof body.token).toBe('string');
  return body.token ?? '';
}

async function getState(harness: Harness, token?: string): Promise<Response> {
  return fetch(harness.url('/api/state'), token ? { headers: { Authorization: `Bearer ${token}` } } : {});
}

describe('the server answers', () => {
  it('says it is the shop server, without a token, whatever the data folder holds', async () => {
    const harness = await boot({ open: false });
    const res = await fetch(harness.url('/api/health'));
    expect(res.status).toBe(200);
    // The app's probe looks for exactly this field; without it the app falls back to
    // GitHub and nobody knows for an hour.
    await expect(res.json()).resolves.toEqual({ ok: true, store: 'server', version: expect.any(String) });
  });

  it('answers a request whose address has a doubled slash, because people type trailing slashes', async () => {
    // `http://box:8787//api/health` is what actually arrives when someone types a
    // trailing slash into an address field, or when a proxy joins a prefix onto a path
    // that already ended in one. The router used to see an empty first segment, decide
    // it was not the API, and let the file handler answer a state request with "GET or
    // HEAD only" — a true sentence about files, and one that would have cost an hour on
    // the day the shop switched to this box.
    const harness = await boot({ open: false });
    const res = await fetch(`${harness.base}//api/health`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ store: 'server' });
  });

  it('serves the built app at / and the API at /api from one port', async () => {
    const harness = await boot();
    const page = await fetch(harness.url('/'));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Freo test shell');

    const asset = await fetch(harness.url('/assets/index-abc123.js'));
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');

    // An asset that is not there must stay a 404: HTML served where JavaScript was
    // asked for is a blank screen with no clue as to why.
    const missing = await fetch(harness.url('/assets/nothing-here.js'));
    expect(missing.status).toBe(404);
  });

  it('compresses text when the client can read it, and never touches what is already compressed', async () => {
    const harness = await boot();

    const packed = await raw(harness, '/assets/big-def456.js', { 'Accept-Encoding': 'gzip' });
    expect(packed.status).toBe(200);
    expect(packed.headers['content-encoding']).toBe('gzip');
    // Compressing something that comes back bigger than it went in is a slowdown
    // nobody can see, so the server has to notice and drop it.
    expect(Number(packed.headers['content-length'])).toBeLessThan(4_800);

    const plain = await raw(harness, '/assets/big-def456.js', { 'Accept-Encoding': 'br' });
    expect(plain.headers['content-encoding']).toBeUndefined();

    // A PNG is a deflate stream already: gzipping it again is CPU for nothing, and on
    // phone wifi the extra bytes arrive anyway.
    const png = await raw(harness, '/icon-192.png', { 'Accept-Encoding': 'gzip' });
    expect(png.headers['content-type']).toBe('image/png');
    expect(png.headers['content-encoding']).toBeUndefined();
  });

  it('refuses a path that tries to leave the folder it serves, with a 404 and not a 500', async () => {
    const harness = await boot();
    // Sent through `node:http` (see `raw` above) because `fetch` normalises `..` away
    // before it ever reaches the server, and the guard is only interesting on a request
    // that arrives with the dots still in it.
    const attack = await new Promise<{ status: number; body: string }>((resolveReq) => {
      const req = request({ host: '127.0.0.1', port: new URL(harness.base).port, path: '/..%2f..%2fpackage.json' }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolveReq({ status: res.statusCode ?? 0, body }));
      });
      req.end();
    });
    expect(attack.status).toBe(404);
    expect(attack.body).not.toContain('freo-stone-production');

    // `fetch` normalises `%2e%2e` into `..` before sending, so this one arrives as an
    // ordinary unknown app route. The right answer is the app shell — and the thing to
    // prove is that it is the shell and not the file somebody asked for.
    const normalised = await fetch(harness.url('/%2e%2e/etc/passwd'));
    expect(normalised.status).toBe(200);
    const body = await normalised.text();
    expect(body).toContain('Freo test shell');
    expect(body).not.toContain('root:');
  });
});

describe('the shop document', () => {
  it('takes a first write against nothing and reads back identical', async () => {
    const harness = await boot();
    const sent = shopDocument();

    const write = await fetch(harness.url('/api/state?message=first%20save&device=Shop%20PC&unknown=1'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-None-Match': '*' },
      body: sent,
    });
    // Unknown parameters are accepted and ignored: a newer app must not be refused by
    // an older box, or the two have to be upgraded together.
    expect(write.status).toBe(200);

    const read = await getState(harness);
    expect(read.status).toBe(200);
    const body = (await read.json()) as { sha: string; content: unknown };
    expect(body.content).toEqual(JSON.parse(sent));
    expect(body.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('answers a write whose If-Match is out of date with 409 and the sha it holds', async () => {
    const harness = await boot();
    await fetch(harness.url('/api/state'), { method: 'PUT', body: shopDocument() });
    const current = ((await (await getState(harness)).json()) as { sha: string }).sha;

    const stale = await fetch(harness.url('/api/state'), {
      method: 'PUT',
      headers: { 'If-Match': `"${'0'.repeat(40)}"` },
      body: shopDocument({ version: 4 }),
    });
    expect(stale.status).toBe(409);
    // The number is the whole point of the 409: the app merges against it and retries.
    expect(((await stale.json()) as { sha: string }).sha).toBe(current);
  });

  it('accepts an If-Match with or without the quotes, because curl has no quotes', async () => {
    const harness = await boot();
    await fetch(harness.url('/api/state'), { method: 'PUT', body: shopDocument() });
    const current = ((await (await getState(harness)).json()) as { sha: string }).sha;

    const bare = await fetch(harness.url('/api/state'), { method: 'PUT', headers: { 'If-Match': current }, body: shopDocument({ version: 4 }) });
    expect(bare.status).toBe(200);
  });

  it('gives the git blob sha of the bytes, the same number the browser computes', async () => {
    const harness = await boot();
    const sent = shopDocument();
    const bytes = new TextEncoder().encode(sent);

    const write = await fetch(harness.url('/api/state'), { method: 'PUT', body: bytes });
    const sha = ((await write.json()) as { sha: string }).sha;
    // Recomputed here from the definition. The document carries `m²` and an em dash, so
    // a header built from the character count instead of the byte count fails this test
    // rather than quietly failing every compare in production.
    expect(sha).toBe(gitBlobSha(bytes));

    const workbook = workbookBytes(4096);
    const putWorkbook = await fetch(harness.url('/api/exports/location'), { method: 'PUT', body: workbook });
    expect(((await putWorkbook.json()) as { sha: string }).sha).toBe(gitBlobSha(workbook));
  });

  it('leaves the stored document alone when what arrives is not JSON', async () => {
    const harness = await boot();
    const good = shopDocument();
    await fetch(harness.url('/api/state'), { method: 'PUT', body: good });
    const before = ((await (await getState(harness)).json()) as { sha: string }).sha;

    const broken = await fetch(harness.url('/api/state?message=half%20a%20document'), {
      method: 'PUT',
      body: '{"version": 3, "products": [',
    });
    expect(broken.status).toBe(400);
    const error = (await broken.json()) as { error: { code: string; message: string } };
    expect(error.error.code).toBe('invalid_json');
    expect(error.error.message.length).toBeGreaterThan(20);

    const after = (await (await getState(harness)).json()) as { sha: string; content: unknown };
    expect(after.sha).toBe(before);
    expect(after.content).toEqual(JSON.parse(good));
  });

  it('refuses a state document over 8 MB with 413, and does not store it', async () => {
    const harness = await boot();
    const tooBig = Buffer.alloc(MAX_STATE_BYTES + 1, 0x61);
    const res = await fetch(harness.url('/api/state'), { method: 'PUT', body: tooBig });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('too_large');
    expect((await getState(harness)).status).toBe(404);
  });

  it('refuses to create a document twice, and to overwrite one that was never created', async () => {
    const harness = await boot();
    await fetch(harness.url('/api/state'), { method: 'PUT', body: shopDocument() });

    const twice = await fetch(harness.url('/api/state'), { method: 'PUT', headers: { 'If-None-Match': '*' }, body: shopDocument() });
    expect(twice.status).toBe(409);

    const neverMade = await fetch(harness.url('/api/exports/future'), { method: 'PUT', headers: { 'If-Match': `"${'1'.repeat(40)}"` }, body: workbookBytes(64) });
    expect(neverMade.status).toBe(409);
  });

  it('settles two writers at once with exactly one 200 and one 409', async () => {
    const harness = await boot();
    await fetch(harness.url('/api/state'), { method: 'PUT', body: shopDocument() });
    const sha = ((await (await getState(harness)).json()) as { sha: string }).sha;

    const write = (): Promise<number> =>
      fetch(harness.url('/api/state?message=both%20at%20once'), {
        method: 'PUT',
        headers: { 'If-Match': `"${sha}"` },
        body: shopDocument({ writtenBy: 'either of us' }),
      }).then((res) => res.status);

    const statuses = (await Promise.all([write(), write()])).sort();
    expect(statuses).toEqual([200, 409]);
  });
});

describe('the two workbooks', () => {
  it('takes a workbook, says which version it is, and answers 304 when asked if it changed', async () => {
    const harness = await boot();
    const bytes = workbookBytes(6000);

    const put = await fetch(harness.url('/api/exports/location?message=weekly%20export&device=Office%20PC'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes,
    });
    expect(put.status).toBe(200);
    const sha = ((await put.json()) as { sha: string }).sha;

    const get = await fetch(harness.url('/api/exports/location'));
    expect(get.status).toBe(200);
    expect(get.headers.get('etag')).toBe(`"${sha}"`);
    expect(get.headers.get('content-length')).toBe('6000');
    expect(get.headers.get('cache-control')).toBe('no-cache');
    expect(get.headers.get('last-modified')).not.toBeNull();
    // Byte for byte, not "same length" and not "parses the same": the workbook the
    // office PC opens has to be the one that was put here.
    const got = new Uint8Array(await get.arrayBuffer());
    expect(Array.from(got)).toEqual(Array.from(bytes));

    const again = await fetch(harness.url('/api/exports/location'), { headers: { 'If-None-Match': `"${sha}"` } });
    expect(again.status).toBe(304);
    // A 304 with a body is a corrupt response, not a small one.
    expect(await again.text()).toBe('');
  });

  it('knows only two workbooks, and says so about everything else', async () => {
    const harness = await boot();
    for (const kind of ['location2', 'other', 'state']) {
      const res = await fetch(harness.url(`/api/exports/${kind}`), { method: 'PUT', body: workbookBytes(16) });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('unknown_kind');
    }
    // The message names the two that do exist, because the person reading it is the
    // one who has to go and fix the path in Settings.
    const message = ((await (await fetch(harness.url('/api/exports/loaction'))).json()) as { error: { message: string } }).error.message;
    expect(message).toContain('location');
    expect(message).toContain('future');
  });

  it('refuses a workbook over 32 MB with 413', async () => {
    const harness = await boot();
    const res = await fetch(harness.url('/api/exports/future'), {
      method: 'PUT',
      body: Buffer.alloc(33 * 1024 * 1024, 0x62),
    });
    expect(res.status).toBe(413);
  });

  it('serves a workbook it has never seen as 404, in a sentence', async () => {
    const harness = await boot();
    const res = await fetch(harness.url('/api/exports/future'));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain('MYOB');
  });
});

describe('the history', () => {
  it('returns writes newest first, with the message and the device that made them', async () => {
    const harness = await boot();
    await fetch(harness.url('/api/state?message=monday%27s%20counts&device=Shop%20PC'), { method: 'PUT', body: shopDocument() });
    const put = await fetch(harness.url('/api/state?message=tuesday%27s%20corrections&device=Office%20PC'), {
      method: 'PUT',
      headers: { 'If-Match': `"${((await (await getState(harness)).json()) as { sha: string }).sha}"` },
      body: shopDocument({ version: 4 }),
    });
    expect(put.status).toBe(200);

    const res = await fetch(harness.url('/api/history?path=state%2Fstate.json&limit=10'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: { at: string; path: string; sha: string; device: string; message: string }[] };
    expect(body.entries.map((entry) => entry.message)).toEqual(["tuesday's corrections", "monday's counts"]);
    expect(body.entries[0]?.device).toBe('Office PC');
    expect(body.entries[0]?.path).toBe('state/state.json');
    expect(body.entries[0]?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('carries an em dash in a message, which is why metadata is not a header', async () => {
    const harness = await boot();
    await fetch(harness.url(`/api/state?message=${encodeURIComponent('saved — bays 3–6 ready')}`), {
      method: 'PUT',
      body: shopDocument(),
    });
    const entries = ((await (await fetch(harness.url('/api/history?path=state%2Fstate.json'))).json()) as {
      entries: { message: string }[];
    }).entries;
    expect(entries[0]?.message).toBe('saved — bays 3–6 ready');
  });

  it('answers what a workbook is worth today, so the app need not download it', async () => {
    const harness = await boot();
    const bytes = workbookBytes(5000);
    await fetch(harness.url('/api/exports/location?message=the%20week%27s%20stock'), {
      method: 'PUT',
      body: bytes,
    });
    const current = (await fetch(harness.url('/api/exports/location'))).headers.get('etag')?.replace(/"/g, '');

    const res = await fetch(harness.url('/api/history?path=exports%2Flocation.xlsx&limit=1'));
    const body = (await res.json()) as { entries: { sha: string; device: string; message: string }[] };
    // The folder watch compares this against the file in its own folder. If it were
    // ever the sha of an older copy, the watch would call the two different forever
    // and republish a two-megabyte workbook on every tick.
    expect(body.entries[0]?.sha).toBe(current);
    expect(body.entries[0]?.message).toBe("the week's stock");
  });

  it('says it has no history for a path it does not keep', async () => {
    const harness = await boot();
    const unknown = await fetch(harness.url('/api/history?path=etc%2Fpasswd'));
    expect(unknown.status).toBe(404);
    expect((await fetch(harness.url('/api/history'))).status).toBe(400);
  });
});

describe('devices and their keys', () => {
  it('mints exactly one owner from the setup code, and refuses the code afterwards', async () => {
    const harness = await boot({ open: false });
    expect(harness.setupCode).toMatch(/^[A-Z0-9]{8}$/);
    // Written 0600: it is a key until it is spent, and a world-readable one can be read
    // by anyone who can log into the box.
    expect((await stat(join(harness.dataDir, 'setup-code'))).mode & 0o777).toBe(0o600);

    const first = await fetch(harness.url('/api/device/token'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: harness.setupCode, name: 'Shop PC' }),
    });
    expect(first.status).toBe(200);
    const minted = (await first.json()) as { token: string; deviceId: string; role: string };
    expect(minted.token).toMatch(/^[0-9a-f]{40}$/);
    expect(minted.deviceId).not.toBe('');
    expect(minted.role).toBe('owner');

    const again = await fetch(harness.url('/api/device/token'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: harness.setupCode, name: 'Someone else' }),
    });
    expect(again.status).toBe(401);
    const reason = (await again.json()) as { error: { message: string } };
    // A sentence a person can act on, not a status word.
    expect(reason.error.message).toContain('once');

    // The token is never on disk — only its sha256 is, so a stolen backup is not a set
    // of working keys.
    const devicesFile = await readFile(join(harness.dataDir, 'devices.json'), 'utf8');
    expect(devicesFile).not.toContain(minted.token);
    expect(devicesFile).toContain('tokenSha256');

    // Spending the code deletes it. A code that stays in the folder after use is a
    // code that gets typed by the next person who finds it.
    await expect(stat(join(harness.dataDir, 'setup-code'))).rejects.toThrow();
  });

  it('lets a device that has a key introduce the next one', async () => {
    const harness = await boot({ open: false });
    const token = await ownerToken(harness);

    const introduced = await fetch(harness.url('/api/device/token'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'Back office laptop' }),
    });
    expect(introduced.status).toBe(201);
    const minted = (await introduced.json()) as { token: string; role: string; introducedBy: string };
    expect(minted.token).toMatch(/^[0-9a-f]{40}$/);
    expect(minted.token).not.toBe(token);
    expect(minted.role).toBe('device');
    expect(minted.introducedBy).toBe('Shop PC');

    // The new key is a key, not a receipt: it reads the shop document.
    await fetch(harness.url('/api/state'), { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: shopDocument() });
    const read = await fetch(harness.url('/api/state'), { headers: { Authorization: `Bearer ${minted.token}` } });
    expect(read.status).toBe(200);
  });

  it('refuses a request with no token, a malformed token and an unknown token, all 401', async () => {
    const harness = await boot({ open: false });
    const none = await fetch(harness.url('/api/state'));
    expect(none.status).toBe(401);
    expect(((await none.json()) as { error: { code: string } }).error.code).toBe('no_token');

    const malformed = await fetch(harness.url('/api/state'), { headers: { Authorization: 'Bearer not-a-key' } });
    expect(malformed.status).toBe(401);

    const unknown = await fetch(harness.url('/api/state'), { headers: { Authorization: `Bearer ${'a'.repeat(40)}` } });
    expect(unknown.status).toBe(401);
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe('unknown_device');
  });

  it('still answers /api/health without a token, because that is how the app finds the server', async () => {
    const harness = await boot({ open: false });
    expect((await fetch(harness.url('/api/health'))).status).toBe(200);
  });

  it('needs no token at all when FREO_OPEN=1', async () => {
    const harness = await boot({ open: true });
    const write = await fetch(harness.url('/api/state'), { method: 'PUT', body: shopDocument() });
    expect(write.status).toBe(200);
    expect((await getState(harness)).status).toBe(200);
  });

  it('preflights with the methods and headers it will accept', async () => {
    const harness = await boot();
    const res = await fetch(harness.url('/api/state'), { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toBe('GET,POST,PUT,OPTIONS');
    expect(res.headers.get('access-control-allow-headers')).toContain('If-Match');
  });
});

describe('the log', () => {
  it('writes exactly one line per request, and never a token', async () => {
    const harness = await boot({ open: false });
    const token = await ownerToken(harness);
    await fetch(harness.url('/api/state?device=Shop%20PC'), { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: shopDocument() });
    await getState(harness, token);

    // Mint, write, read — three requests, three lines. A write logged twice reads as
    // two writes to whoever is counting the shop's changes.
    expect(harness.lines).toHaveLength(3);
    expect(harness.lines.every((line) => line.includes('elapsed='))).toBe(true);
    expect(harness.lines.join('\n')).not.toContain(token);
    expect(harness.lines[1]).toContain('PUT /api/state 200');
    expect(harness.lines[1]).toContain('device=Shop_PC');
  });

  it('prints the setup code in words at first run, and never prints a token', async () => {
    const harness = await boot({ open: false });
    const token = await ownerToken(harness);
    const printed = harness.prints.join('\n');
    expect(printed).toContain(harness.setupCode ?? '');
    expect(printed.toLowerCase()).toContain('works once');
    expect(printed).not.toContain(token);
  });
});
