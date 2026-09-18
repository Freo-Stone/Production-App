/**
 * The timer behind the folder watch.
 *
 * Same shape as `exportWatch.ts`, for the same reasons: the look has to keep running
 * when the Sources screen is closed, one look must not overlap another, and a device
 * that has just found a signal again or come back to the front is exactly the device
 * that has missed something.
 *
 * The difference is what it is watching for. The repository check asks "has anybody
 * sent a new export"; this one asks "did *this* computer just get one", and it is
 * cheap enough to ask every minute — an unchanged folder costs one directory listing
 * and no requests at all.
 */

import { useEffect } from 'react';
import { formatClock } from '@/core/dates';
import { folderRules } from '@/core/folderSource';
import { getSettings } from '@/data/db';
import { browserFolderSource, folderStatus } from '@/data/folderAccess';
import { checkFolder, type FolderRun } from '@/data/folderPublish';
import { toast } from '@/ui/primitives';

const TICK_MS = 30_000;
const OPEN_DELAY_MS = 8_000;

let timer: ReturnType<typeof setInterval> | null = null;
let openTimer: ReturnType<typeof setTimeout> | null = null;
/** When this page last looked. In memory only: after a reload, looking straight
 *  away is the right answer, not waiting out an interval for a file that may have
 *  changed while the app was closed. */
let lastLookAt = 0;

function online(): boolean {
  return typeof globalThis.navigator === 'undefined' ? true : globalThis.navigator.onLine !== false;
}

/**
 * One look at the folder.
 *
 * `force` is the button. It does not mean "publish whatever is in there" — the
 * rules that protect the other computers still apply — it means "do not wait for
 * the next minute".
 */
export async function runFolderLook(options: { force?: boolean } = {}): Promise<FolderRun | null> {
  try {
    const run = await checkFolder({ source: browserFolderSource(), ...(options.force ? { force: true } : {}) });
    lastLookAt = run.at;
    if (run.published > 0) {
      const which = run.looks
        .filter((l) => l.outcome.action === 'published')
        .map((l) => (l.outcome.action === 'published' ? `${l.kind === 'location' ? 'Stock' : 'Jobs'}: ${l.outcome.rows ?? 0} rows` : ''));
      toast('info', 'Sent to the shop', `This PC published ${which.join(' · ')} at ${formatClock(run.at)}. The others pick it up on their next check.`);
    } else if (run.held > 0 && options.force) {
      const why = run.looks
        .filter((l) => l.outcome.action === 'refused' || l.outcome.action === 'failed')
        .map((l) => l.outcome.detail)
        .join(' · ');
      toast('warn', 'Nothing was sent from the folder', why);
    } else if (!run.ran && options.force && run.reason != null) {
      toast('neutral', 'The folder was not checked', run.reason);
    }
    return run;
  } catch (error) {
    // The timer must not die because one read went wrong, and an unhandled
    // rejection here is invisible on a phone in the yard.
    console.error('[freo] the folder look failed', error);
    return null;
  }
}

async function dueForALook(): Promise<boolean> {
  if (!online()) return false;
  const settings = await getSettings();
  const rules = folderRules(settings);
  if (!rules.enabled) return false;
  // A handle this browser will not hand over without a click is not a folder the
  // timer can read. Sitting on it every minute would only fill the log with the
  // same sentence; the screen says it once, next to the button that fixes it.
  if ((await folderStatus()).state !== 'ready') return false;
  return Date.now() - lastLookAt >= rules.intervalMinutes * 60_000;
}

async function tick(): Promise<void> {
  if (await dueForALook()) await runFolderLook();
}

/** Idempotent: starting a watch that is already running does nothing. */
export function startFolderWatch(): void {
  if (timer != null) return;
  openTimer = setTimeout(() => void tick(), OPEN_DELAY_MS);
  timer = setInterval(() => void tick(), TICK_MS);
  globalThis.addEventListener?.('online', () => void tick());
  globalThis.addEventListener?.('visibilitychange', () => {
    if (globalThis.document?.visibilityState === 'visible') void tick();
  });
}

export function stopFolderWatch(): void {
  if (openTimer != null) clearTimeout(openTimer);
  if (timer != null) clearInterval(timer);
  timer = null;
  openTimer = null;
}

/** Mounted once, by the app shell, while somebody is signed in. */
export function useFolderWatch(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    startFolderWatch();
    return () => stopFolderWatch();
  }, [active]);
}

/** Only for tests: whether this page has looked yet. */
export function lastFolderLookAt(): number {
  return lastLookAt;
}
