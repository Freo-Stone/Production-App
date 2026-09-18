// @vitest-environment node
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@/core/defaults';
import type { Settings } from '@/core/types';
import { db, getSettings, latestJobsSnapshot, latestStockSnapshot, saveSettings } from '@/data/db';
import {
  checkExports,
  clearExportStates,
  EXPORT_KINDS,
  exportPaths,
  exportWatchBlocker,
  readExportStates,
  type ExportReader,
  type ExportStateMap,
} from '@/data/exportSync';
import { banner, workbookBytes } from './support/buildWorkbook';
import { signInForTests } from './support/who';

/* ── The two files, as the mirror would leave them ─────────────────────────── */

function stockBytes(qty = 11_861.57): Uint8Array {
  return workbookBytes([
    {
      name: 'Sheet1',
      grid: [
        ...banner('Item List [Summary]'),
        [null, 'Item No.', 'Units On Hand', 'Custom List #3'],
        [null, null],
        [null, 'HQ', 'HQ', null],
        [null, 'A3', qty, 'PAVERS'],
        [null, 'M6', 40, 'PAVERS'],
      ],
    },
  ]);
}

function jobsBytes(qty = 3.15): Uint8Array {
  return workbookBytes([
    {
      name: 'Sheet1',
      grid: [
        ...banner('Sales [Item Detail]'),
        [null, 'Name', 'ID No.', 'Date', 'Quantity', 'Promised Date', 'Ship Via', 'Salesperson'],
        [null, null],
        [null, 'A3', 'SPECIMEN SQUARE 400x400x30mm', null, null, null, null, null],
        [null, 'BROADSIDE LANDSCAPES', '01999001', '9/09/2026', qty, '17/09/2026', 'TAKEN', 'SAMPLE, SAM'],
      ],
    },
  ]);
}

/** A repository that only ever answers "here is the file", with a sha per blob. */
class FakeRepo implements ExportReader {
  calls: string[] = [];
  files = new Map<string, { sha: string; bytes: Uint8Array } | null>();

  put(path: string, bytes: Uint8Array, sha: string): void {
    this.files.set(path, { sha, bytes });
  }

  remove(path: string): void {
    this.files.set(path, null);
  }

  async getBinaryFile(path: string): Promise<{ sha: string; bytes: Uint8Array } | null> {
    this.calls.push(path);
    return this.files.get(path) ?? null;
  }
}

const LOCATION = 'exports/location.xlsx';
const FUTURE = 'exports/future.xlsx';

async function ledger(action: string) {
  return (await db.events.toArray()).filter((e) => e.action === action);
}

async function reset(): Promise<FakeRepo> {
  await Promise.all([
    db.products.clear(),
    db.batches.clear(),
    db.events.clear(),
    db.meta.clear(),
    // The mirrors, or a later test inherits the import the previous one made and a
    // "nothing was imported" assertion quietly means nothing.
    db.stockSnapshots.clear(),
    db.stockRows.clear(),
    db.jobsSnapshots.clear(),
    db.jobRows.clear(),
  ]);
  await saveSettings(structuredClone(DEFAULT_SETTINGS));
  await clearExportStates();
  signInForTests('maker');
  const repo = new FakeRepo();
  repo.put(LOCATION, stockBytes(), 'sha-stock-1');
  repo.put(FUTURE, jobsBytes(), 'sha-jobs-1');
  return repo;
}

/** Settings with a repository named but no token on the device — a fresh install. */
async function configuredSettings(): Promise<Settings> {
  const settings = await getSettings();
  return {
    ...settings,
    sync: { ...settings.sync, githubOwner: 'Freo-Stone', githubRepo: 'Production-App-Data', githubBranch: 'main' },
  };
}

/* ── The checks ────────────────────────────────────────────────────────────── */

describe('automatic export import', () => {
  it('imports both exports on a device that has never seen them', async () => {
    const repo = await reset();

    const run = await checkExports({ client: repo });

    expect(run.ran).toBe(true);
    expect(run.imported).toBe(2);
    expect(readExportStatesAfter(run.states)).toEqual(['imported', 'imported']);
    expect(run.states.location.detail).toMatch(/rows from location\.xlsx/);

    // And the shop's data actually moved.
    const stock = await latestStockSnapshot();
    const jobs = await latestJobsSnapshot();
    expect(stock?.rows).toHaveLength(2);
    expect(jobs?.rows).toHaveLength(1);

    const logged = await ledger('export.import');
    expect(logged).toHaveLength(1);
    expect(logged[0]?.actor).toBe('Test Person');
  });

  it('does nothing when neither file changed, and says so per file', async () => {
    const repo = await reset();
    await checkExports({ client: repo });
    const before = await latestStockSnapshot();
    repo.calls = [];

    const second = await checkExports({ client: repo });

    expect(second.imported).toBe(0);
    expect(readExportStatesAfter(second.states)).toEqual(['unchanged', 'unchanged']);
    expect(second.states.location.detail).toBe('same file as last time');
    // It still looked — that is the whole cost of an unchanged week.
    expect(repo.calls).toEqual([LOCATION, FUTURE]);
    expect((await latestStockSnapshot())?.capturedAt).toBe(before?.capturedAt);
    expect(await ledger('export.import')).toHaveLength(1);
  });

  it('imports only the file that changed', async () => {
    const repo = await reset();
    await checkExports({ client: repo });
    const stockBefore = (await latestStockSnapshot())?.capturedAt;

    repo.put(LOCATION, stockBytes(9_000), 'sha-stock-2');
    const run = await checkExports({ client: repo });

    expect(run.imported).toBe(1);
    expect(run.states.location.status).toBe('imported');
    expect(run.states.future.status).toBe('unchanged');
    expect((await latestStockSnapshot())?.capturedAt).not.toBe(stockBefore);
    expect((await latestStockSnapshot())?.rows[0]?.qtyOnHandRaw).toBe(9_000);
  });

  // A mirror interrupted mid-upload is the ordinary failure here. Marking a file
  // it could not read as already seen would leave the shop on old numbers for good.
  it('retries a file it could not read instead of marking it seen', async () => {
    const repo = await reset();
    await checkExports({ client: repo });
    const stockBefore = await latestStockSnapshot();

    repo.put(LOCATION, new Uint8Array([1, 2, 3, 4, 5]), 'sha-stock-broken');
    const broken = await checkExports({ client: repo });
    expect(broken.states.location.status).toBe('failed');
    expect(broken.states.location.detail).toMatch(/MYOB/);
    expect(broken.states.location.sha).toBe('sha-stock-1');
    expect((await latestStockSnapshot())?.capturedAt).toBe(stockBefore?.capturedAt);
    expect(await ledger('export.failed')).toHaveLength(1);

    // The mirror fixes itself; the next check picks it up without being told.
    repo.put(LOCATION, stockBytes(700), 'sha-stock-3');
    const fixed = await checkExports({ client: repo });
    expect(fixed.states.location.status).toBe('imported');
    expect((await latestStockSnapshot())?.rows[0]?.qtyOnHandRaw).toBe(700);
  });

  it('keeps the last good import when the file goes missing', async () => {
    const repo = await reset();
    await checkExports({ client: repo });
    const before = await latestStockSnapshot();

    repo.remove(LOCATION);
    const run = await checkExports({ client: repo });

    expect(run.states.location.status).toBe('missing');
    expect(run.states.location.detail).toContain(LOCATION);
    expect(run.states.location.sha).toBe('sha-stock-1');
    expect(run.states.location.importedAt).not.toBeNull();
    expect((await latestStockSnapshot())?.capturedAt).toBe(before?.capturedAt);
  });

  it('imports nothing on a device signed in as a viewer, without throwing', async () => {
    const repo = await reset();
    signInForTests('viewer');

    const run = await checkExports({ client: repo });

    expect(run.ran).toBe(false);
    expect(run.reason).toMatch(/viewer/);
    expect(repo.calls).toEqual([]);
    expect(await latestStockSnapshot()).toBeNull();
  });

  it('leaves the files alone when automatic import is off, but a Check now still works', async () => {
    const repo = await reset();
    await saveSettings({ sources: { exports: { autoImport: false } } });

    const off = await checkExports({ client: repo });
    expect(off.ran).toBe(false);
    expect(off.reason).toMatch(/switched off/);
    expect(repo.calls).toEqual([]);

    const forced = await checkExports({ client: repo, force: true });
    expect(forced.imported).toBe(2);
  });

  it('declines on a device with no repository token, and reports why', async () => {
    const repo = await reset();
    // No token in meta and no client handed in: this is what a fresh install is.
    const run = await checkExports({ settings: await configuredSettings() });
    expect(run.ran).toBe(false);
    expect(run.reason).toMatch(/token/);
    expect(repo.calls).toEqual([]);
  });

  it('shares one run between callers who ask at the same moment', async () => {
    const repo = await reset();
    const repoCalls = repo;

    const [a, b] = await Promise.all([checkExports({ client: repoCalls }), checkExports({ client: repoCalls })]);

    // Two runs would have fetched four files and imported the same blobs twice.
    expect(repoCalls.calls).toEqual([LOCATION, FUTURE]);
    expect(a).toBe(b);
  });

  it('persists what it did, so a reload can still tell the shop', async () => {
    const repo = await reset();
    await checkExports({ client: repo });

    const stored = await readExportStates();
    expect(EXPORT_KINDS.every((k) => stored[k].importedAt != null)).toBe(true);

    // The row is a whole record: an older build's half-written state still reads.
    await db.meta.put({ key: 'exports.state', value: { location: { sha: 'x' } } });
    const repaired = await readExportStates();
    expect(repaired.location.status).toBe('never');
    expect(repaired.location.kind).toBe('location');
    expect(repaired.future.status).toBe('never');
  });
});

describe('whether a check is worth starting', () => {
  it('says the reason in the words the screen shows', async () => {
    await reset();
    const settings = await getSettings();
    const off: Settings = {
      ...settings,
      sources: { ...settings.sources, exports: { ...settings.sources.exports, autoImport: false } },
    };

    expect(exportWatchBlocker(settings)).toBeNull();
    expect(exportWatchBlocker(settings, false)).toBe('this device is offline');
    expect(exportWatchBlocker(off)).toBe('automatic import is switched off');

    signInForTests('viewer');
    expect(exportWatchBlocker(settings)).toBe('this device is signed in as a viewer');
  });

  it('takes the paths from Settings, trimmed, so a stray space is not a missing file', async () => {
    await reset();
    const settings = await getSettings();
    const withPaths = {
      ...settings,
      sources: {
        ...settings.sources,
        exports: { ...settings.sources.exports, locationPath: '  exports/loc.xlsx  ', futurePath: '' },
      },
    } as Settings;

    expect(exportPaths(withPaths)).toEqual({ location: 'exports/loc.xlsx', future: '' });
  });
});

/** The two statuses, in the order the card shows them. */
function readExportStatesAfter(states: ExportStateMap): string[] {
  return EXPORT_KINDS.map((k) => states[k].status);
}
