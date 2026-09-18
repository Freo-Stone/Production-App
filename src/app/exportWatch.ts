/**
 * The timer behind automatic export import.
 *
 * Kept out of the screen so a closed drawer or a navigated-away Sources page does
 * not stop the shop's data from arriving. The rules are the boring ones:
 *
 * - check a few seconds after the app opens, then on the interval in Settings;
 * - check again when the device comes back online, and when a tab that has been
 *   in the background comes back to the front and the last look is stale;
 * - one run at a time. A laptop that wakes from sleep can fire the tick and the
 *   visibility handler together, and importing the same file twice in the same
 *   second is how a shop ends up with two ledgers for one import.
 *
 * The interval is read from Settings every tick rather than used to size the
 * timer, so changing it takes effect without a reload and the timer itself never
 * has to be rescheduled.
 */

import { useEffect } from 'react';
import { formatClock } from '@/core/dates';
import { getSettings } from '@/data/db';
import {
  checkExports,
  EXPORT_KINDS,
  exportWatchBlocker,
  readExportStates,
  type ExportCheckResult,
} from '@/data/exportSync';
import { toast } from '@/ui/primitives';

const TICK_MS = 60_000;
const OPEN_DELAY_MS = 5_000;

let timer: ReturnType<typeof setInterval> | null = null;
let openTimer: ReturnType<typeof setTimeout> | null = null;
let busy = false;

function isOnline(): boolean {
  return typeof globalThis.navigator === 'undefined' ? true : globalThis.navigator.onLine !== false;
}

/**
 * One attempt. `force` skips the "same file as last time" shortcut — that is the
 * "Check now" button, where someone wants to be sure rather than efficient.
 */
export async function runExportCheck(options: { force?: boolean } = {}): Promise<ExportCheckResult | null> {
  if (busy) return null;
  busy = true;
  try {
    const result = await checkExports({ ...(options.force ? { force: true } : {}) });
    if (result.imported > 0) {
      const which = EXPORT_KINDS.filter((k) => result.states[k].status === 'imported')
        .map((k) => `${k}: ${result.states[k].detail}`)
        .join(' · ');
      toast('info', 'MYOB exports imported', `${which} at ${formatClock(result.at)}.`);
    } else if (options.force && result.imported === 0) {
      const why =
        result.reason ??
        (EXPORT_KINDS.map((k) => result.states[k].detail)
          .filter((d) => d !== 'same file as last time')
          .join(' · ') || 'nothing to report');
      toast(result.failed > 0 ? 'warn' : 'neutral', result.failed > 0 ? 'Nothing new could be imported' : 'No new export', why);
    }
    return result;
  } catch (error) {
    // The timer must not die because one fetch went wrong, and an unhandled
    // rejection here is invisible on a phone in the yard.
    console.error('[freo] the automatic export check failed', error);
    return null;
  } finally {
    busy = false;
  }
}

async function dueForACheck(): Promise<boolean> {
  const settings = await getSettings();
  if (exportWatchBlocker(settings, isOnline()) !== null) return false;
  const intervalMs = Math.max(1, settings.sources.exports.intervalMinutes) * 60_000;
  const states = await readExportStates();
  const last = Math.max(0, ...EXPORT_KINDS.map((k) => states[k].checkedAt ?? 0));
  return Date.now() - last >= intervalMs;
}

async function tick(): Promise<void> {
  if (busy) return;
  if (await dueForACheck()) await runExportCheck();
}

/** Idempotent: starting a watch that is already running does nothing. */
export function startExportWatch(): void {
  if (timer != null) return;

  openTimer = setTimeout(() => void runExportCheck(), OPEN_DELAY_MS);
  timer = setInterval(() => void tick(), TICK_MS);

  // A device that has just found a signal again is exactly the one that has missed
  // the weekend's exports, so it does not wait for the next tick.
  globalThis.addEventListener?.('online', () => void tick());
  globalThis.addEventListener?.('visibilitychange', () => {
    if (globalThis.document?.visibilityState === 'visible') void tick();
  });
}

export function stopExportWatch(): void {
  if (openTimer != null) clearTimeout(openTimer);
  if (timer != null) clearInterval(timer);
  timer = null;
  openTimer = null;
}

/** Mounted once, by the app shell, while somebody is signed in. */
export function useExportWatch(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    startExportWatch();
    return () => stopExportWatch();
  }, [active]);
}
