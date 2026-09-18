// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@/core/defaults';
import type { Settings } from '@/core/types';
import { db, getSettings, saveSettings } from '@/data/db';
import { FOLDER_REPORT_KEY, type FolderRun } from '@/data/folderPublish';
import type { FolderAccessState, FolderAccessStatus } from '@/data/folderAccess';
import { FolderWatchLine } from '@/screens/SourcesFolder';
import { signInForTests } from './support/who';
import { byText, buttonNamed, click, fieldByLabel, render, settle, typeInto } from './support/render';

/**
 * The line about this computer's own MYOB folder.
 *
 * The rules themselves are tested in `data.folderPublish` against a folder made of
 * objects; the browser permission code is `e2e`'s job. What is tested here is the
 * only thing a person can act on: whether the screen tells them the truth about
 * this machine, and whether the buttons write what they say they write.
 *
 * Four of the five access states can only be reached by lying about the browser,
 * because a headless test has no folder to point at — so the folder module is stood
 * in for, and the lies are the interesting ones.
 */

const { fake } = vi.hoisted(() => {
  const state: { current: FolderAccessState; name: string } = { current: 'none', name: '' };
  return {
    fake: {
      state,
      supports: true,
      choices: 0,
      status(): FolderAccessStatus {
        // The real module answers this before it looks at anything else, and a fake
        // that forgot would test a state no browser can be in.
        const shown: FolderAccessState = fake.supports ? state.current : 'unsupported';
        const detail: Record<FolderAccessState, string> = {
          unsupported: 'this browser cannot open a folder — Chrome or Edge on Windows can',
          none: 'this computer has not been shown a folder yet',
          'needs-a-click': 'Windows will not hand the folder over again until this app is allowed to read it',
          denied: 'the person using this computer said no to the folder',
          ready: `watching ${state.name || 'the folder'}`,
        };
        return { state: shown, folderName: shown === 'unsupported' ? '' : state.name, detail: detail[shown] };
      },
    },
  };
});

vi.mock('@/data/folderAccess', () => ({
  supportsFolders: () => fake.supports,
  folderStatus: async () => fake.status(),
  chooseFolder: async () => {
    fake.choices += 1;
    fake.state.current = 'ready';
    fake.state.name = 'MYOB exports';
    return fake.status();
  },
  requestAccess: async () => {
    fake.state.current = 'ready';
    fake.state.name = 'MYOB exports';
    return fake.status();
  },
  forgetFolder: async () => {
    fake.state.current = 'none';
    fake.state.name = '';
    return fake.status();
  },
}));

const { runFolderLook } = vi.hoisted(() => ({
  runFolderLook: vi.fn(async () => ({ at: 0, ran: true, reason: null, looks: [], published: 0, held: 0 })),
}));
vi.mock('@/app/folderWatch', () => ({ runFolderLook }));

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

const NOTHING_SEEN: FolderRun = { at: 0, ran: false, reason: 'the folder watch is switched off on this computer', looks: [], published: 0, held: 0 };

async function watchingSettings(): Promise<Settings> {
  return saveSettings({
    deviceName: 'Shop PC',
    sources: { exports: { folder: { ...DEFAULT_SETTINGS.sources.exports.folder, enabled: true } } },
  });
}

async function writeReport(report: FolderRun): Promise<void> {
  await db.meta.put({ key: FOLDER_REPORT_KEY, value: report });
}

function publishedReport(): FolderRun {
  return {
    at: Date.now(),
    ran: true,
    reason: null,
    published: 2,
    held: 0,
    looks: [
      {
        kind: 'location',
        outcome: {
          action: 'published',
          fileName: 'location.xlsx',
          path: 'exports/location.xlsx',
          rows: 2691,
          sha: 'abc',
          detail: 'location.xlsx went to exports/location.xlsx and imported 2,691 rows here',
        },
      },
      {
        kind: 'future',
        outcome: {
          action: 'published',
          fileName: 'future.xlsx',
          path: 'exports/future.xlsx',
          rows: 411,
          sha: 'def',
          detail: 'future.xlsx went to exports/future.xlsx and imported 411 rows here',
        },
      },
    ],
  };
}

async function folderSettings(): Promise<Settings> {
  return getSettings();
}

beforeEach(async () => {
  fake.state.current = 'none';
  fake.state.name = '';
  fake.supports = true;
  fake.choices = 0;
  runFolderLook.mockClear();
  await Promise.all([db.meta.clear(), db.events.clear()]);
  await saveSettings(structuredClone(DEFAULT_SETTINGS));
  signInForTests('maker');
});

describe('what this computer says about its folder', () => {
  it('says nothing on the data screen until there is something to say', async () => {
    // The screen is opened to read a table, and `e2e/layout.spec.ts` measures what
    // may stand above it. A watch that has never been set up says nothing here —
    // Settings is where it is found.
    const { host } = render(<FolderWatchLine settings={await watchingSettings()} canWrite />);
    await settle();
    expect(host.innerHTML).toBe('');
  });

  it('says plainly on Settings when this browser cannot open a folder', async () => {
    fake.supports = false;
    const { host } = render(
      <FolderWatchLine settings={await watchingSettings()} canWrite variant="card" />,
    );
    await settle();
    expect(host.querySelector('[data-folder-state="unsupported"]')).not.toBeNull();
    expect(byText(host, 'Cannot watch folders')).toBeTruthy();
    // The explanation is one click away, not a paragraph on the screen: this state
    // is normal on Firefox and it must not shout at people who cannot change it.
    openFolderDetails(host);
    expect(byText(host, 'Firefox and Safari will not let any website see a disk')).toBeTruthy();
    expect([...host.querySelectorAll('button')].map((b) => b.textContent)).not.toContain('Choose the folder');
  });

  it('offers the folder when this computer has not been shown one', async () => {
    const { host } = render(
      <FolderWatchLine settings={await watchingSettings()} canWrite variant="card" />,
    );
    await settle();
    // On Settings it always shows itself; on the data screen it stays out of the way.
    expect(host.querySelector('[data-folder-quiet]')).not.toBeNull();
    expect(host.querySelector('[data-folder-state="none"]')).not.toBeNull();
    click(buttonNamed(host, 'Choose the folder'));
    await waitFor(async () => fake.choices === 1, 'the picker to be called');
    // Choosing it is the opt-in: no second switch to find afterwards.
    const settings = await folderSettings();
    expect(settings.sources.exports.folder.enabled).toBe(true);
  });

  it('asks for one click when Windows wants proving again', async () => {
    fake.state.current = 'needs-a-click';
    fake.state.name = 'MYOB exports';
    const { host } = render(<FolderWatchLine settings={await watchingSettings()} canWrite />);
    await settle();
    expect(byText(host, 'Waiting for one click')).toBeTruthy();
    click(buttonNamed(host, 'Let this app read it'));
    await waitFor(async () => fake.state.current === 'ready', 'the re-ask');
  });

  it('says what it is watching, and how often', async () => {
    fake.state.current = 'ready';
    fake.state.name = 'MYOB exports';
    const { host } = render(<FolderWatchLine settings={await watchingSettings()} canWrite />);
    await settle();
    expect(byText(host, 'MYOB exports')).toBeTruthy();
    expect(byText(host, 'every 1 min')).toBeTruthy();
  });

  it('says the switch is off without pretending the folder is the problem', async () => {
    fake.state.current = 'ready';
    fake.state.name = 'MYOB exports';
    const { host } = render(<FolderWatchLine settings={await getSettings()} canWrite />);
    await settle();
    expect(byText(host, 'watching is off')).toBeTruthy();
    click(buttonNamed(host, 'Start watching'));
    await waitFor(async () => (await folderSettings()).sources.exports.folder.enabled, 'the switch to be turned on');
  });

  it('looks again when asked, and pauses when told', async () => {
    fake.state.current = 'ready';
    fake.state.name = 'MYOB exports';
    const { host } = render(<FolderWatchLine settings={await watchingSettings()} canWrite />);
    await settle();
    click(buttonNamed(host, 'Look now'));
    expect(runFolderLook).toHaveBeenCalledWith({ force: true });
    click(buttonNamed(host, 'Pause'));
    await waitFor(async () => !(await folderSettings()).sources.exports.folder.enabled, 'the pause to be saved');
  });

  it('says when the last file went out', async () => {
    fake.state.current = 'ready';
    fake.state.name = 'MYOB exports';
    await writeReport(publishedReport());
    const { host } = render(<FolderWatchLine settings={await watchingSettings()} canWrite />);
    await settle();
    expect(host.querySelector('[data-folder-last-publish]')).not.toBeNull();
    expect(byText(host, 'last sent')).toBeTruthy();
  });

  it('shows both files and what the last look made of each', async () => {
    fake.state.current = 'ready';
    fake.state.name = 'MYOB exports';
    await writeReport(publishedReport());
    const { host } = render(<FolderWatchLine settings={await watchingSettings()} canWrite />);
    await settle();
    openFolderDetails(host);
    const stock = host.querySelector('[data-folder-kind="location"]');
    const jobs = host.querySelector('[data-folder-kind="future"]');
    expect(stock?.textContent).toContain('location.xlsx went to exports/location.xlsx');
    expect(stock?.textContent).toContain('Sent');
    expect(jobs?.textContent).toContain('future.xlsx went to exports/future.xlsx');
  });

  it('offers the differently-named file rather than guessing', async () => {
    fake.state.current = 'ready';
    fake.state.name = 'MYOB exports';
    await writeReport({
      at: Date.now(),
      ran: true,
      reason: null,
      published: 0,
      held: 1,
      looks: [
        {
          kind: 'location',
          outcome: {
            action: 'needs-a-name',
            fileName: 'Item List [Summary] 18-09-2026.xlsx',
            detail: 'the folder holds Item List [Summary] 18-09-2026.xlsx, which looks like the stock export but is not called location.xlsx',
            candidates: [{ name: 'Item List [Summary] 18-09-2026.xlsx', sizeBytes: 4096, modifiedAt: Date.now() }],
          },
        },
        { kind: 'future', outcome: { action: 'unchanged', fileName: 'future.xlsx', detail: 'nothing new since the last look' } },
      ],
    });
    const { host } = render(<FolderWatchLine settings={await watchingSettings()} canWrite />);
    await settle();
    openFolderDetails(host);
    const panel = host.querySelector('[data-folder-kind="location"]');
    expect(panel?.textContent).toContain('looks like the stock export');
    click(buttonNamed(host, 'Use Item List [Summary] 18-09-2026.xlsx'));
    await waitFor(
      async () => (await folderSettings()).sources.exports.folder.locationFile === 'Item List [Summary] 18-09-2026.xlsx',
      'the name to be saved',
    );
    // And it does not wait a minute to try the name it was just given.
    expect(runFolderLook).toHaveBeenCalledWith({ force: true });
  });

  it('lets the file names and the age be changed here', async () => {
    fake.state.current = 'ready';
    fake.state.name = 'MYOB exports';
    await writeReport(NOTHING_SEEN);
    const { host } = render(<FolderWatchLine settings={await watchingSettings()} canWrite />);
    await settle();
    openFolderDetails(host);
    const name = fieldByLabel(host, 'Name this computer looks for');
    typeInto(name, 'location-2026.xlsx');
    act(() => {
      // React's onBlur is `focusout`: dispatching a plain `blur` leaves the field
      // looking untouched, which is exactly how a real person's jump to the next
      // control would behave if the handler were wired to the wrong event.
      name.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    await waitFor(async () => (await folderSettings()).sources.exports.folder.locationFile === 'location-2026.xlsx', 'the name');

    const age = fieldByLabel(host, 'How old a file may be');
    typeInto(age, '6');
    await waitFor(async () => (await folderSettings()).sources.exports.folder.maxAgeHours === 6, 'the age');
  });

  it('forgets the folder when asked, so the next person starts clean', async () => {
    fake.state.current = 'ready';
    fake.state.name = 'MYOB exports';
    const { host } = render(<FolderWatchLine settings={await watchingSettings()} canWrite />);
    await settle();
    openFolderDetails(host);
    click(buttonNamed(host, 'Forget this folder'));
    await waitFor(async () => fake.state.current === 'none', 'the folder to be forgotten');
  });

  it('shows a viewer the truth and no controls', async () => {
    fake.state.current = 'ready';
    fake.state.name = 'MYOB exports';
    await writeReport(publishedReport());
    const { host } = render(<FolderWatchLine settings={await watchingSettings()} canWrite={false} />);
    await settle();
    openFolderDetails(host);
    const names = [...host.querySelectorAll('button')].map((b) => b.textContent ?? '');
    expect(names).not.toContain('Look now');
    expect(names).not.toContain('Pause');
    expect(names).not.toContain('Forget this folder');
    // Still told what is happening: a viewer who cannot see the state assumes the worst.
    expect(byText(host, 'MYOB exports')).toBeTruthy();
  });
});

/** The hidden half: paths, per-file lines, the age. */
function openFolderDetails(host: HTMLElement): void {
  click(buttonNamed(host, 'Details'));
}
