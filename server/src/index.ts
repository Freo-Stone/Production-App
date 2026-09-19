/**
 * The one process: read the environment, open the port, answer requests, stop cleanly.
 *
 * Everything above this file is a function that takes its inputs. This file is where
 * the program actually begins, which means it is where three things have to be got
 * right and cannot be tested from the library:
 *
 * - **The first-run line.** Whoever starts this box is standing in a shop, over SSH,
 *   with a phone in their hand. What they need to see is the setup code and what to do
 *   with it, in words, without scrolling. What they must never see is a device token:
 *   a token on a console is a token in a shell history file and a token in a screenshot
 *   somebody sends to support.
 * - **Exactly one log line per request.** One too many is a write trail that lies —
 *   two lines look like two writes to whoever is working out why the shop has two of
 *   something. So the line is emitted from one place, in a `finish` that can only fire
 *   once, whatever path the request took through the routes.
 * - **A stop that does not cut anyone off.** The floor hits save at 4:55pm. `SIGTERM`
 *   stops new connections, lets in-flight requests finish, and gives up after five
 *   seconds rather than waiting forever on a phone that wandered off the wifi.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { configFromEnv, stripBase } from './config.js';
import type { ServerConfig } from './config.js';
import { requestLine, safeToken, stdoutLog, stdoutPrint } from './log.js';
import type { LogFn, PrintFn, WriteNote } from './log.js';
import { handleApi, isApiPath } from './api.js';
import type { ApiContext } from './api.js';
import { serveStatic } from './static.js';
import { FileStore } from './store.js';

/** How long a drain waits for a request that will not finish. */
const DRAIN_MS = 5_000;

export interface StartOptions {
  /** Normally `configFromEnv()`. Given, it wins over the environment. */
  config?: ServerConfig;
  dataDir?: string;
  staticDir?: string;
  /** 0 for "any free port", which is how the tests avoid colliding. */
  port?: number;
  host?: string;
  open?: boolean;
  version?: string;
  log?: LogFn;
  print?: PrintFn;
}

export interface RunningServer {
  /** The port actually bound — with `port: 0` this is the only way to know. */
  readonly port: number;
  readonly host: string;
  readonly url: string;
  readonly dataDir: string;
  readonly version: string;
  /** The one-time code this start printed, or `null` if the box has been set up before. */
  readonly setupCode: string | null;
  close(): Promise<void>;
}

/**
 * Start the server and wait for the port.
 *
 * Returns the real bound port so a caller on port 0 can find out where it landed, and
 * hands back a `close()` rather than assuming the process is about to exit — the tests
 * run a dozen servers in one process, and a suite that leaks a hundred sockets stops
 * being a suite.
 */
export async function startServer(options: StartOptions = {}): Promise<RunningServer> {
  const fromEnv = options.config ?? configFromEnv();
  const config: ServerConfig = {
    ...fromEnv,
    port: options.port ?? fromEnv.port,
    host: options.host ?? fromEnv.host,
    dataDir: options.dataDir ?? fromEnv.dataDir,
    staticDir: options.staticDir ?? fromEnv.staticDir,
    open: options.open ?? fromEnv.open,
  };
  const log = options.log ?? stdoutLog;
  const print = options.print ?? stdoutPrint;
  const version = options.version ?? resolveVersion();

  const store = new FileStore(config.dataDir);
  // Make the folder now. A data directory that cannot be written — wrong mount, wrong
  // owner after an install — should say so at startup, in the journal, next to the
  // startup line. Finding it out on the shop's first save is finding it out at 7am.
  await store.ensure();

  const ctx: ApiContext = { store, version, open: config.open };
  const server = createServer((req, res) => void handle(req, res, ctx, config, log));

  await listen(server, config.port, config.host);
  const port = boundPort(server);
  const setupCode = await announce(store, config, port, print, version);

  return {
    port,
    host: config.host,
    url: `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${String(port)}/`,
    dataDir: config.dataDir,
    version,
    setupCode,
    close: () => close(server),
  };
}

/**
 * One line per request. This is the only place a request line is written.
 *
 * The `finish` closure is guarded because there are four ways out of a request — a
 * route answered, a route threw, the client vanished, and the response stream broke —
 * and each of them has to produce exactly one line and no more.
 */
async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiContext,
  config: ServerConfig,
  log: LogFn,
): Promise<void> {
  const startedAt = process.hrtime.bigint();
  const method = req.method ?? 'GET';
  let path = '/';
  let logged = false;

  const finish = (status: number, note?: WriteNote): void => {
    if (logged) return;
    logged = true;
    log(requestLine({ method, path, status, startedAt, note }));
  };

  // The client hanging up is not a server fault, and calling it a 500 would put a
  // fault where there is only a phone that went to sleep mid-download. 499 is what
  // nginx has used for it long enough that everyone recognises it.
  req.on('aborted', () => finish(499));
  req.on('error', () => finish(499));
  // A response stream that breaks mid-write — the usual way a phone walks out of range
  // during a workbook download. Without a listener an 'error' event is thrown, and
  // that is how a client's bad day becomes our crash.
  res.on('error', () => finish(499));

  try {
    // Anchored onto the string rather than resolved as a relative URL: `new URL('//api/health',
    // 'http://localhost')` reads a leading `//` as the start of a *different origin* and puts
    // `api` in the host, so the doubled slash vanishes before anything can see it. This is a
    // path, whatever the client thinks; anchor it and the whole thing stays in the pathname.
    const target = req.url ?? '/';
    const url = new URL(target.startsWith('http://') || target.startsWith('https://') ? target : `http://localhost${target}`);
    // A doubled slash is not a second, nameless directory. `http://box:8787//api/health`
    // is what arrives when somebody types a trailing slash into an address field, or
    // when a proxy joins a prefix onto a path that already ended in one. Untreated, the
    // router sees an empty first segment, decides it is not the API, and the file
    // handler answers with "GET or HEAD only" — a true sentence about files and a
    // useless one about the API, which is how a trailing slash becomes an hour.
    path = url.pathname.replace(/\/{2,}/g, '/');
    const under = stripBase(path, config.base);
    if (under === null) {
      // Not served under this server's prefix. A 404 with the prefix in it is the
      // difference between "wrong address" and a mystery, and a wrong `FREO_BASE` is a
      // thing people type.
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`this server answers under ${config.base === '' ? '/' : config.base}\n`);
      finish(404);
      return;
    }

    if (isApiPath(under)) {
      const result = await handleApi(req, res, under, url.searchParams, ctx);
      finish(result.status, result.note);
      return;
    }

    const result = await serveStatic(config.staticDir, req, res, under);
    finish(result.status, result.note);
  } catch (error) {
    // Nothing below catches everything, and one bad request must not take the shop's
    // server down with it. The line says which path, because "an error happened" in a
    // journal is not a lead.
    const status = res.headersSent ? 499 : 500;
    if (!res.headersSent) {
      const body = Buffer.from(
        JSON.stringify({
          error: {
            code: 'server_error',
            message: 'this server hit an internal fault answering that request, so nothing was saved — try again, and if it keeps happening look at the server log',
          },
        }),
        'utf8',
      );
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(body.byteLength) });
      res.end(body);
    }
    finish(status);
    log(`${new Date().toISOString()} FAULT ${safeToken(path, 300)} ${safeToken(messageOf(error), 200)}`);
  }
}

// ── startup and stop ──────────────────────────────────────────────────────────

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error: Error): void => {
      rejectListen(new Error(`could not listen on ${host}:${String(port)} — ${(error as { message?: string }).message ?? String(error)}`));
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolveListen();
    });
  });
}

function boundPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server did not report the port it bound');
  return address.port;
}

/**
 * Stop accepting, then stop, then give up.
 *
 * `server.close()` waits for in-flight requests and closes idle keep-alive sockets on
 * its own, which is the polite half. The other half is a phone that started a
 * three-megabyte download and walked out of range: without the timer, systemd waits
 * its own timeout, decides the service is stuck, and SIGKILLs it mid-write. Five
 * seconds is long enough for a save on the office network and short enough that
 * nobody watching a restart thinks it has hung.
 */
function close(server: Server): Promise<void> {
  return new Promise((resolveClose) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveClose();
    };
    const timer = setTimeout(() => {
      server.closeAllConnections();
      // One more beat for the close callback, then carry on regardless: the caller
      // wants to know we are done, not a report on which socket would not die.
      setTimeout(done, 100).unref();
    }, DRAIN_MS);
    timer.unref();
    server.close(done);
  });
}

/**
 * The console lines at startup, in words.
 *
 * This is the whole onboarding for a shop server: a code, what to do with it, and the
 * two facts that stop an hour of confusion — where the data lives, and that this
 * server never sees anybody's passcode. Everything else would be scrolled past.
 */
async function announce(store: FileStore, config: ServerConfig, port: number, print: PrintFn, version: string): Promise<string | null> {
  print(`Freo shop server ${version} listening on http://${config.host}:${String(port)}${config.base}/`);
  print(`  data: ${config.dataDir}`);
  print(`  app:  ${config.staticDir}${(await hasIndex(config.staticDir)) ? '' : '  (nothing there yet — /api still answers, the front end is missing)'}`);

  if (config.open) {
    print('  FREO_OPEN=1: every /api route answers without a device key. On a private office network that is a defensible choice; anywhere else it means the shop document travels in the clear and unreadable.');
  }

  const devices = await store.devices();
  const held = await store.setupCode();
  if (devices.length > 0 && held === null) {
    print(`  ${String(devices.length)} device${devices.length === 1 ? '' : 's'} have keys. Nothing is printed here that a person needs to type.`);
    return null;
  }

  const code = devices.length === 0 ? await store.createSetupCode() : held;
  if (code === null) return null;
  print('');
  print('  Nothing has been given a key on this server yet. On the first device, open the app and enter this code when it asks:');
  print('');
  print(`      ${code}`);
  print('');
  print('  It works once, for one device only, and then it is gone. Every device after that is');
  print(`  introduced by one that is already connected. It is also in ${config.dataDir}/setup-code, a`);
  print('  plain text file readable only by this user. It is not a device key: the keys this');
  print('  server hands out are never printed, and only their fingerprints are kept.');
  print('');
  return code;
}

async function hasIndex(staticDir: string): Promise<boolean> {
  return readFile(resolve(staticDir, 'index.html')).then(
    () => true,
    () => false,
  );
}

/**
 * Which build is this.
 *
 * In that order: `FREO_VERSION` for a container image that bakes it in, the value the
 * bundler substituted for a shipped single file, and the repository's own
 * `package.json` when running from a checkout. Not a literal in a source file: a
 * version string nobody updates is worse than none, because Settings shows it to a
 * person who is trying to work out which box they are looking at.
 */
function resolveVersion(): string {
  const fromEnv = process.env.FREO_VERSION?.trim();
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  const builtIn = (globalThis as { __FREO_VERSION__?: unknown }).__FREO_VERSION__;
  if (typeof builtIn === 'string' && builtIn !== '') return builtIn;
  return readPackageVersion(dirname(thisModulePath()));
}

function readPackageVersion(start: string): string {
  let dir = resolve(start);
  for (let depth = 0; depth < 4; depth += 1) {
    try {
      const raw = readFileSync(resolve(dir, 'package.json'), 'utf8');
      const parsed = JSON.parse(raw) as { name?: string; version?: string };
      if (parsed.name === 'freo-stone-production' && typeof parsed.version === 'string') return parsed.version;
    } catch {
      // Keep walking up. A shipped single file has no package.json anywhere near it,
      // and that is normal, not an error.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return 'unknown';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

// ── running it ────────────────────────────────────────────────────────────────

/**
 * The crash guards.
 *
 * Installed for the command, not for `startServer`, so importing this module in a test
 * does not quietly swallow the test runner's own failures. A request that throws in a
 * callback outside the handler — a timer, an event emitted by a socket being torn down
 * — would otherwise end the process, and a shop does not notice the server is gone
 * until somebody's numbers do not appear. Logging it and staying up is the better
 * failure; the line says what happened, and the next request is answered.
 */
export function installCrashGuards(log: LogFn = stdoutLog): void {
  process.on('uncaughtException', (error) => {
    log(`FAULT uncaught ${safeToken(messageOf(error), 240)}`);
  });
  process.on('unhandledRejection', (reason) => {
    log(`FAULT rejection ${safeToken(messageOf(reason), 240)}`);
  });
}

/** Is this file the thing the process was started with? */
function isCommandLineEntry(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    // `fileURLToPath`, not `URL.pathname`: the pathname keeps the %20, and this repo's
    // own folder has a space in it, so the comparison would never match here.
    return realpathSync(resolve(entry)) === realpathSync(thisModulePath());
  } catch {
    return false;
  }
}

/** Where this module's own file is, percent-decoded. */
function thisModulePath(): string {
  return fileURLToPath(import.meta.url);
}

/** `node server/freo-server.mjs`, and nothing else: importing this module must not start a port. */
async function main(): Promise<void> {
  // Almost always the port already being taken by the old server, which is the one
  // install mistake that looks like a crash and is fixed by reading the line.
  const log = stdoutLog;
  const running = await startServer({}).catch((error: unknown) => {
    process.stderr.write(`${messageOf(error)}\n`);
    process.exitCode = 1;
    return null;
  });
  if (running === null) return;

  const stop = (signal: string): void => {
    log(`${new Date().toISOString()} STOP ${safeToken(signal, 20)}`);
    void running.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
    // If a socket will not die, do not sit here past the drain.
    setTimeout(() => process.exit(0), DRAIN_MS + 500).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

if (isCommandLineEntry()) {
  installCrashGuards();
  await main();
}
