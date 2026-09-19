/**
 * The shop's data, as files in a folder.
 *
 * Everything in this file exists to keep two promises made in `docs/server.md`:
 *
 * - **A power cut cannot leave a half-written shop.** Every write goes to a temporary
 *   file in the same folder, is `fsync`ed, and is then renamed over the old one. A
 *   rename within a filesystem is atomic, so a reader sees either the whole old file
 *   or the whole new file — never the first half of the new one. The `fsync` before
 *   the rename is what makes that survive the machine losing power rather than just
 *   the process dying.
 * - **A missing file is not an error.** "Nothing has been written yet" is the normal
 *   state of a new shop, so reads answer `null` and the callers get to say what an
 *   empty shop means. Turning a first run into an exception is how a new install
 *   looks broken when it is fine.
 *
 * Nothing here knows anything about the shop. The document is bytes with a JSON gate
 * in front of it (`api.ts` does the gating), and the numbers inside it are hashed on
 * the device that typed them — this box is not meant to be able to read them.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** The two workbooks, in the words the app and the history log both use. */
export const EXPORT_KINDS = ['location', 'future'] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

export function isExportKind(value: string): value is ExportKind {
  return (EXPORT_KINDS as readonly string[]).includes(value);
}

/**
 * The three things that get a line in the history log.
 *
 * The keys are the paths the app already uses against the repository —
 * `state/state.json` and the two exports — because the app sends those strings and
 * the log has to read the same way whoever is looking at it. Where they land on disk
 * is this file's business, which is why `state/state.json` is `state.json` here and
 * not a folder holding one file.
 */
export const STATE_KEY = 'state/state.json';
export const LOCATION_KEY = 'exports/location.xlsx';
export const FUTURE_KEY = 'exports/future.xlsx';

export function isKnownKey(value: string): boolean {
  return value === STATE_KEY || value === LOCATION_KEY || value === FUTURE_KEY;
}

/** How big a body the store will accept for a key. Bigger is refused before it lands. */
export const MAX_STATE_BYTES = 8 * 1024 * 1024;
export const MAX_EXPORT_BYTES = 32 * 1024 * 1024;

/**
 * The number every compare-and-set in this shop is built on: the git blob sha.
 *
 * `sha1("blob <byte length>\0" + bytes)`, which is what `git hash-object` prints and
 * what GitHub's Contents API reports as a file's `sha`. The browser computes the same
 * value over the same bytes (`src/core/folderSource.ts`, pinned against real MYOB
 * exports in `test/core.folderSource.test.ts`) and the two are compared byte for
 * byte, so a device that used the repository this morning can use this server
 * afternoon without either side converting anything. A digest of our own would have
 * to be translated at every seam, and the translation is where the silence lives: a
 * compare that never matches looks exactly like a store that never changes.
 *
 * The byte count goes in the header, not the character count — `m²` is in half the
 * product descriptions this shop writes, and a header off by two is a sha nothing
 * else in the world agrees with.
 */
export function gitBlobSha(bytes: Uint8Array): string {
  const hash = createHash('sha1');
  hash.update(`blob ${bytes.byteLength}\0`, 'utf8');
  hash.update(bytes);
  return hash.digest('hex');
}

/** A file as read, with the number that makes a later write safe. */
export interface StoredFile {
  bytes: Uint8Array;
  sha: string;
  /** Milliseconds since the epoch, for `Last-Modified`. */
  mtimeMs: number;
}

/** One line of `history.ndjson`. The whole format, and the whole point of the file. */
export interface HistoryEntry {
  at: string;
  path: string;
  sha: string;
  device: string;
  message: string;
}

/** What a caller asked to be true before its write was allowed to happen. */
export interface Conditions {
  /** Write only if this is still the current sha. */
  ifMatch?: string;
  /** Write only if there is nothing there yet. */
  ifNoneMatch?: boolean;
}

export type WriteOutcome =
  | { ok: true; sha: string; mtimeMs: number; created: boolean }
  | { ok: false; conflict: true; sha: string | null };

export interface WriteMeta {
  device?: string;
  message?: string;
  /** Whose write this is recorded against; defaults to the device name. */
  at?: string;
}

/** A device this box lets write. Only the token's sha256 is kept. */
export interface Device {
  id: string;
  name: string;
  tokenSha256: string;
  role: 'owner' | 'device';
  createdAt: string;
}

/** A freshly minted device, with the one time the token is ever visible. */
export interface Minted {
  device: Device;
  token: string;
}

/**
 * Reads and writes of one folder.
 *
 * One instance per process, which is the whole design: there is one server, so there
 * is no second writer to coordinate with on disk. That is also why the locks below
 * exist — the two writers that do exist are two requests in the same process, and
 * the check-then-write of a compare-and-set has to be one indivisible step or two
 * requests holding the same sha both "win" and one quietly overwrites the other.
 */
export class FileStore {
  /** Serialises check-then-write per file. See the class note. */
  private readonly locks = new Map<string, Promise<unknown>>();

  /** Serialises appends, so two writes in the same millisecond cannot weave one line. */
  private appendChain: Promise<unknown> = Promise.resolve();

  /** Current sha per workbook, remembered against the file's own size and time. */
  private readonly shaCache = new Map<string, { mtimeMs: number; size: number; sha: string }>();

  constructor(readonly dataDir: string) {}

  // ── where things live ───────────────────────────────────────────────────────

  /** The file behind a history key. Unknown keys are this function's problem, not a throw. */
  pathFor(key: string): string {
    if (key === STATE_KEY) return join(this.dataDir, 'state.json');
    if (key === LOCATION_KEY) return join(this.dataDir, 'exports', 'location.xlsx');
    if (key === FUTURE_KEY) return join(this.dataDir, 'exports', 'future.xlsx');
    throw new StorePathError(key);
  }

  pathForExport(kind: ExportKind): string {
    return this.pathFor(kind === 'location' ? LOCATION_KEY : FUTURE_KEY);
  }

  keyForExport(kind: ExportKind): string {
    return kind === 'location' ? LOCATION_KEY : FUTURE_KEY;
  }

  private get devicesPath(): string {
    return join(this.dataDir, 'devices.json');
  }

  private get setupCodePath(): string {
    return join(this.dataDir, 'setup-code');
  }

  private get historyPath(): string {
    return join(this.dataDir, 'history.ndjson');
  }

  // ── reading ─────────────────────────────────────────────────────────────────

  /** The bytes behind a key, or `null` when nothing has been written yet. */
  async read(key: string): Promise<StoredFile | null> {
    return this.readPath(this.pathFor(key));
  }

  async readPath(path: string): Promise<StoredFile | null> {
    try {
      const [bytes, info] = await Promise.all([readFile(path), stat(path)]);
      return { bytes: new Uint8Array(bytes), sha: gitBlobSha(bytes), mtimeMs: info.mtimeMs };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  // ── writing ─────────────────────────────────────────────────────────────────

  /**
   * Compare-and-set write, with the history line that goes with it.
   *
   * The read, the compare, the write and the append all happen inside one lock for
   * that key. Outside a lock this is two requests that both pass their compare and
   * then both write: the loser's 409 never arrives, and its author believes their
   * numbers are on the server when the other floor's are. Inside the lock the second
   * request compares against the file the first one just put there, which is the
   * whole point of asking for `If-Match`.
   */
  async write(key: string, bytes: Uint8Array, conditions: Conditions, meta: WriteMeta): Promise<WriteOutcome> {
    const path = this.pathFor(key);
    return this.withLock(`write:${path}`, async () => {
      const current = await this.readPath(path);
      const refusal = compare(conditions, current?.sha ?? null);
      if (refusal !== null) return { ok: false, conflict: true, sha: refusal.sha };

      const written = await writeAtomic(path, bytes, 0o644);
      await this.appendHistory({
        at: meta.at ?? new Date(written.mtimeMs).toISOString(),
        path: key,
        sha: written.sha,
        device: meta.device ?? '',
        message: meta.message ?? '',
      });
      // A workbook written through here is by definition the current one, so the
      // cache may say so without a second read.
      this.shaCache.set(path, { mtimeMs: written.mtimeMs, size: bytes.byteLength, sha: written.sha });
      return { ok: true, sha: written.sha, mtimeMs: written.mtimeMs, created: current === null };
    });
  }

  // ── history ─────────────────────────────────────────────────────────────────

  /**
   * Append one JSON line. Never fails a write.
   *
   * The data is already on disk by the time this runs, so a history that cannot be
   * written must not turn a saved shop into an error the floor sees — it should cost
   * one line in the log and be visible there. Appends are chained rather than fired
   * in parallel because two lines written in the same tick can interleave inside the
   * file and leave one unusable.
   */
  async appendHistory(entry: HistoryEntry): Promise<void> {
    const line = `${JSON.stringify(entry)}\n`;
    this.appendChain = this.appendChain
      .then(async () => {
        try {
          await mkdir(this.dataDir, { recursive: true });
          const handle = await open(this.historyPath, 'a', 0o644);
          try {
            await handle.writeFile(line, 'utf8');
          } finally {
            await handle.close();
          }
        } catch {
          // Swallowed on purpose. See the note above: the write happened, the line
          // did not, and the request line in the log is the remaining trail.
        }
      })
      .catch(() => undefined);
    await this.appendChain;
  }

  /**
   * The most recent writes, newest first.
   *
   * Read from the end backwards rather than top down: the file only ever grows, it
   * is read on every folder-watch poll (`getEntrySha` in the app asks what a workbook
   * is worth before it downloads anything), and a shop that has been running for a
   * year would otherwise re-read its whole life to answer one question.
   */
  async history(key: string, limit: number): Promise<HistoryEntry[]> {
    const found: HistoryEntry[] = [];
    let position = await fileSize(this.historyPath);
    if (position <= 0) return found;

    let chunk = 64 * 1024;
    while (position > 0 && found.length < limit) {
      const take = Math.min(chunk, position);
      const start = position - take;
      const slice = await readSlice(this.historyPath, start, take);
      position = start;
      chunk *= 4;

      const lines = slice.toString('utf8').split('\n');
      // The first line of a mid-file slice is a fragment of a longer one.
      if (start > 0) lines.shift();
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const entry = parseLine(lines[i] ?? '');
        if (entry === null || entry.path !== key) continue;
        found.push(entry);
        if (found.length >= limit) break;
      }
    }
    return found;
  }

  /**
   * The current sha of a file, without sending its megabytes to the caller.
   *
   * Cached against the file's own size and modification time, because the watch asks
   * once a minute and hashing a two-megabyte workbook every time is work nobody asked
   * for. The cache is only ever keyed on the file's identity, so it cannot serve a
   * sha for bytes that are no longer there.
   */
  async currentSha(key: string): Promise<string | null> {
    const path = this.pathFor(key);
    const info = await stat(path).catch((error: unknown) => {
      if (isNotFound(error)) return null;
      throw error;
    });
    if (info === null) return null;
    const cached = this.shaCache.get(path);
    if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.sha;
    const bytes = await readFile(path);
    const sha = gitBlobSha(new Uint8Array(bytes));
    this.shaCache.set(path, { mtimeMs: info.mtimeMs, size: info.size, sha });
    return sha;
  }

  // ── devices ─────────────────────────────────────────────────────────────────

  /** The devices this box will take a token from. Empty the first time, always. */
  async devices(): Promise<Device[]> {
    return this.withLock('devices', async () => readDevices(this.devicesPath));
  }

  /** Which device this token belongs to, or `null`. Only the hash is ever looked at. */
  async deviceForToken(token: string): Promise<Device | null> {
    const sha = sha256Hex(token);
    for (const device of await readDevices(this.devicesPath)) {
      if (timingSafeHexEqual(device.tokenSha256, sha)) return device;
    }
    return null;
  }

  /**
   * Give a device a key.
   *
   * The token is 20 random bytes in hex — the same length GitHub's tokens are, so
   * nothing in the app has to handle two shapes. Only the sha256 is stored: this file
   * is copied into every backup, and a box that holds the live tokens of every phone
   * in the shop is a box worth stealing when a box holding their hashes is not.
   */
  async mintDevice(name: string, role: 'owner' | 'device'): Promise<Minted> {
    return this.withLock('devices', async () => {
      const list = await readDevices(this.devicesPath);
      const token = randomBytes(20).toString('hex');
      const device: Device = {
        id: `dev-${randomBytes(5).toString('hex')}`,
        name: name.trim() === '' ? 'a device in the shop' : name.trim().slice(0, 60),
        tokenSha256: sha256Hex(token),
        role,
        createdAt: new Date().toISOString(),
      };
      // Owner first, then everyone else in the order they were introduced: the file
      // is read by a person as well as by this code, and "who set this box up" should
      // be the first line in it.
      const next = role === 'owner' ? [device, ...list] : [...list, device];
      await writeAtomic(this.devicesPath, Buffer.from(`${JSON.stringify(next, null, 2)}\n`, 'utf8'), 0o600);
      return { device, token };
    });
  }
  // ── the one-time setup code ─────────────────────────────────────────────────

  /** The code printed on the console, or `null` once it has been used up. */
  async setupCode(): Promise<string | null> {
    const raw = await readFile(this.setupCodePath, 'utf8').catch(() => null);
    return raw === null ? null : raw.trim();
  }

  /** Write the code nobody has used yet. Mode 0600: it is a key until it is spent. */
  async createSetupCode(): Promise<string> {
    return this.withLock('setup', async () => {
      const existing = await this.setupCode();
      if (existing !== null) return existing;
      const code = newSetupCode();
      await writeAtomic(this.setupCodePath, Buffer.from(`${code}\n`, 'utf8'), 0o600);
      return code;
    });
  }

  /**
   * Spend the setup code for a device.
   *
   * `null` is the answer to every failure — wrong code, already spent, never issued —
   * because the difference tells an attacker which guesses were close, and tells the
   * shop nothing it needed to know. The unlink happens inside the same lock as the
   * mint below it, so two devices presenting the same code at once cannot both become
   * owners.
   */
  async redeemSetupCode(code: string, name: string): Promise<Minted | null> {
    return this.withLock('setup', async () => {
      const held = await this.setupCode();
      if (held === null || !timingSafeHexEqual(held.toUpperCase(), code.trim().toUpperCase())) return null;
      try {
        await unlink(this.setupCodePath);
      } catch {
        return null;
      }
      return this.mintDevice(name, 'owner');
    });
  }

  /** Has anything ever been written here? Decides the first-run console line. */
  async isEmpty(): Promise<boolean> {
    const state = await stat(join(this.dataDir, 'state.json')).catch(() => null);
    if (state !== null) return false;
    return (await readDevices(this.devicesPath)).length === 0;
  }

  /** Create the data folder. Called at startup so a bad path fails there, not on write. */
  async ensure(): Promise<void> {
    await mkdir(join(this.dataDir, 'exports'), { recursive: true });
  }

  /**
   * One writer at a time per name.
   *
   * A promise per held name, chained: Node is single-threaded, so this is not
   * protecting memory, it is protecting a sequence of awaits from interleaving with
   * another request's sequence — which is exactly what a compare-and-set is.
   */
  private withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(name) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    // Whatever this writer did, the next one may go. The rejection is handed back to
    // the caller that caused it rather than becoming an unhandled rejection.
    this.locks.set(
      name,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }
}

/** Thrown when a caller asks for something this store does not keep. */
export class StorePathError extends Error {
  constructor(readonly key: string) {
    super(`this store keeps the shop document and the two MYOB workbooks, so "${key}" is not something it holds`);
    this.name = 'StorePathError';
  }
}

// ── the atomic write, and the helpers around it ───────────────────────────────

/**
 * Write bytes so that a crash leaves either the old file or the new one.
 *
 * Three steps, and the order is the whole mechanism: write a sibling temporary file,
 * `fsync` it so the bytes are on the platter (or the SSD) before anything points at
 * them, then rename it over the target. Rename within one filesystem is atomic. The
 * temporary file is in the same folder for exactly that reason — a rename across
 * filesystems is a copy, and a copy is not atomic. The folder `fsync` at the end is
 * what makes the new directory entry survive a power cut too; where a filesystem
 * refuses it, the write has still done the part that matters.
 */
async function writeAtomic(path: string, bytes: Uint8Array, mode: number): Promise<{ sha: string; mtimeMs: number }> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const temp = join(dir, `.${basename(path)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temp, 'w', mode);
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  await handle.close();
  await rename(temp, path);
  await syncDir(dir);
  const info = await stat(path);
  return { sha: gitBlobSha(bytes), mtimeMs: info.mtimeMs };
}

async function syncDir(dir: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(dir, 'r');
    await handle.sync();
  } catch {
    // Not every filesystem will do this (and none of them will on a macOS
    // development box). The file is already renamed and durable; this was only ever
    // about the directory entry.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** `null` means the file is not there. Everything else is a real failure. */
function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT';
}

/**
 * Does the caller's precondition hold? `null` means yes; otherwise this is the 409 to
 * send, carrying the sha we actually hold.
 *
 * The shape matters. Returning "the current sha" for both *no conflict* and *we hold
 * nothing* means a writer with an out-of-date `If-Match` against an empty store is told
 * they won, and a workbook nobody ever wrote gets created by a device that believed it
 * was replacing one. So a refusal is its own object, with room for `sha: null`.
 */
function compare(conditions: Conditions, current: string | null): { sha: string | null } | null {
  if (conditions.ifMatch !== undefined) {
    return conditions.ifMatch === current ? null : { sha: current };
  }
  if (conditions.ifNoneMatch === true) return current === null ? null : { sha: current };
  // No precondition at all: an unconditional overwrite, which is what a writer that
  // sends neither header is asking for.
  return null;
}

async function readDevices(path: string): Promise<Device[]> {
  const raw = await readFile(path, 'utf8').catch(() => null);
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isDevice);
  } catch {
    // A devices.json we cannot read must not read as "no devices", or every phone in
    // the shop is locked out by a truncated line. Refusing is louder, and the file is
    // one `cat` away from an answer.
    throw new Error(`${path} is not readable as a device list — it is a plain text file, look at it`);
  }
}

function isDevice(value: unknown): value is Device {
  const d = value as Partial<Device> | null;
  return (
    typeof d === 'object' &&
    d !== null &&
    typeof d.id === 'string' &&
    typeof d.tokenSha256 === 'string' &&
    (d.role === 'owner' || d.role === 'device')
  );
}

function parseLine(line: string): HistoryEntry | null {
  if (line.trim() === '') return null;
  try {
    const parsed = JSON.parse(line) as Partial<HistoryEntry>;
    if (typeof parsed.path !== 'string' || typeof parsed.sha !== 'string') return null;
    return {
      at: typeof parsed.at === 'string' ? parsed.at : '',
      path: parsed.path,
      sha: parsed.sha,
      device: typeof parsed.device === 'string' ? parsed.device : '',
      // Long messages are the shop's own words. The line was written by us, so the
      // only way it is missing is a log from before messages existed.
      message: typeof parsed.message === 'string' ? parsed.message : '',
    };
  } catch {
    return null;
  }
}

async function fileSize(path: string): Promise<number> {
  const info = await stat(path).catch(() => null);
  return info === null ? 0 : info.size;
}

async function readSlice(path: string, start: number, length: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Compare two hex strings without the clock being a channel.
 *
 * `===` on a secret returns early on the first wrong character, which leaks how much
 * of a guess was right to anyone able to time it. Over a LAN that is a fussy
 * precaution, and it costs nothing, and the setup code is the one thing in this
 * design that is guessable by hand.
 */
function timingSafeHexEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

/**
 * The setup code: eight characters, none of them ambiguous.
 *
 * A person reads this off a console and types it into a phone across a shop floor.
 * `0`/`O` and `1`/`I` are the reason serial numbers have never been pleasant, so they
 * are not in the alphabet. Eight characters of a 32-symbol alphabet is 40 bits,
 * which against a one-time code that a shop redeems once is more than enough — and
 * the box can simply issue another one if anyone cares to try.
 */
function newSetupCode(): string {
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  let code = '';
  for (const byte of bytes) code += ALPHABET[byte % ALPHABET.length];
  return code;
}
