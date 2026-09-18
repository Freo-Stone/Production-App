// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@/core/defaults';
import { db, getSettings, saveSettings } from '@/data/db';
import { blankExportState, type ExportStateMap } from '@/data/exportSync';
import { AutoImportBar } from '@/screens/SourcesAutoImport';
import { signInForTests } from './support/who';
import { byText, buttonNamed, click, fieldByLabel, render, settle, typeInto, type Rendered } from './support/render';

/**
 * The line that tells the shop whether MYOB's numbers arrived on their own. What
 * is worth testing is the wiring in both directions: what a change writes into
 * Settings, and what a check leaves on screen. Whether GitHub answers is
 * `data.exportSync`'s problem, so the check itself is stood in for.
 *
 * It shows one line and hides the rest behind Details, so the tests that care
 * about the hidden half open it first — which is what a person does too.
 */
const { runExportCheck } = vi.hoisted(() => ({
  runExportCheck: vi.fn(async () => ({ at: 0, ran: true, reason: null, imported: 0, failed: 0 })),
}));
vi.mock('@/app/exportWatch', () => ({ runExportCheck }));

// Relative to the real clock, because the card says "4 min ago" and a fixed
// timestamp would read as a date from last year by the time anyone ran this.
const NOW = Date.now();

function states(): ExportStateMap {
  return {
    location: {
      ...blankExportState('location'),
      path: 'exports/location.xlsx',
      sha: 'sha-stock-1',
      status: 'imported',
      detail: '2,342 rows from location.xlsx',
      bytes: 92 * 1024,
      rows: 2342,
      checkedAt: NOW - 4 * 60_000,
      importedAt: NOW - 4 * 60_000,
    },
    future: {
      ...blankExportState('future'),
      path: 'exports/future.xlsx',
      sha: null,
      status: 'failed',
      detail: 'future.xlsx: expected a MYOB report (Sales [Item Detail])',
      bytes: null,
      rows: null,
      // Two days old: the age and the failure are two different facts, and the
      // line has to carry both.
      checkedAt: NOW - 2 * 86_400_000,
      importedAt: null,
    },
  };
}

/** `waitUntil` polls a synchronous predicate; reading IndexedDB is not one. */
async function waitFor(what: () => Promise<boolean>, describe: string, timeoutMs = 4_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    if (await what()) return;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${describe}`);
  }
}

/** Open the half that is hidden by default: the paths, the interval, the detail. */
function openDetails(host: HTMLElement): void {
  click(buttonNamed(host, 'Details'));
}

async function renderCard(canWrite: boolean, blocker?: string | null): Promise<Rendered> {
  const settings = await getSettings();
  const host = render(
    <AutoImportBar
      settings={settings}
      states={states()}
      canWrite={canWrite}
      {...(blocker !== undefined ? { blocker } : {})}
    />,
  );
  await settle();
  return host;
}

beforeEach(async () => {
  runExportCheck.mockClear();
  await Promise.all([db.meta.clear(), db.products.clear(), db.events.clear()]);
  await saveSettings(structuredClone(DEFAULT_SETTINGS));
  signInForTests('maker');
});

describe('the automatic import line', () => {
  it('says what each file did, in the words the shop reads', async () => {
    const { host } = await renderCard(true);

    // The one-line answer, without opening anything.
    expect(byText(host, 'Imported')).toBeTruthy();
    expect(byText(host, 'location.xlsx')).toBeTruthy();
    expect(byText(host, 'Could not import')).toBeTruthy();

    openDetails(host);
    await settle();

    expect(byText(host, 'Stock export')).toBeTruthy();
    expect(byText(host, '2,342 rows')).toBeTruthy();
    expect(byText(host, '92 KB')).toBeTruthy();
    expect(byText(host, 'checked 4 min ago')).toBeTruthy();

    // The failure names the file and what was wrong with it, not "an error", and
    // still says when it last looked.
    expect(byText(host, 'Could not import')).toBeTruthy();
    expect(byText(host, 'expected a MYOB report')).toBeTruthy();
    expect(byText(host, 'checked 2 days ago')).toBeTruthy();
  });

  it('writes the interval back to Settings', async () => {
    const { host } = await renderCard(true);
    openDetails(host);
    await settle();
    const select = host.querySelector('select');
    if (!(select instanceof HTMLSelectElement)) throw new Error('no interval control on screen');

    act(() => {
      select.value = '60';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    await waitFor(async () => (await getSettings()).sources.exports.intervalMinutes === 60, 'the hour interval');
  });

  it('writes a changed path back to Settings, so the mirror can be pointed somewhere else', async () => {
    const { host } = await renderCard(true);
    openDetails(host);
    await settle();
    const path = fieldByLabel(host, 'Path in the repository');

    typeInto(path, 'exports/stock this week.xlsx');

    await waitFor(
      async () => (await getSettings()).sources.exports.locationPath === 'exports/stock this week.xlsx',
      'the new stock path',
    );
  });

  it('switches automatic import off, and the setting stays off', async () => {
    const { host } = await renderCard(true);
    const toggle = host.querySelector('[role="switch"]');
    if (!toggle) throw new Error('no switch on screen');
    expect(toggle.getAttribute('aria-checked')).toBe('true');

    click(toggle);

    await waitFor(async () => (await getSettings()).sources.exports.autoImport === false, 'the switch to be off');
  });

  it('asks for a check when the button is pressed', async () => {
    const { host } = await renderCard(true);

    click(buttonNamed(host, 'Check now'));
    await settle();

    expect(runExportCheck).toHaveBeenCalledTimes(1);
    expect(runExportCheck).toHaveBeenCalledWith({ force: true });
  });

  it('gives a viewer the answer and nothing to change', async () => {
    const { host } = await renderCard(false);

    expect(byText(host, 'Imported')).toBeTruthy();
    // Nothing to trigger a check, and no switch to move.
    expect(() => buttonNamed(host, 'Check now')).toThrow();
    expect(host.querySelectorAll('[role="switch"]').length).toBe(0);

    // The paths are readable facts, so opening details shows them as text.
    openDetails(host);
    await settle();
    expect(byText(host, 'exports/location.xlsx')).toBeTruthy();
    expect(host.querySelectorAll('input').length).toBe(0);
    expect(host.querySelectorAll('select').length).toBe(0);
  });
  it('says why it is not checking, and where to fix it', async () => {
    // The complaint this exists to answer: the switch said On, both chips said
    // "Not checked", and the screen had no third thing — the reason.
    const h = await renderCard(true, 'this device has no repository token');
    expect(byText(h.host, 'Not checking')).toBeTruthy();
    expect(byText(h.host, 'this device has no repository token')).toBeTruthy();

    // One control, reason and way out in it: the row shares a line with the table.
    click(buttonNamed(h.host, '— Settings'));
    expect(window.location.hash).toBe('#/settings');
    h.unmount();
  });

  it('says the fix as well as the reason, under Details', async () => {
    const h = await renderCard(true, 'this device has no repository token');
    openDetails(h.host);
    await settle();
    expect(byText(h.host, 'Test connection')).toBeTruthy();
    expect(byText(h.host, 'Each device needs its own')).toBeTruthy();
    h.unmount();
  });

  it('stays out of the way when the device can check', async () => {
    const h = await renderCard(true, null);
    expect(h.host.textContent ?? '').not.toContain('Not checking');
    expect(h.host.textContent ?? '').not.toContain('— Settings');
    h.unmount();
  });
});
