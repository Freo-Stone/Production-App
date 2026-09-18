/**
 * Publishing a MYOB export from the computer that has it.
 *
 * The shop's exports only change while somebody is standing at a machine pressing
 * Export in MYOB, and MYOB cannot schedule either report. So the machine that wrote
 * the file is awake, has the file, and knows it changed — and the other computers
 * find out from the repository. This module is that one step: look at the folder,
 * and if the file is genuinely a new report, import it here and put it in the
 * repository for everyone else.
 *
 * The order of the steps is not arbitrary:
 *
 * 1. **Metadata first, bytes later.** Listing a folder is cheap; reading a
 *    two-megabyte workbook that OneDrive has not downloaded yet is not. So a file's
 *    name, size and write time are compared with what this PC published last, and
 *    an unchanged folder costs no download and no request to GitHub at all.
 * 2. **A file that keeps moving is left alone.** MYOB writes straight into the
 *    folder and OneDrive syncs it in pieces. What the folder looked like on the
 *    previous look is remembered, and a file whose size or time moved is not read.
 *    One extra tick of delay, and no half-written workbook ever leaves the PC.
 * 3. **The report is checked before it leaves the PC.** The same test the parsers
 *    use, through `parseExport`. A folder can hold the jobs workbook where the
 *    stock workbook was expected — one mis-click in MYOB's save box does it — and
 *    publishing that would put jobs numbers into every other computer's stock
 *    mirror at once. This is the one failure the feature must not have.
 * 4. **Import here, then publish.** The local mirror is updated from the bytes on
 *    this disk whether or not GitHub answers. A shop whose internet is down still
 *    gets today's stock on the machine that exported it, and the screen says the
 *    publish failed instead of pretending.
 * 5. **Two computers, one folder: last write wins, and the log says so.** Both
 *    watch the same network folder and either can commit first. A `409` means the
 *    other got there; the retry writes against the sha it left behind. When both
 *    files were identical, the sha compare stops the second one before it sends
 *    anything.
 *
 * Nothing here knows about the File System Access API — it works through the
 * {@link FolderSource} seam, so the whole of it is testable with a folder made of
 * two objects in memory, and the real browser bits stay in `folderAccess.ts`.
 */

import {
  FOLDER_EXPORT_KINDS,
  decidePublish,
  folderRules,
  gitBlobSha,
  pickFolderFile,
  publishCommitMessage,
  type FolderDecision,
  type FolderExportKind,
  type FolderFile,
} from '@/core/folderSource';
import type { Settings } from '@/core/types';
import { parseExport, type ReportKind } from '@/lib/myob/importFile';
import { ConflictError, GitHubError } from './github';
import { clientForDevice } from './auth';
import { db, getSettings } from './db';
import { logEvent } from './events';
import { commitImport } from './importFlow';
import { recordExportImport } from './exportSync';
import { can } from './principal';
import type { FolderSource } from './folderAccess';

/** Which report each file has to be. Wrong here means the wrong mirror gets overwritten. */
const EXPECTED_REPORT: Record<FolderExportKind, ReportKind> = {
  location: 'itemListSummary',
  future: 'salesItemDetail',
};

/** What this PC last published, per report. */
export const FOLDER_PUBLISH_KEY = 'folder.publish';

/**
 * What the last look said, kept for the screen.
 *
 * The per-report outcomes are not persisted anywhere else, and a person standing at
 * this machine deserves to be told what happened a minute ago — including when the
 * answer is "this computer has not been shown the folder yet". Written on every
 * look, blocked ones included, so the screen never shows a look from yesterday
 * under a heading that says "last check".
 */
export const FOLDER_REPORT_KEY = 'folder.report';

/**
 * What the folder looked like on the previous look, per report.
 *
 * Kept apart from the publish map on purpose: "what I saw a minute ago" and "what I
 * sent" answer different questions, and the difference between them is exactly the
 * half-written workbook the settle rule exists to catch.
 */
export const FOLDER_SEEN_KEY = 'folder.seen';

/** The bytes, sha and timestamp of the last thing this device published. */
export interface PublishedRecord extends FolderFile {
  sha: string;
  publishedAt: number;
  rows: number | null;
}

export type FolderPublishMap = Record<FolderExportKind, PublishedRecord | null>;
export type FolderSeenMap = Partial<Record<FolderExportKind, FolderFile>>;

export function blankFolderPublishMap(): FolderPublishMap {
  return { location: null, future: null };
}

export async function readFolderPublishMap(): Promise<FolderPublishMap> {
  const row = await db.meta.get(FOLDER_PUBLISH_KEY);
  const stored = (row?.value ?? {}) as Partial<Record<FolderExportKind, Partial<PublishedRecord>>>;
  const out = blankFolderPublishMap();
  for (const kind of FOLDER_EXPORT_KINDS) {
    const found = stored[kind];
    // A record without a sha is not usable: the whole "already there" rule depends
    // on it, and a watch that trusts a half-written record republishes forever.
    if (found != null && typeof found.sha === 'string' && found.sha !== '' && typeof found.sizeBytes === 'number') {
      out[kind] = found as PublishedRecord;
    }
  }
  return out;
}

async function readFolderSeen(): Promise<FolderSeenMap> {
  const row = await db.meta.get(FOLDER_SEEN_KEY);
  const value = row?.value;
  return value != null && typeof value === 'object' ? (value as FolderSeenMap) : {};
}

/** What the screen shows as "last look". */
export async function readFolderReport(): Promise<FolderRun | null> {
  const row = await db.meta.get(FOLDER_REPORT_KEY);
  const value = row?.value as FolderRun | undefined;
  return value != null && typeof value.at === 'number' ? value : null;
}

/** Only for tests: a device that has never looked at a folder. */
export async function clearFolderPublishMap(): Promise<void> {
  await db.meta.delete(FOLDER_PUBLISH_KEY);
  await db.meta.delete(FOLDER_SEEN_KEY);
  await db.meta.delete(FOLDER_REPORT_KEY);
}

/** What the publisher needs from the repository. `GitHubClient` satisfies it. */
export interface ExportPublisher {
  getEntrySha(path: string): Promise<string | null>;
  putBinaryFile(path: string, bytes: Uint8Array, sha: string | null, message: string): Promise<{ sha: string }>;
}

/** Where one report's look ended up. Every branch carries the sentence for the screen. */
export type FolderOutcome =
  | { action: 'published'; fileName: string; path: string; rows: number | null; sha: string; detail: string }
  | { action: 'unchanged'; fileName: string; detail: string }
  | { action: 'missing'; fileName: string; detail: string; candidates: FolderFile[] }
  | { action: 'needs-a-name'; fileName: string; detail: string; candidates: FolderFile[] }
  | { action: 'refused'; fileName: string; detail: string }
  | { action: 'failed'; fileName: string; detail: string };

export interface FolderLook {
  kind: FolderExportKind;
  outcome: FolderOutcome;
}

export interface FolderRun {
  at: number;
  ran: boolean;
  /** Why the look did not happen, when it did not. */
  reason: string | null;
  looks: FolderLook[];
  published: number;
  /** Refused or failed. Not "errors": a file that is too old was refused on purpose. */
  held: number;
}

export interface FolderLookOptions {
  source: FolderSource;
  /** Injectable, so a test can be a folder made of objects and a real run can be the browser. */
  settings?: Settings;
  publisher?: ExportPublisher;
  /** sha1 as hex. Defaults to the browser's; a browser without it does not watch. */
  digest?: (joined: Uint8Array) => Promise<string>;
  now?: () => number;
  /** The button. Lets a person overrule patience, never a broken file. */
  force?: boolean;
}

interface KindResult {
  outcome: FolderOutcome;
  /** Set only when this run actually published the file. */
  published: PublishedRecord | null;
  /** What the folder held for this report: `null` means nothing was there. */
  seen: FolderFile | null;
}

/** `exports/location.xlsx` → `location.xlsx`, for the parser to quote. */
function fileNameOf(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] ?? path;
}

async function webSha1(joined: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle == null) throw new Error('this browser cannot hash a file, so the folder watch is switched off');
  const digest = await subtle.digest('SHA-1', joined as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Whether a look is worth starting, in one sentence, or null to go ahead. */
export function folderBlockerReason(settings: Settings, accessReady: boolean, online = true): string | null {
  const rules = folderRules(settings);
  if (!rules.enabled) return 'the folder watch is switched off on this computer';
  if (!accessReady) return 'this computer has not been shown the folder yet';
  if (!can('sources.import')) return 'this device is signed in as a viewer';
  if (!online) return 'this device is offline';
  return null;
}

/** One look at the folder, both reports. Concurrent calls share one run. */
let running: Promise<FolderRun> | null = null;

export function checkFolder(options: FolderLookOptions): Promise<FolderRun> {
  running ??= lookOnce(options).finally(() => {
    running = null;
  });
  return running;
}

/** Whether a look is in progress — the screen disables its own button while it is. */
export function isFolderLookRunning(): boolean {
  return running != null;
}

async function lookOnce(options: FolderLookOptions): Promise<FolderRun> {
  const settings = options.settings ?? (await getSettings());
  const now = options.now?.() ?? Date.now();
  const rules = folderRules(settings);
  const access = await options.source.status();

  const blocked = folderBlockerReason(settings, access.state === 'ready');
  if (blocked != null) {
    const blocked_run: FolderRun = { at: now, ran: false, reason: blocked, looks: [], published: 0, held: 0 };
    await db.meta.put({ key: FOLDER_REPORT_KEY, value: blocked_run });
    return blocked_run;
  }

  const digest = options.digest ?? webSha1;
  const published = await readFolderPublishMap();
  const seen = await readFolderSeen();
  const nowSeen: FolderSeenMap = {};

  const looks: FolderLook[] = [];
  let publishedCount = 0;
  let held = 0;
  let publishedAnything = false;

  // One after the other, deliberately: both reports land in the same commit-ready
  // state, and a person reading the log should see stock before jobs, the way the
  // shop thinks about them.
  for (const kind of FOLDER_EXPORT_KINDS) {
    const result = await lookAtKind(kind, options, settings, rules, published, seen, digest, now);
    looks.push({ kind, outcome: result.outcome });
    if (result.seen === null) delete nowSeen[kind];
    else nowSeen[kind] = result.seen;
    if (result.published != null) {
      published[kind] = result.published;
      publishedAnything = true;
      publishedCount += 1;
    }
    if (result.outcome.action === 'refused' || result.outcome.action === 'failed') held += 1;
  }

  await db.meta.put({ key: FOLDER_SEEN_KEY, value: nowSeen });
  if (publishedAnything) await db.meta.put({ key: FOLDER_PUBLISH_KEY, value: published });

  if (publishedCount > 0) {
    const which = looks
      .map((l) => l.outcome)
      .filter((o): o is Extract<FolderOutcome, { action: 'published' }> => o.action === 'published')
      .map((o) => `${o.path} (${(o.rows ?? 0).toLocaleString('en-AU')} rows)`);
    await logEvent('export.publish', {
      detail: `${settings.deviceName || 'this PC'} published ${which.join(' and ')} out of the folder`,
      qty: publishedCount,
    });
  }
  if (held > 0) {
    await logEvent('export.failed', {
      detail: `the folder on this PC held something back: ${looks
        .filter((l) => l.outcome.action === 'refused' || l.outcome.action === 'failed')
        .map((l) => `${l.kind} — ${l.outcome.detail}`)
        .join('; ')}`,
    });
  }

  const run: FolderRun = { at: now, ran: true, reason: null, looks, published: publishedCount, held };
  await db.meta.put({ key: FOLDER_REPORT_KEY, value: run });
  return run;
}

/** What a paused look is called on the screen. */
function decisionOutcome(
  decision: Exclude<FolderDecision, { action: 'publish' }>,
  file: FolderFile,
  wanted: string,
): FolderOutcome {
  if (decision.action === 'already-there') {
    return { action: 'unchanged', fileName: file.name, detail: decision.detail };
  }
  if (decision.action === 'missing') {
    return { action: 'missing', fileName: wanted, detail: decision.detail, candidates: [] };
  }
  return { action: 'refused', fileName: file.name, detail: decision.detail };
}

async function lookAtKind(
  kind: FolderExportKind,
  options: FolderLookOptions,
  settings: Settings,
  rules: ReturnType<typeof folderRules>,
  published: FolderPublishMap,
  seen: FolderSeenMap,
  digest: (joined: Uint8Array) => Promise<string>,
  now: number,
): Promise<KindResult> {
  const wanted = rules.names[kind];
  const nothing = (outcome: FolderOutcome): KindResult => ({ outcome, published: null, seen: null });

  if (wanted === '') {
    return nothing({ action: 'missing', fileName: '', detail: `no ${kind} file name is set in Settings`, candidates: [] });
  }

  const files = await options.source.list();
  const pick = pickFolderFile(files, wanted, kind);

  if (pick.file == null) {
    const list = pick.candidates.length > 0 ? ` — the folder does hold ${pick.candidates.map((f) => f.name).join(', ')}` : '';
    return nothing({
      action: pick.candidates.length > 1 ? 'needs-a-name' : 'missing',
      fileName: wanted,
      detail: `nothing in the folder called ${wanted}${list}`,
      candidates: pick.candidates,
    });
  }

  const file = pick.file;
  const last = published[kind];
  const stop = (outcome: FolderOutcome): KindResult => ({ outcome, published: null, seen: file });

  // An exact name is used on its own. A name that merely *looks* right is offered to
  // a person first, because guessing wrong here overwrites the wrong mirror on
  // every computer at once, and the shop finds out when the numbers look odd.
  if (pick.how === 'hint') {
    return stop({
      action: 'needs-a-name',
      fileName: file.name,
      detail: `the folder holds ${file.name}, which looks like the ${kind === 'location' ? 'stock' : 'jobs'} export but is not called ${wanted} — say so on the Sources screen and this PC will use it`,
      candidates: pick.candidates,
    });
  }

  const sameFingerprint =
    last != null && last.name === file.name && last.sizeBytes === file.sizeBytes && last.modifiedAt === file.modifiedAt;

  const decision = decidePublish({
    kind,
    file,
    lastSeen: seen[kind] ?? null,
    localSha: null,
    publishedSha: last?.sha ?? null,
    sameFingerprint,
    now,
    maxAgeHours: rules.maxAgeHours,
    ...(options.force === true ? { force: true } : {}),
  });

  if (decision.action !== 'publish') return stop(decisionOutcome(decision, file, wanted));

  const bytes = await options.source.read(file.name);
  if (bytes == null) {
    return stop({
      action: 'failed',
      fileName: file.name,
      detail: `the folder would not give up ${file.name} — a cloud-only file and no internet does that`,
    });
  }

  const sha = await gitBlobSha(bytes, digest);
  if (last != null && last.sha === sha) {
    // Same bytes, different timestamp: a file that was copied into place, or a sync
    // that re-stamped it. Publishing it would be an empty commit in the history.
    return stop({
      action: 'unchanged',
      fileName: file.name,
      detail: `${file.name} was written again but holds the same bytes this PC published before`,
    });
  }

  // The gate. Everything after this line is visible to every other computer.
  let parsed;
  try {
    parsed = parseExport(bytes, file.name);
  } catch (error) {
    return stop({
      action: 'refused',
      fileName: file.name,
      detail: `${error instanceof Error ? error.message : String(error)} — nothing was published`,
    });
  }

  if (parsed.kind !== EXPECTED_REPORT[kind]) {
    const found = parsed.kind === 'salesItemDetail' ? 'Sales [Item Detail]' : 'Item List [Summary]';
    return stop({
      action: 'refused',
      fileName: file.name,
      detail: `${file.name} is the ${found} report, not the ${kind === 'location' ? 'stock' : 'jobs'} one — nothing was published`,
    });
  }

  const path = kind === 'location' ? settings.sources.exports.locationPath : settings.sources.exports.futurePath;
  const rows = parsed.stock?.rows.length ?? parsed.jobs?.rows.length ?? null;

  // Local first: the machine holding the file should not lose today's numbers
  // because a network call went wrong.
  let importDetail = '';
  try {
    const commit = await commitImport(parsed);
    importDetail = ` and imported ${commit.rows.toLocaleString('en-AU')} rows here`;
  } catch (error) {
    return stop({
      action: 'failed',
      fileName: file.name,
      detail: `could not import ${file.name} on this PC: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  const publisher = options.publisher ?? (await clientForDevice(settings));
  if (publisher == null) {
    return stop({
      action: 'failed',
      fileName: file.name,
      detail: 'imported here but not published: this device has no repository token',
    });
  }

  const message = publishCommitMessage({ path, fileName: file.name, deviceName: settings.deviceName, at: now, rows });

  try {
    const written = await putWithOneRetry(publisher, path, bytes, message);
    // The pull loop must not fetch the copy that was there *before* this publish
    // and write an older snapshot over the one just made.
    await recordExportImport(kind, {
      path,
      sha: written.sha,
      detail: `${(rows ?? 0).toLocaleString('en-AU')} rows from ${fileNameOf(path)} on this PC`,
      bytes: bytes.byteLength,
      rows,
      at: now,
    });
    return {
      outcome: {
        action: 'published',
        fileName: file.name,
        path,
        rows,
        sha: written.sha,
        detail: `${file.name} went to ${path}${importDetail}`,
      },
      published: { name: file.name, sizeBytes: file.sizeBytes, modifiedAt: file.modifiedAt, sha: written.sha, publishedAt: now, rows },
      seen: file,
    };
  } catch (error) {
    return stop({
      action: 'failed',
      fileName: file.name,
      detail: `imported here but the repository refused it: ${describeGithubError(error)}`,
    });
  }
}

/**
 * Write the workbook, and if another computer got there first, do it once more
 * against the sha it left behind.
 *
 * A second `409` is not retried: two machines fighting over the same path every
 * minute is a thing the shop needs to see on the screen, not one to be smoothed
 * over by a loop.
 */
async function putWithOneRetry(
  publisher: ExportPublisher,
  path: string,
  bytes: Uint8Array,
  message: string,
): Promise<{ sha: string }> {
  const serverSha = await publisher.getEntrySha(path);
  try {
    return await publisher.putBinaryFile(path, bytes, serverSha, message);
  } catch (error) {
    if (!(error instanceof ConflictError)) throw error;
    const fresh = await publisher.getEntrySha(path);
    return publisher.putBinaryFile(path, bytes, fresh, `${message} — after another PC wrote first`);
  }
}

function describeGithubError(error: unknown): string {
  if (error instanceof GitHubError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
