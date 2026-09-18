/**
 * The rules behind "watch a folder, and let the computer that sees the change
 * publish it".
 *
 * The shop's MYOB exports only ever change while a person is standing at a
 * computer pressing Export — MYOB cannot schedule either report, and no API serves
 * them. So the moment worth catching is the moment the file is written, and the
 * machine that wrote it is by definition awake. Everything here is the decision
 * about whether *this* look at *that* file is worth a commit; the browser's folder
 * API lives in `data/folderAccess.ts` and the repository write in
 * `data/folderPublish.ts`, so none of these rules need a browser to test.
 *
 * Three of them matter more than the rest:
 *
 * 1. **A file that is still being written is not a file.** MYOB writes straight
 *    into the folder and OneDrive syncs it in pieces, so a reader can arrive
 *    mid-write and get half a workbook. The answer is not to sleep and hope: the
 *    previous look is remembered, and a file whose size or timestamp moved is left
 *    alone until the next look agrees with this one. One extra tick of delay, and
 *    no half-file ever leaves the PC.
 * 2. **Nothing old is published as if it were current.** A folder can hold last
 *    month's export forever. A stale file that lands in `exports/` is how a shop
 *    ends up planning against numbers that were wrong three weeks ago, and the
 *    screen would say it was imported today. The age limit is the same rule the
 *    PC script in `ops/mirror-exports.ps1` applies.
 * 3. **Identical bytes are never committed again.** Every change to `exports/` is
 *    a permanent commit holding another copy of a multi-megabyte workbook, so a
 *    watch that could not tell "changed" from "touched" would fill the
 *    repository's history with nothing. The compare is the git blob sha, computed
 *    here and kept from the last publish — which means an unchanged folder costs
 *    the repository *no requests at all*.
 */

import { formatClock, formatDayFull } from './dates';
import type { ExportFolderWatch, Settings } from './types';

/**
 * Which of the two workbooks a file is. The same two names live in
 * `data/exportSync.ts` as `ExportKind`; this module cannot import from `data`
 * (core does not know about browsers), and repeating a two-value union is cheaper
 * than inverting the dependency. They are the same two, and the tests say so.
 */
export type FolderExportKind = 'location' | 'future';
export const FOLDER_EXPORT_KINDS: readonly FolderExportKind[] = ['location', 'future'];

/**
 * A real MYOB workbook is hundreds of kilobytes. A zero-byte file, or a folder
 * that briefly holds a stub while a sync settles, is not a report — and
 * publishing it would take the good copy out of `exports/` for everybody.
 */
export const MIN_EXPORT_BYTES = 2048;

/** What the folder says about one file. No bytes, so a look costs one stat. */
export interface FolderFile {
  name: string;
  sizeBytes: number;
  /** Last write, from the file system — not from the app's clock. */
  modifiedAt: number;
}

/** The file the folder holds, plus what this device last saw of it. */
export interface PublishInput {
  kind: FolderExportKind;
  /** The file we are looking for, or `null` when the folder does not hold it. */
  file: FolderFile | null;
  /** This same file as seen on the previous look, if there was a previous look. */
  lastSeen: FolderFile | null;
  /** Git blob sha of the bytes read now, or null when they were not read. */
  localSha: string | null;
  /** Sha this device last published for this kind, or null when it never has. */
  publishedSha: string | null;
  /**
   * Whether the folder's file is the very file this PC published last: same name,
   * same size, same write time. When it is, the bytes are not even read — these
   * workbooks are megabytes, and a OneDrive placeholder that has not downloaded
   * yet would pull the whole thing across the internet to discover nothing moved.
   */
  sameFingerprint: boolean;
  now: number;
  maxAgeHours: number;
  /** Someone pressed the button. See which rules a press can and cannot pass. */
  force?: boolean;
}

/**
 * Every answer carries the sentence the screen shows. A decision without a
 * sentence is how a screen ends up printing "failed" while the reason sits in
 * another table, and the person at the counter has nothing to act on.
 */
export type FolderDecision =
  | { action: 'missing'; detail: string }
  | { action: 'still-writing'; detail: string }
  | { action: 'too-small'; detail: string; sizeBytes: number }
  | { action: 'too-old'; detail: string; modifiedAt: number; ageHours: number }
  | { action: 'already-there'; detail: string; why: 'same-file' | 'same-bytes' }
  | { action: 'publish'; detail: string };

/** Two looks at the same file, by the two things a half-written file moves. */
export function isSameFile(a: FolderFile, b: FolderFile): boolean {
  return a.name === b.name && a.sizeBytes === b.sizeBytes && a.modifiedAt === b.modifiedAt;
}

export function ageInHours(file: FolderFile, now: number): number {
  return (now - file.modifiedAt) / 3_600_000;
}

/**
 * Should these bytes go to the repository?
 *
 * The order is the explanation: nothing there → still arriving → not really a
 * workbook → too old to be called current → already in the repository → publish.
 *
 * `force` is the "publish it now" button. It passes the two rules that are about
 * *patience* — a file that moved since the last look, and a file older than the
 * limit, where the person looking knows better than the timer. It does not pass
 * the two rules that protect the other computers: a stub of a file and a re-upload
 * of bytes that are already there. Those would break or bloat the shared copy for
 * no reason, and no button press improves them.
 */
export function decidePublish(input: PublishInput): FolderDecision {
  const { kind, file, lastSeen, localSha, publishedSha, now, maxAgeHours } = input;

  if (file == null) {
    return { action: 'missing', detail: `nothing in the folder called ${kind === 'location' ? 'the stock file' : 'the jobs file'} yet` };
  }

  if (!input.force && lastSeen != null && !isSameFile(lastSeen, file)) {
    return {
      action: 'still-writing',
      detail: `${file.name} changed size or time since the last look (${lastSeen.sizeBytes.toLocaleString('en-AU')} → ${file.sizeBytes.toLocaleString('en-AU')} bytes) — left alone until it stops moving`,
    };
  }

  if (file.sizeBytes < MIN_EXPORT_BYTES) {
    return {
      action: 'too-small',
      sizeBytes: file.sizeBytes,
      detail: `${file.name} is ${file.sizeBytes.toLocaleString('en-AU')} bytes — a real MYOB export is bigger than that, so it was not published`,
    };
  }

  const ageHours = ageInHours(file, now);
  if (!input.force && ageHours > maxAgeHours) {
    return {
      action: 'too-old',
      modifiedAt: file.modifiedAt,
      ageHours,
      detail: `${file.name} was last written ${formatDayFull(file.modifiedAt)} at ${formatClock(file.modifiedAt)} — more than ${maxAgeHours} hours ago, so it is not published as if it were current`,
    };
  }

  if (input.sameFingerprint) {
    // Not overrulable by a button: republishing bytes the repository already holds
    // buys an empty commit and another copy of a multi-megabyte workbook in the
    // history, which is a worse deal for everybody with every press.
    return {
      action: 'already-there',
      why: 'same-file',
      detail: `${file.name} has not been written since this PC published it`,
    };
  }

  if (localSha != null && publishedSha != null && localSha === publishedSha) {
    return {
      action: 'already-there',
      why: 'same-bytes',
      detail: `${file.name} holds the same bytes this PC published before — nothing to send`,
    };
  }

  return { action: 'publish', detail: `${file.name} is new here (${file.sizeBytes.toLocaleString('en-AU')} bytes, written ${formatClock(file.modifiedAt)})` };
}

/**
 * The words on the commit. When two screens disagree about stock, the first
 * question is which computer a number came out of, and this line is the only
 * place that answer is kept once the device that published it has gone home.
 */
export function publishCommitMessage(options: {
  path: string;
  fileName: string;
  deviceName: string;
  at: number;
  rows: number | null;
}): string {
  const rows = options.rows == null ? '' : ` (${options.rows.toLocaleString('en-AU')} rows)`;
  return `exports: ${options.path} from ${options.deviceName || 'a PC in the shop'} @ ${formatDayFull(options.at)} ${formatClock(options.at)}${rows}`;
}

/* ── Finding the file when the name is not what Settings says ──────────────── */

/**
 * MYOB saves a report as whatever the person typed in the save box — "Item List
 * [Summary] 18-09-2026.xlsx" is normal — while Settings holds the two names the
 * shop agreed on. Exact first, then these hints, then give up and list what the
 * folder does hold. A watch that only ever matched a perfect name would sit there
 * saying "nothing called location.xlsx" while the file sits in front of it.
 */
export const NAME_HINTS: Record<FolderExportKind, readonly string[]> = {
  location: ['item list', 'stock', 'on hand', 'location'],
  future: ['sales', 'item detail', 'order', 'future'],
};

/** Spreadsheet files only. A folder of MYOB exports also holds `.qbm` backups. */
export function isWorkbookName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.xlsx') && !name.startsWith('~$');
}

/** Case-insensitive exact match — Windows does not care, and neither should we. */
export function findExactFile(files: FolderFile[], wanted: string): FolderFile | null {
  const needle = wanted.trim().toLowerCase();
  if (needle === '') return null;
  return files.find((f) => f.name.toLowerCase() === needle) ?? null;
}

/** Files whose *name* suggests this report, newest first, exact match excluded. */
export function hintMatches(files: FolderFile[], kind: FolderExportKind, excludeName = ''): FolderFile[] {
  const hints = NAME_HINTS[kind];
  const drop = excludeName.trim().toLowerCase();
  return files
    .filter((f) => isWorkbookName(f.name) && f.name.toLowerCase() !== drop)
    .filter((f) => hints.some((hint) => f.name.toLowerCase().includes(hint)))
    .sort((a, b) => b.modifiedAt - a.modifiedAt);
}

/**
 * Which file in the folder is this report.
 *
 * `how` is not decoration: an exact name is used without asking, a name-hint match
 * is *offered* to the person on the screen and only used when they say yes. A
 * watch that guessed and imported the wrong report would put jobs numbers into the
 * stock mirror on every computer at once — the one failure this feature must not
 * have. The bytes decide in the end either way; `data/folderPublish.ts` parses
 * before it publishes and refuses a file that is not the report its name claims.
 */
export function pickFolderFile(
  files: FolderFile[],
  wanted: string,
  kind: FolderExportKind,
): { file: FolderFile | null; how: 'exact' | 'hint' | null; candidates: FolderFile[] } {
  const exact = findExactFile(files, wanted);
  if (exact != null) return { file: exact, how: 'exact', candidates: [] };
  const candidates = hintMatches(files, kind, wanted);
  // One plausible file is offered; two or three is a decision for the person
  // looking, because guessing between "Sales item detail 12-09.xlsx" and
  // "Sales item detail 18-09.xlsx" is exactly the sort of thing that must not be
  // guessed at.
  if (candidates.length === 1) return { file: candidates[0] ?? null, how: 'hint', candidates };
  return { file: null, how: null, candidates };
}

/* ── What Settings actually means ──────────────────────────────────────────── */

/** The folder watch with its numbers already made safe to use. */
export interface FolderRules {
  enabled: boolean;
  intervalMinutes: number;
  names: Record<FolderExportKind, string>;
  maxAgeHours: number;
}

function wholeWithin(value: unknown, min: number, max: number, fallback: number): number {
  // `Infinity` is a number and would pass a plain `typeof` check, then make every
  // file look too old. So it is finite or it is the fallback.
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Read the folder settings the way the watch should read them.
 *
 * Settings arrive from IndexedDB, or from another computer's `state.json`, and an
 * older document has no folder block at all — the same reason `readExportStates`
 * spreads over a blank rather than trusting what it found. The bounds are here
 * rather than in the input box so that a hand-edited setting cannot set a 0-second
 * poll (which would stat a network folder hundreds of times a minute) or an age
 * limit long enough to publish last quarter's export as current.
 */
export function folderRules(settings: Settings): FolderRules {
  const folder = (settings.sources.exports.folder ?? {}) as Partial<ExportFolderWatch>;
  return {
    enabled: folder.enabled === true,
    intervalMinutes: wholeWithin(folder.intervalMinutes, 1, 60, 1),
    names: {
      location: (folder.locationFile ?? 'location.xlsx').trim(),
      future: (folder.futureFile ?? 'future.xlsx').trim(),
    },
    maxAgeHours: wholeWithin(folder.maxAgeHours, 1, 336, 30),
  };
}

/* ── The sha the repository compares against ───────────────────────────────── */

/** `blob <byte length>\0`, the header git hashes in front of every file's bytes. */
export function blobHeader(byteLength: number): Uint8Array {
  return new TextEncoder().encode(`blob ${byteLength}\0`);
}

/**
 * The same number `git hash-object` prints, and therefore the same number the
 * Contents API reports as a file's `sha`. Taken from
 * `git hash-object test/fixtures/real/location.xlsx` in the tests, so a wrong
 * header cannot hide: the compare would simply never match, and every tick of the
 * watch would re-publish the same workbook.
 *
 * `sha1` is passed in because the browser's crypto is asynchronous and the test
 * runner's is a different object again; nothing here needs either.
 */
export async function gitBlobSha(bytes: Uint8Array, sha1: (joined: Uint8Array) => Promise<string>): Promise<string> {
  const header = blobHeader(bytes.byteLength);
  const joined = new Uint8Array(header.byteLength + bytes.byteLength);
  joined.set(header, 0);
  joined.set(bytes, header.byteLength);
  return sha1(joined);
}
