/**
 * The routes, and nothing else.
 *
 * The rules this file exists to enforce are four, and each has a reason that outlives
 * the code:
 *
 * - **Compare-and-set, or nothing.** A write that carries no `If-Match` is a person
 *   saying "whatever is there, replace it". A write that carries one and is wrong gets
 *   a `409` with the sha we hold, because the app's whole conflict handling rests on
 *   being able to re-read that number and merge against it. A `409` without the number
 *   sends it back to square one with nothing to merge.
 * - **The body stays the body.** Write metadata (`message`, `device`) comes in as query
 *   parameters. Not a header, because a header field value may not carry the em dashes
 *   and the `≥` these messages contain; not inside the body, because the body has to
 *   remain the shop document or the workbook itself — wrapping a multi-megabyte
 *   workbook in a JSON envelope to carry a sentence is how you end up holding two
 *   copies of it on a box with 512 MB.
 * - **Too big is refused, not truncated.** 8 MB for the document, 32 MB for a workbook.
 * - **An unknown device is a sentence, not a code.** Whoever is holding the phone at
 *   7am reads this on screen. `401 UNKNOWN_DEVICE` tells them nothing; "enter the setup
 *   code printed on the shop box, or ask a machine that is already connected" is the
 *   whole fix.
 *
 * Logging is not here. One line per request is `index.ts`'s job, so a route cannot
 * accidentally log twice, or not at all, on a path it hands to the static server.
 */

import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import {
  isExportKind,
  isKnownKey,
  MAX_EXPORT_BYTES,
  MAX_STATE_BYTES,
  STATE_KEY,
  type FileStore,
} from './store.js';

/** What the router needs to do its job. Built once, in `index.ts`. */
export interface ApiContext {
  store: FileStore;
  /** Reported by `/api/health`, and by Settings, so a person knows which build they are on. */
  version: string;
  /** `FREO_OPEN=1`: answer everything without asking who is calling. */
  open: boolean;
}

/**
 * What a route did, so the request line can say so.
 *
 * `handled: false` means "not an API path at all" — the caller serves the app instead.
 */
export interface ApiResult {
  handled: boolean;
  status: number;
  note?: { sha?: string; bytes?: number; device?: string };
}

/** The headers this API answers cross-origin with, on every response. */
const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-Match, If-None-Match',
  // The preflight is the one request a shop's phone should not have to repeat, and the
  // headers we ask for never change.
  'Access-Control-Max-Age': '86400',
};

const WORKBOOK_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const TOKEN_PATTERN = /^[0-9a-f]{40}$/;

/** Query values are typed by a person or a script, so they get a ceiling before the log does. */
const MAX_MESSAGE_CHARS = 400;
const MAX_DEVICE_CHARS = 60;

/** A body that is not JSON is data, not an exception. So it comes back as a result. */
type Parsed = { ok: true; value: unknown } | { ok: false };

export function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

/**
 * Answer one `/api` request.
 *
 * Never throws for a reason a client caused. A route that throws becomes a 500 in
 * `index.ts`, and a 500 in front of a shop floor means nobody knows whether their
 * numbers went in.
 */
export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  search: URLSearchParams,
  ctx: ApiContext,
): Promise<ApiResult> {
  const method = req.method ?? 'GET';

  if (method === 'OPTIONS') {
    // Browsers pre-flight every call here: `Authorization` and `If-Match` are not in
    // the set of headers a cross-origin request may send without asking first.
    writeHead(res, 204, { ...CORS });
    res.end();
    return { handled: true, status: 204 };
  }

  const segments = pathname.split('/').filter((part) => part !== '');
  const second = segments[1] ?? '';

  if (second === 'health' && segments.length === 2) return healthRoute(res, method, ctx);
  // The device endpoint is reachable without a device key — that is the whole point of
  // it — so it sits above the check that guards everything else.
  if (second === 'device' && segments[2] === 'token' && segments.length === 3) {
    return deviceTokenRoute(req, res, method, ctx);
  }

  const refused = await authorise(req, res, ctx);
  if (refused !== null) return refused;

  if (second === 'state' && segments.length === 2) return stateRoute(req, res, method, search, ctx);
  if (second === 'exports' && segments.length === 3) return exportRoute(req, res, method, search, segments[2] ?? '', ctx);
  if (second === 'history' && segments.length === 2) return historyRoute(res, method, search, ctx);

  return fail(
    res,
    404,
    'no_route',
    `there is no ${method} ${pathname} on this server — it answers /api/health, /api/state, /api/exports/:kind, /api/history and /api/device/token`,
  );
}

// ── the routes ────────────────────────────────────────────────────────────────

/**
 * The one line the app looks for before it decides what holds its data.
 *
 * Unauthenticated on purpose: "is there a shop server here?" is answered by the shape
 * of the reply, not by who asks, and the app has to be able to ask before it has any
 * credentials. `store: "server"` is the part that matters — a captive portal or a
 * proxy that answers 200 with somebody else's HTML must not be mistaken for this
 * server, because the wrong answer sends a shop's data somewhere it was never sent.
 */
function healthRoute(res: ServerResponse, method: string, ctx: ApiContext): ApiResult {
  if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res, 'GET,HEAD,OPTIONS');
  return json(res, 200, { ok: true, store: 'server', version: ctx.version });
}

async function stateRoute(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  search: URLSearchParams,
  ctx: ApiContext,
): Promise<ApiResult> {
  if (method === 'GET' || method === 'HEAD') {
    const file = await ctx.store.read(STATE_KEY);
    if (file === null) {
      return fail(
        res,
        404,
        'no_document',
        'this server has not been given a shop document yet, so there is nothing to read — saving from any device will create one',
      );
    }
    const parsed = parseJson(file.bytes);
    if (!parsed.ok) {
      return fail(
        res,
        500,
        'unreadable_document',
        'the shop document on this server is not readable as JSON, so it cannot be sent — data/state.json is a plain text file, look at it before anything writes over it',
      );
    }
    const body = Buffer.from(
      JSON.stringify({
        sha: file.sha,
        bytes: file.bytes.byteLength,
        updatedAt: new Date(file.mtimeMs).toISOString(),
        content: parsed.value,
      }),
      'utf8',
    );
    writeHead(res, 200, {
      ...CORS,
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(body.byteLength),
      'Cache-Control': 'no-cache',
      ETag: `"${file.sha}"`,
    });
    res.end(method === 'HEAD' ? undefined : body);
    return { handled: true, status: 200, note: { sha: file.sha, bytes: body.byteLength } };
  }

  if (method !== 'PUT') return methodNotAllowed(res, 'GET,PUT,OPTIONS');

  const body = await readBody(req, res, MAX_STATE_BYTES, 'the shop document');
  if (!body.ok) return body.result;

  // Refused before a byte is written, which is the whole reason a 400 costs the shop
  // nothing: the document already on disk is untouched and still readable. A server
  // that stored what it was handed turns one bad device into every device reading an
  // empty shop tomorrow morning.
  const parsed = parseJson(body.bytes);
  if (!parsed.ok) {
    return fail(
      res,
      400,
      'invalid_json',
      'the shop document sent is not valid JSON, so it was not saved — nothing on the server has changed',
    );
  }

  const info = meta(search);
  const outcome = await ctx.store.write(STATE_KEY, body.bytes, conditions(req.headers), info);
  if (!outcome.ok) {
    return conflict(res, outcome.sha, 'the shop document changed on this server while this device was working on it, so this copy was not saved');
  }

  writeHead(res, 200, {
    ...CORS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
    ETag: `"${outcome.sha}"`,
  });
  res.end(JSON.stringify({ sha: outcome.sha, created: outcome.created }));
  return { handled: true, status: 200, note: { sha: outcome.sha, bytes: body.bytes.byteLength, device: info.device } };
}

async function exportRoute(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  search: URLSearchParams,
  kind: string,
  ctx: ApiContext,
): Promise<ApiResult> {
  // The whitelist is the only thing between `/api/exports/../../etc/passwd` and a
  // file, so it is checked before anything touches the store and nothing downstream
  // ever has to trust this string again.
  if (!isExportKind(kind)) {
    return fail(
      res,
      400,
      'unknown_kind',
      `this server keeps two workbooks, the stock file (location) and the jobs file (future), and "${kind}" is neither of them`,
    );
  }
  const key = ctx.store.keyForExport(kind);

  if (method === 'GET' || method === 'HEAD') {
    const file = await ctx.store.read(key);
    if (file === null) {
      return fail(
        res,
        404,
        'no_file',
        `no ${kind} workbook has been sent to this server yet — the computer that runs the MYOB export has to publish it first`,
      );
    }
    const etag = `"${file.sha}"`;
    const lastModified = new Date(file.mtimeMs).toUTCString();
    if (notModified(req.headers['if-none-match'], file.sha)) {
      // The whole point of the endpoint: the app re-checks a two-megabyte workbook
      // every few minutes, and this answers that in a few hundred bytes.
      writeHead(res, 304, { ...CORS, ETag: etag, 'Cache-Control': 'no-cache', 'Last-Modified': lastModified });
      res.end();
      return { handled: true, status: 304, note: { sha: file.sha } };
    }
    writeHead(res, 200, {
      ...CORS,
      'Content-Type': WORKBOOK_TYPE,
      'Content-Length': String(file.bytes.byteLength),
      ETag: etag,
      'Last-Modified': lastModified,
      // `no-cache`, not `no-store`: the browser may keep the copy and ask whether it is
      // still current, which is the cheap answer, but may not serve it blind, which is
      // the answer that shows somebody last week's stock.
      'Cache-Control': 'no-cache',
    });
    res.end(method === 'HEAD' ? undefined : Buffer.from(file.bytes));
    return { handled: true, status: 200, note: { sha: file.sha, bytes: file.bytes.byteLength } };
  }

  if (method !== 'PUT') return methodNotAllowed(res, 'GET,PUT,OPTIONS');

  const body = await readBody(req, res, MAX_EXPORT_BYTES, 'the workbook');
  if (!body.ok) return body.result;

  const info = meta(search);
  const outcome = await ctx.store.write(key, body.bytes, conditions(req.headers), info);
  if (!outcome.ok) {
    return conflict(
      res,
      outcome.sha,
      `the ${kind} workbook was replaced on this server while this copy was being sent, so this one was not saved`,
    );
  }

  writeHead(res, 200, {
    ...CORS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
    ETag: `"${outcome.sha}"`,
  });
  res.end(JSON.stringify({ sha: outcome.sha, created: outcome.created }));
  return { handled: true, status: 200, note: { sha: outcome.sha, bytes: body.bytes.byteLength, device: info.device } };
}

async function historyRoute(
  res: ServerResponse,
  method: string,
  search: URLSearchParams,
  ctx: ApiContext,
): Promise<ApiResult> {
  if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res, 'GET,OPTIONS');

  const path = (search.get('path') ?? '').trim();
  const known = 'it keeps state/state.json, exports/location.xlsx and exports/future.xlsx';
  if (path === '') return fail(res, 400, 'no_path', `say which file you want the history of with ?path= — ${known}`);
  if (!isKnownKey(path)) return fail(res, 404, 'unknown_path', `this server has no history for "${path}" — ${known}`);

  const limit = clamp(Number(search.get('limit') ?? 50), 1, 500);
  const entries = await ctx.store.history(path, limit);

  // The newest line has to be the file as it is now, not merely the last write the log
  // recorded. The app asks this question instead of downloading the workbook
  // (`getEntrySha` in `src/data/serverStore.ts`), so if a workbook ever arrives by
  // another route — a restore, a hand copy during a move — the log would report an
  // older number, a folder watch would call the folder and the server different, and
  // nothing would publish again. One extra entry, honestly labelled, keeps the
  // comparison honest.
  const current = await ctx.store.currentSha(path);
  if (current !== null && entries[0]?.sha !== current) {
    entries.unshift({
      at: new Date().toISOString(),
      path,
      sha: current,
      device: 'server',
      message: 'the file as it is on disk, not written through this API — restored, or copied in by hand',
    });
  }

  return json(res, 200, { path, limit, entries });
}

/**
 * Give a device a token.
 *
 * Two doors, deliberately one endpoint: the first device spends the one-time code
 * printed on the box's console, and every device after that is introduced by a device
 * that already holds a key. That is the rule the repository's token always was — one
 * secret, held by whoever set it up, shared on purpose — only said out loud instead of
 * being a personal access token copied out of somebody's GitHub account.
 */
async function deviceTokenRoute(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  ctx: ApiContext,
): Promise<ApiResult> {
  if (method !== 'POST') return methodNotAllowed(res, 'POST,OPTIONS');

  const body = await readBody(req, res, 8 * 1024, 'that request');
  if (!body.ok) return body.result;

  const parsed = parseJson(body.bytes);
  const payload = parsed.ok && typeof parsed.value === 'object' && parsed.value !== null ? (parsed.value as Record<string, unknown>) : {};
  const name = String(payload.name ?? '').slice(0, MAX_DEVICE_CHARS);
  const code = String(payload.code ?? '');

  // Open mode mints on request: a box that has said it checks nobody should not
  // pretend to check somebody in one corner.
  if (ctx.open) {
    const minted = await ctx.store.mintDevice(name, 'device');
    return json(res, 201, { token: minted.token, deviceId: minted.device.id, name: minted.device.name, role: minted.device.role });
  }

  const holder = bearerToken(req.headers);
  if (holder !== null) {
    const introducer = await ctx.store.deviceForToken(holder);
    if (introducer === null) {
      return fail(
        res,
        401,
        'unknown_device',
        'the key this device sent is not one this server recognises, so it cannot introduce another device — enter the setup code printed on the shop box on this device instead',
      );
    }
    const minted = await ctx.store.mintDevice(name, 'device');
    return json(res, 201, {
      token: minted.token,
      deviceId: minted.device.id,
      name: minted.device.name,
      role: minted.device.role,
      introducedBy: introducer.name,
    });
  }

  if (code.trim() === '') {
    return fail(
      res,
      401,
      'no_credentials',
      'this device has not been given a key yet — open Settings on it and enter the setup code printed on the shop box when it first started',
    );
  }

  const minted = await ctx.store.redeemSetupCode(code, name);
  if (minted === null) {
    return fail(
      res,
      401,
      'bad_setup_code',
      'that setup code is not the one this server is offering — the code works once only, and after that a device already connected has to introduce this one. Restart the server to print a new code if this box has never been set up.',
    );
  }
  return json(res, 200, { token: minted.token, deviceId: minted.device.id, name: minted.device.name, role: minted.device.role });
}

// ── authentication ────────────────────────────────────────────────────────────

/**
 * Check the device, and answer 401 if it fails.
 *
 * A non-null return means "this request is finished, here is what to log", which keeps
 * every route from having to remember the check and from doing it slightly differently.
 * The lookup is by sha256, so a token never reaches the disk: `devices.json` holds
 * hashes only, and a stolen backup is not a set of working keys.
 */
async function authorise(req: IncomingMessage, res: ServerResponse, ctx: ApiContext): Promise<ApiResult | null> {
  if (ctx.open) return null;
  const token = bearerToken(req.headers);
  if (token === null) {
    return fail(
      res,
      401,
      'no_token',
      'this request came without a device key — open the app on this device and enter the setup code from the shop box, which gives it one',
    );
  }
  if (!TOKEN_PATTERN.test(token)) {
    return fail(
      res,
      401,
      'bad_token',
      'that is not a key this server could have issued — a key is 40 characters, so what is in that field was typed by hand or copied from somewhere else',
    );
  }
  const device = await ctx.store.deviceForToken(token);
  if (device === null) {
    return fail(
      res,
      401,
      'unknown_device',
      'this device has a key but this server does not recognise it — if the server was rebuilt or its data folder replaced, every device has to enter the setup code from the box again',
    );
  }
  return null;
}

function bearerToken(headers: IncomingHttpHeaders): string | null {
  const raw = headers.authorization;
  if (typeof raw !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  const value = match?.[1]?.trim();
  // Lower-cased because we only ever compare against a hex digest: a device that
  // pastes its key with different casing is the same device.
  return value === undefined || value === '' ? null : value.toLowerCase();
}

// ── conditional requests ──────────────────────────────────────────────────────

/**
 * The caller's preconditions, as the store wants them.
 *
 * Quotes are optional on the way in: the app quotes the sha (as HTTP wants) and a
 * person testing with `curl` usually does not, and refusing one of the two over
 * punctuation is a wasted afternoon with no winner. `W/` is stripped because a proxy
 * between the shop floor and the box may have added it. `If-Match` wins if both are
 * sent, since it is the specific instruction.
 */
function conditions(headers: IncomingHttpHeaders): { ifMatch?: string; ifNoneMatch?: boolean } {
  const ifMatch = unquoteFirst(headers['if-match']);
  const out: { ifMatch?: string; ifNoneMatch?: boolean } = {};
  if (ifMatch !== undefined) out.ifMatch = ifMatch;
  else if (typeof headers['if-none-match'] === 'string' && headers['if-none-match'].trim() === '*') out.ifNoneMatch = true;
  return out;
}

function unquoteFirst(raw: string | string[] | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  if (value === '' || value === '*') return undefined;
  const first = (value.split(',')[0] ?? '').trim();
  const strong = first.startsWith('W/') ? first.slice(2) : first;
  const bare = strong.replace(/^"|"$/g, '').trim();
  return bare === '' ? undefined : bare;
}

/** Is the version the caller holds the one we are about to send? */
function notModified(ifNoneMatch: string | string[] | undefined, sha: string): boolean {
  if (typeof ifNoneMatch !== 'string') return false;
  const value = ifNoneMatch.trim();
  if (value === '*') return true;
  return value
    .split(',')
    .map((part) => unquoteFirst(part))
    .filter((part): part is string => part !== undefined)
    .includes(sha);
}

// ── bodies ────────────────────────────────────────────────────────────────────

type Body = { ok: true; bytes: Buffer } | { ok: false; result: ApiResult };

/**
 * Read a request body, refusing one that is too big.
 *
 * The bytes over the limit are drained and thrown away rather than cut off: answer 413
 * and hang up while a client is still uploading, and the client reports a broken
 * connection, so the shop sees "could not reach the server" when the true answer is
 * "that file is too big". Draining costs a little bandwidth and tells the truth.
 * Memory is bounded either way — only the first `maxBytes` are kept.
 */
function readBody(req: IncomingMessage, res: ServerResponse, maxBytes: number, what: string): Promise<Body> {
  return new Promise<Body>((resolve) => {
    const limit = Math.max(maxBytes, 8 * 1024);
    const chunks: Buffer[] = [];
    let length = 0;
    let oversize = false;

    req.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > limit) {
        oversize = true;
        return;
      }
      chunks.push(chunk);
    });
    // A body that stops arriving is the client's decision, not a server fault. 400
    // rather than 499 because the request was already wrong to send.
    req.on('error', () => resolve({ ok: false, result: { handled: true, status: 400 } }));
    req.on('end', () => {
      if (oversize) {
        resolve({
          ok: false,
          result: fail(
            res,
            413,
            'too_large',
            `${what} is ${formatSize(length)}, and this server accepts ${formatSize(limit)} at most — what arrived is not the file this shop writes`,
          ),
        });
        return;
      }
      resolve({ ok: true, bytes: Buffer.concat(chunks) });
    });
  });
}

/** Query parameters, because a header cannot carry an em dash and a body must stay a body. */
function meta(search: URLSearchParams): { device: string; message: string } {
  // Unknown parameters are ignored rather than refused: a later build of the app will
  // send things this server has never heard of, and a strict check there forces the app
  // and the box to be upgraded in step — the coupling this whole design avoids.
  return {
    device: (search.get('device') ?? '').trim().slice(0, MAX_DEVICE_CHARS),
    message: (search.get('message') ?? '').trim().slice(0, MAX_MESSAGE_CHARS),
  };
}

// ── responses ─────────────────────────────────────────────────────────────────

function writeHead(res: ServerResponse, status: number, headers: Record<string, string>): void {
  if (res.headersSent) return;
  res.writeHead(status, headers);
}

function json(res: ServerResponse, status: number, body: unknown): ApiResult {
  const text = Buffer.from(JSON.stringify(body), 'utf8');
  writeHead(res, status, {
    ...CORS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(text.byteLength),
    'Cache-Control': 'no-cache',
  });
  res.end(text);
  return { handled: true, status };
}

/** The shape `ServerStore.raiseIfBad` reads: `error.code` to branch on, `error.message` to show. */
function fail(res: ServerResponse, status: number, code: string, message: string): ApiResult {
  return json(res, status, { error: { code, message } });
}

/**
 * The 409, with the sha.
 *
 * The number sits at the top level because it is the only field the app is guaranteed
 * to read: `ServerStore` pulls `"sha"` out of the body and hands it to the merge. A
 * conflict without it is a retry the app cannot make.
 */
function conflict(res: ServerResponse, sha: string | null, message: string): ApiResult {
  return json(res, 409, { error: { code: 'conflict', message }, sha });
}

function methodNotAllowed(res: ServerResponse, allow: string): ApiResult {
  const text = Buffer.from(
    JSON.stringify({ error: { code: 'wrong_method', message: `this address does not accept that method — it accepts ${allow}` } }),
    'utf8',
  );
  writeHead(res, 405, {
    ...CORS,
    Allow: allow,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(text.byteLength),
    'Cache-Control': 'no-cache',
  });
  res.end(text);
  return { handled: true, status: 405 };
}

// ── small things ──────────────────────────────────────────────────────────────

function parseJson(bytes: Uint8Array): Parsed {
  if (bytes.byteLength === 0) return { ok: false };
  try {
    // Decoded rather than `bytes.toString()`: the store hands back a `Uint8Array` and a
    // Buffer is a `Uint8Array` with extra methods, not the other way round.
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) as unknown };
  } catch {
    return { ok: false };
  }
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return high;
  return Math.min(high, Math.max(low, Math.round(value)));
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} bytes`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
