/**
 * Pulling the two MYOB exports out of the shop's repository and importing them
 * without anybody dropping a file.
 *
 * The mirror (Power Automate, or a hand) writes `exports/location.xlsx` and
 * `exports/future.xlsx` into the **data** repository. This module reads them, and
 * stops. Three rules shape it:
 *
 * 1. **A blob sha is the change detector.** GitHub's Contents API gives a sha for
 *    the file's content, so an identical file costs one request and does nothing —
 *    no re-parse, no re-import, no fresh timestamps on 2,300 product rows because
 *    the mirror re-uploaded the same numbers.
 * 2. **Nothing is remembered as imported unless it was imported.** A file that
 *    fails to parse keeps the sha it had *before* the attempt, so the next check
 *    tries again. A half-written spreadsheet from a mirror that was interrupted is
 *    the ordinary case here, and it must not be marked as seen.
 * 3. **An import is a maker's write.** A viewer's device does not import, and does
 *    not throw about it either — it says why and stays out of the way, because
 *    this runs on a timer and a timer that logs a refusal every fifteen minutes is
 *    just noise. `commitImport` still asserts for real; this only declines early.
 *
 * What this cannot do is notice anything while the shop is closed. There is no
 * server, so "when changed" means "the next time an app is open and online on a
 * device holding a token". That limit belongs on the screen, not in a footnote, so
 * the Sources card says it.
 */

import type { Settings } from '@/core/types';
import { parseExport } from '@/lib/myob/importFile';
import { getSettings } from './db';
import { db } from './db';
import { clientForDevice, getDeviceToken } from './auth';
import { logEvent } from './events';
import { commitImport } from './importFlow';
import { can } from './principal';

/** The two exports, keyed the way the shop names them. */
export type ExportKind = 'location' | 'future';
export const EXPORT_KINDS: readonly ExportKind[] = ['location', 'future'];

/** `never` is a state, not a null: it is what the card shows on a fresh device. */
export type ExportStatus = 'never' | 'imported' | 'unchanged' | 'failed' | 'missing';

export interface ExportState {
  kind: ExportKind;
  /** The path this state was last read from, so a renamed path reads as new. */
  path: string;
  /** Blob sha of the last content this device imported. */
  sha: string | null;
  status: ExportStatus;
  /** One line, in the words the screen shows. Never stack-trace shaped. */
  detail: string;
  bytes: number | null;
  rows: number | null;
  checkedAt: number | null;
  importedAt: number | null;
}

export type ExportStateMap = Record<ExportKind, ExportState>;

/** One meta row for the whole map: it changes together and is read together. */
export const EXPORT_STATE_KEY = 'exports.state';

/** Only the two files that shape the board. A repository file that is neither is
 *  not this module's business. */
export interface ExportReader {
  getBinaryFile(path: string): Promise<{ sha: string; bytes: Uint8Array } | null>;
}

export interface ExportCheckResult {
  at: number;
  /** False when the check declined to run at all — see `reason`. */
  ran: boolean;
  reason: string | null;
  states: ExportStateMap;
  /** How many of the two files were imported by this run. */
  imported: number;
  failed: number;
}

export function blankExportState(kind: ExportKind): ExportState {
  return {
    kind,
    path: '',
    sha: null,
    status: 'never',
    detail: 'not checked yet',
    bytes: null,
    rows: null,
    checkedAt: null,
    importedAt: null,
  };
}

export function exportPaths(settings: Settings): Record<ExportKind, string> {
  return {
    location: settings.sources.exports.locationPath.trim(),
    future: settings.sources.exports.futurePath.trim(),
  };
}

export async function readExportStates(): Promise<ExportStateMap> {
  const row = await db.meta.get(EXPORT_STATE_KEY);
  const stored = (row?.value ?? {}) as Partial<Record<ExportKind, Partial<ExportState>>>;
  const out = {} as ExportStateMap;
  for (const kind of EXPORT_KINDS) {
    // Spread over a blank rather than trust the file: a state written by an older
    // build must not carry a missing field into the screen.
    out[kind] = { ...blankExportState(kind), ...(stored[kind] ?? {}), kind };
  }
  return out;
}

async function writeExportStates(states: ExportStateMap): Promise<void> {
  await db.meta.put({ key: EXPORT_STATE_KEY, value: states });
}

/**
 * Say "this device already has these bytes", from somewhere other than the pull.
 *
 * A PC that publishes a workbook out of its folder has already imported it — from
 * the file on its own disk, which is newer than anything in the repository at that
 * second. Without this, the next automatic check would fetch the copy that was
 * there *before* the publish, parse two megabytes again, and write an older
 * snapshot over the one it just made. The sha we were given when we wrote the file
 * is the sha the pull compares against, so one line here stops all of that.
 */
export async function recordExportImport(
  kind: ExportKind,
  written: { path: string; sha: string; detail: string; bytes: number; rows: number | null; at: number },
): Promise<void> {
  const states = await readExportStates();
  states[kind] = {
    kind,
    path: written.path,
    sha: written.sha,
    status: 'imported',
    detail: written.detail,
    bytes: written.bytes,
    rows: written.rows,
    checkedAt: written.at,
    importedAt: written.at,
  };
  await writeExportStates(states);
}

/** `exports/location.xlsx` → `location.xlsx`. The parser only wants a name to quote. */
function fileNameOf(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] ?? path;
}

/** Two runs at once would import the same file twice; the second sees the sha the
 *  first one wrote. Same shape as the first-run seeding race. */
let running: Promise<ExportCheckResult> | null = null;

/**
 * Ask the repository what it has, and import whatever is new.
 *
 * Concurrent calls share one run. `force` re-imports even an unchanged sha, which
 * is what the "Check now" button does when someone wants to be sure.
 */
export function checkExports(
  options: { force?: boolean; client?: ExportReader; settings?: Settings } = {},
): Promise<ExportCheckResult> {
  running ??= checkOnce(options).finally(() => {
    running = null;
  });
  return running;
}

/** Whether a check is worth starting on this device right now, and if not, why. */
export function exportWatchBlocker(settings: Settings, online = true): string | null {
  if (!settings.sources.exports.autoImport) return 'automatic import is switched off';
  if (!can('sources.import')) return 'this device is signed in as a viewer';
  if (!online) return 'this device is offline';
  return null;
}

/**
 * Why this device is not going to import anything, in the words a screen shows —
 * `null` means go ahead.
 *
 * The synchronous rule above cannot see the last reason, and it is the common one:
 * the token lives in its own IndexedDB key, per device, so a signed-in device that
 * has never been given one is switched on, online, entitled, and deaf. A device in
 * that state used to sit on the Sources screen showing "Not checked" forever, with
 * the real sentence written nowhere at all.
 */
export async function exportBlockerReason(settings: Settings, online = true): Promise<string | null> {
  const rule = exportWatchBlocker(settings, online);
  if (rule !== null) return rule;
  // `getDeviceToken` answers with an empty string, not null — a device that has
  // never been handed one has nothing, and `'' == null` is false.
  const token = await getDeviceToken();
  if (token === '') return 'this device has no repository token';
  const { githubOwner, githubRepo } = settings.sync;
  if (githubOwner.trim() === '' || githubRepo.trim() === '') return 'no repository is set in Settings';
  return null;
}

async function checkOnce(options: { force?: boolean; client?: ExportReader; settings?: Settings }): Promise<ExportCheckResult> {
  const settings = options.settings ?? (await getSettings());
  const at = Date.now();
  const states = await readExportStates();
  const paths = exportPaths(settings);
  const declined = (reason: string): ExportCheckResult => ({ at, ran: false, reason, states, imported: 0, failed: 0 });

  // One sentence for the screen and for this refusal, so they cannot disagree about
  // why nothing arrived. "Check now" overrides the switch only: a viewer, or a device
  // with no token, has nothing a button can fix.
  const blocked = await exportBlockerReason(settings);
  if (blocked !== null && !(options.force && blocked === 'automatic import is switched off')) {
    // An injected reader is the seam the tests use to mean "assume this device can
    // read the repository", so it stands in for the two connection-shaped reasons and
    // nothing else. Who is holding the device, whether the switch is on, and whether
    // there is a signal are real rules that no fixture can grant.
    const aboutTheConnection = blocked === 'this device has no repository token' || blocked === 'no repository is set in Settings';
    if (!(options.client != null && aboutTheConnection)) return declined(blocked);
  }

  const client = options.client ?? (await clientForDevice(settings));
  if (client == null) return declined('this device has no repository token');

  let imported = 0;
  let failed = 0;

  // Deliberately one after the other. Each import rewrites one mirror and then
  // reads *both* mirrors to work out which codes the shop makes; run together,
  // each would see the other's half-written state.
  for (const kind of EXPORT_KINDS) {
    const path = paths[kind];
    const previous = states[kind];
    if (path === '') {
      states[kind] = { ...previous, kind, path, status: 'missing', detail: 'no path set in Settings', checkedAt: at };
      continue;
    }

    try {
      const file = await client.getBinaryFile(path);
      if (file == null) {
        // Keep the sha and the last import: a mirror that briefly lost the file
        // must not look like the shop lost its data.
        states[kind] = {
          ...previous,
          kind,
          path,
          status: 'missing',
          detail: `nothing at ${path}`,
          checkedAt: at,
        };
        failed += 1;
        continue;
      }

      if (!options.force && previous.sha === file.sha && previous.path === path && previous.importedAt != null) {
        states[kind] = { ...previous, kind, path, status: 'unchanged', detail: 'same file as last time', checkedAt: at };
        continue;
      }

      const parsed = parseExport(file.bytes, fileNameOf(path));
      const commit = await commitImport(parsed);
      states[kind] = {
        kind,
        path,
        sha: file.sha,
        status: 'imported',
        detail: `${commit.rows.toLocaleString('en-AU')} rows from ${fileNameOf(path)}`,
        bytes: file.bytes.byteLength,
        rows: commit.rows,
        checkedAt: at,
        importedAt: Date.now(),
      };
      imported += 1;
    } catch (error) {
      // The sha is *not* recorded, so the next check retries this file.
      states[kind] = {
        ...previous,
        kind,
        path,
        status: 'failed',
        detail: error instanceof Error ? error.message : String(error),
        checkedAt: at,
      };
      failed += 1;
    }
  }

  await writeExportStates(states);

  if (imported > 0) {
    await logEvent('export.import', {
      detail: `automatic import: ${EXPORT_KINDS.filter((k) => states[k].status === 'imported')
        .map((k) => `${k} (${states[k].detail})`)
        .join(', ')}`,
      qty: imported,
    });
  }
  if (failed > 0) {
    await logEvent('export.failed', {
      detail: `automatic import could not use: ${EXPORT_KINDS.filter((k) => states[k].status === 'missing' || states[k].status === 'failed')
        .map((k) => `${k} — ${states[k].detail}`)
        .join('; ')}`,
    });
  }

  return { at, ran: true, reason: null, states, imported, failed };
}

/** Only for tests: a device that has never talked to the repository. */
export async function clearExportStates(): Promise<void> {
  await db.meta.delete(EXPORT_STATE_KEY);
}
