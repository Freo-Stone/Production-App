/**
 * Every setting comes from the environment and nothing else.
 *
 * The box this runs on is set up by a person standing in front of it, usually over
 * SSH, with no build step in sight. So each knob has to be one line in a systemd
 * unit or one `-e` on `docker run`, and each one needs a default that is correct
 * for the common case — a first start with nothing set at all should give a working
 * shop server, not a usage message.
 *
 * There is deliberately no config file. A second file on the box is a second thing
 * to back up and a second thing that does not travel when someone tars `/opt/freo`
 * onto the machine at work, which is the whole point of this design.
 */

import { isAbsolute, resolve } from 'node:path';

export interface ServerConfig {
  /** 0 means "any free port", which is how the tests avoid colliding. */
  port: number;
  /** Bound to every interface by default: this is a LAN box, not a laptop service. */
  host: string;
  /** Where the shop lives: `state.json`, `exports/`, `history.ndjson`, `devices.json`. */
  dataDir: string;
  /** The built app. A missing directory is survivable — `/api` still answers. */
  staticDir: string;
  /** Ask for no token anywhere. Defensible on a private LAN, nowhere else. */
  open: boolean;
  /** Prefix the app is served under, already normalised: `""` or `/freo`. */
  base: string;
}

export const DEFAULT_PORT = 8787;
const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_DATA = './data';
const DEFAULT_STATIC = './dist';

/**
 * Read the environment.
 *
 * A typo in `FREO_PORT` must not quietly start the server on 8787 while the shop
 * waits for an answer on 9000, so a value that is present and unparseable throws
 * with the variable's name in the message. Absent is different from wrong: absent
 * takes the default.
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: readPort(env.FREO_PORT),
    host: readHost(env.FREO_HOST),
    dataDir: fromCwd(env.FREO_DATA, DEFAULT_DATA),
    staticDir: fromCwd(env.FREO_STATIC, DEFAULT_STATIC),
    open: readOpen(env.FREO_OPEN),
    base: normaliseBase(env.FREO_BASE ?? ''),
  };
}

function readPort(raw: string | undefined): number {
  const value = raw?.trim();
  if (value === undefined || value === '') return DEFAULT_PORT;
  if (!/^\d+$/.test(value) || Number(value) > 65_535) {
    throw new Error(`FREO_PORT "${raw}" is not a port number (expected 0-65535)`);
  }
  return Number(value);
}

/** Not in the documented set, but a box behind a reverse proxy needs to bind
 *  loopback only, and `FREO_HOST=127.0.0.1` is the least surprising way to say it. */
function readHost(raw: string | undefined): string {
  const value = raw?.trim();
  return value === undefined || value === '' ? DEFAULT_HOST : value;
}

function readOpen(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === '') return false;
  // `FREO_OPEN=0` has to mean off. Reading any non-empty string as true is how a
  // unit file that says `FREO_OPEN=0` ends up serving the shop to the street.
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off', ''].includes(value)) return false;
  throw new Error(`FREO_OPEN "${raw}" is not yes or no (use 1 for no token checks, 0 for token checks)`);
}

function fromCwd(raw: string | undefined, fallback: string): string {
  const value = (raw ?? '').trim() === '' ? fallback : (raw as string).trim();
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

/**
 * `/freo/`, `/freo` and `freo` all mean the same prefix; `/` and `` mean none.
 *
 * Normalising here means the router only ever compares against one form, so a
 * trailing slash in a systemd unit cannot turn into "the app is served, the API is
 * 404" — the sort of half-working install that eats an afternoon.
 */
export function normaliseBase(raw: string): string {
  let value = raw.trim();
  if (value === '' || value === '/') return '';
  if (!value.startsWith('/')) value = `/${value}`;
  while (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1);
  return value === '/' ? '' : value;
}

/** Strip the prefix a request was made under. Returns null when it is not under it. */
export function stripBase(pathname: string, base: string): string | null {
  if (base === '') return pathname;
  if (pathname === base) return '/';
  if (pathname.startsWith(`${base}/`)) return pathname.slice(base.length) || '/';
  return null;
}
