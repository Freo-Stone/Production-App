/**
 * The built app, from disk.
 *
 * One port serves the API and the files, so this half has to be boring and correct in
 * equal measure. Four things are worth explaining:
 *
 * - **A missing `dist/` is not an emergency.** `/api` is answered before this file is
 *   consulted, so a box that has the data and not yet the front end still syncs. It
 *   answers 404 for pages rather than failing to start — the install order is "data
 *   first, files when they arrive", and a server that refuses to boot without a build
 *   is a server that cannot be set up in the right order.
 * - **Traversal is impossible by construction, not by pattern-matching.** The path is
 *   resolved against the root and then checked to still be inside it. Hunting for `..`
 *   in the string is the usual way to get this wrong: `%2e%2e`, doubled slashes and a
 *   symlink left in the folder all get past it. And it answers `404`, not `500` — a
 *   scanner poking at the box should not fill a journal with stack traces that read
 *   like a breach.
 * - **`/assets/` is immutable, everything else is revalidated.** The build puts a
 *   content hash in those file names, so a year in the browser cache is safe there and
 *   wrong everywhere else. `index.html` and `sw.js` are the two files whose whole job
 *   is to change, so they are never served from cache without asking.
 * - **gzip is applied to text and never to what is already compressed.** A PNG, a
 *   WOFF2 and an XLSX are deflate streams already; compressing one again costs CPU,
 *   saves nothing, and on phone wifi can cost more than it returns.
 */

import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';

const gzipAsync = promisify(gzip);

/** Above this, compressing on the fly is not worth the CPU on a small box. */
const MAX_GZIP_BYTES = 2 * 1024 * 1024;

/** Below this, the header is bigger than the saving. */
const MIN_GZIP_BYTES = 860;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  // Only reachable if someone points the static root at a folder holding a workbook,
  // which nothing in this repo does. It is here because a wrong Content-Type is how a
  // download becomes a wall of mojibake.
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** Text a browser is glad to receive compressed. Everything absent is served as is. */
const GZIP_TYPES = new Set([
  'text/html; charset=utf-8',
  'text/javascript; charset=utf-8',
  'text/css; charset=utf-8',
  'application/json; charset=utf-8',
  'application/manifest+json; charset=utf-8',
  'image/svg+xml',
  'text/plain; charset=utf-8',
]);

export interface StaticResult {
  status: number;
  note?: { bytes?: number };
}

/** A file we are able to serve, with the one stat fact we need about it. */
interface Asset {
  path: string;
  bytes: Buffer;
  mtimeMs: number;
}

/**
 * Serve one request out of the built app.
 *
 * `staticDir` may not exist. Every route through here treats "not there" as "not this
 * file" and falls through, which ends in a 404 — never a stack trace.
 */
export async function serveStatic(
  staticDir: string,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<StaticResult> {
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    return { status: respond(res, 405, { Allow: 'GET,HEAD' }, 'GET or HEAD only — this is the app’s own files\n') };
  }

  const wanted = inside(staticDir, pathname);
  if (wanted === null) {
    // A 404 like any other missing path. The answer must not tell an explorer whether
    // the reason was punctuation or a file that exists.
    return { status: respond(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'nothing here\n') };
  }

  const direct = await readIfFile(wanted);
  if (direct !== null) return send(req, res, direct, cachePolicyFor(pathname));

  // A directory, or nothing: the single-page app answers both with its own shell, and
  // its router works out what the path meant. `/assets/…` is the one case that has to
  // stay a 404 — handing index.html to a browser that asked for JavaScript fails as a
  // blank screen with no clue as to why.
  if (pathname.startsWith('/assets/')) {
    return { status: respond(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'nothing here\n') };
  }

  const shell = await readIfFile(join(resolve(staticDir), 'index.html'));
  if (shell === null) {
    // The sentence a person sees when they installed the box but not the front end.
    // Saying "the API still answers" is the useful part: it says the server is up.
    return {
      status: respond(
        res,
        404,
        { 'Content-Type': 'text/plain; charset=utf-8' },
        'there is no app here yet — the API on this port still answers, so the server is running and only the front end is missing\n',
      ),
    };
  }
  return send(req, res, shell, { 'Cache-Control': 'no-cache' });
}

/**
 * Resolve a URL path to a real location inside the root, or null.
 *
 * `resolve` collapses `..` before the filesystem is ever consulted, and the prefix test
 * after it is what makes the answer safe. The root itself is compared too, so a request
 * for `/` cannot be treated as a request for its parent.
 */
function inside(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // A stray `%` is a malformed request, not an attack, and certainly not a crash.
    return null;
  }
  // A NUL byte is a throw inside `fs`, which would make this a 500.
  if (decoded.includes('\0')) return null;

  const rootPath = resolve(root);
  const target = resolve(rootPath, `.${decoded.startsWith('/') ? decoded : `/${decoded}`}`);
  if (target === rootPath) return rootPath;
  return target.startsWith(rootPath + sep) ? target : null;
}

/**
 * Read it only if it is a regular file.
 *
 * `lstat`, not `stat`, and that is the whole symlink defence: `lstat` does not follow
 * links, so a link inside `dist/` pointing at `/etc/passwd` is not a file as far as
 * this function is concerned and never gets opened.
 */
async function readIfFile(path: string): Promise<Asset | null> {
  const info = await lstat(path).catch(() => null);
  if (info === null || !info.isFile()) return null;
  const bytes = await readFile(path).catch(() => null);
  if (bytes === null) return null;
  return { path, bytes, mtimeMs: info.mtimeMs };
}

function cachePolicyFor(pathname: string): Record<string, string> {
  if (pathname.startsWith('/assets/')) {
    // Hashed file name, so these bytes can never change under this name. The app is an
    // offline-first PWA: not re-downloading a megabyte of unchanged JavaScript on every
    // visit is part of the design, not an optimisation of it.
    return { 'Cache-Control': 'public, max-age=31536000, immutable' };
  }
  // `index.html` and `sw.js` are the files that decide whether anyone sees this build,
  // so they are re-asked every time. Everything else at the root (icons, the manifest)
  // is small enough that being wrong about it is cheaper than being clever.
  return { 'Cache-Control': 'no-cache' };
}

async function send(
  req: IncomingMessage,
  res: ServerResponse,
  asset: Asset,
  cache: Record<string, string>,
): Promise<StaticResult> {
  const type = TYPES[extname(asset.path).toLowerCase()] ?? 'application/octet-stream';
  const etag = etagOf(asset);
  const held = String(req.headers['if-none-match'] ?? '');
  // Only gzip for a client that asked in a language we speak. `br` and `zstd` are
  // better and are the job of the reverse proxy, if the shop ever puts one in front;
  // pretending otherwise by sending gzip to a `br`-only client would be a broken body.
  const acceptsGzip = /(^|[,;\s])gzip([;,\s]|$)/.test(String(req.headers['accept-encoding'] ?? ''));

  const headers: Record<string, string> = {
    'Content-Type': type,
    ETag: etag,
    'Last-Modified': new Date(asset.mtimeMs).toUTCString(),
    ...cache,
  };

  if (held === etag || held.replace(/^W\//, '') === etag.replace(/^W\//, '')) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': headers['Cache-Control'] ?? 'no-cache' });
    res.end();
    return { status: 304 };
  }

  const compressible =
    acceptsGzip && GZIP_TYPES.has(type) && asset.bytes.byteLength > MIN_GZIP_BYTES && asset.bytes.byteLength <= MAX_GZIP_BYTES;
  if (compressible) {
    const packed = await gzipAsync(asset.bytes, { level: 6 });
    // Only if it actually saved something: a gzip of an already-tight file is bigger
    // than the file, and sending it anyway is a slowdown nobody can see.
    if (packed.byteLength < asset.bytes.byteLength) {
      res.writeHead(200, {
        ...headers,
        'Content-Length': String(packed.byteLength),
        'Content-Encoding': 'gzip',
        // Without `Vary`, a proxy that cannot gzip would hand these bytes to a reader
        // that asked for nothing compressed, and it would see nothing.
        Vary: 'Accept-Encoding',
      });
      res.end(packed);
      return { status: 200, note: { bytes: packed.byteLength } };
    }
  }

  res.writeHead(200, { ...headers, 'Content-Length': String(asset.bytes.byteLength) });
  res.end(asset.bytes);
  return { status: 200, note: { bytes: asset.bytes.byteLength } };
}

/**
 * A weak tag from the size and the modification time.
 *
 * Not the content hash: computing one per request is more work than serving the file,
 * and a tag that is stale for a few seconds only costs a re-download after a deploy,
 * which is what `no-cache` on `index.html` is there to catch.
 */
function etagOf(asset: Asset): string {
  const seed = `${asset.path}:${String(asset.bytes.byteLength)}:${String(Math.round(asset.mtimeMs))}`;
  return `W/"${createHash('sha1').update(seed).digest('hex').slice(0, 27)}"`;
}

function respond(res: ServerResponse, status: number, headers: Record<string, string>, text: string): number {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, { ...headers, 'Content-Length': String(body.byteLength) });
  res.end(body);
  return status;
}
