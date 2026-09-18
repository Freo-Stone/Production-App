// @vitest-environment node
import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@/core/defaults';
import { db, getSettings, latestJobsSnapshot, latestStockSnapshot, saveSettings } from '@/data/db';
import { ConflictError } from '@/data/github';
import { setDeviceToken } from '@/data/auth';
import {
  checkFolder,
  clearFolderPublishMap,
  folderBlockerReason,
  readFolderPublishMap,
  type ExportPublisher,
  type FolderRun,
} from '@/data/folderPublish';
import type { FolderAccessStatus, FolderSource } from '@/data/folderAccess';
import { gitBlobSha, type FolderFile } from '@/core/folderSource';
import { readExportStates } from '@/data/exportSync';
import type { Settings } from '@/core/types';
import { banner, workbookBytes } from './support/buildWorkbook';
import { signInForTests, signOutForTests } from './support/who';

/**
 * One computer finding a new MYOB export in its folder and telling the shop about
 * it. The assertions that matter are the ones about what does *not* happen: no
 * bytes read when nothing changed, no half-written file sent, no wrong report sent,
 * no second copy of the same bytes, and no publish that leaves the computer that
 * just imported the file looking backwards.
 */

const NOW = Date.parse('2026-09-18T07:00:00+08:00');
const FRESH = NOW - 60_000;
const LOCATION = 'exports/location.xlsx';
const FUTURE = 'exports/future.xlsx';

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

/* ── The folder, made of objects ───────────────────────────────────────────── */

class FakeFolder implements FolderSource {
  /** name → what the folder says about it. */
  holding = new Map<string, { bytes: Uint8Array; modifiedAt: number }>();
  access: FolderAccessStatus = { state: 'ready', folderName: 'MYOB exports', detail: 'watching MYOB exports' };
  /** Which files this folder was asked to hand over. Bytes are only read when the rules ask. */
  reads: string[] = [];

  add(name: string, bytes: Uint8Array, modifiedAt = FRESH): void {
    this.holding.set(name, { bytes, modifiedAt });
  }

  touch(name: string, modifiedAt: number): void {
    const found = this.holding.get(name);
    if (found != null) found.modifiedAt = modifiedAt;
  }

  replace(name: string, bytes: Uint8Array, modifiedAt = FRESH): void {
    this.holding.set(name, { bytes, modifiedAt });
  }

  remove(name: string): void {
    this.holding.delete(name);
  }

  async status(): Promise<FolderAccessStatus> {
    return this.access;
  }

  async list(): Promise<FolderFile[]> {
    return [...this.holding.entries()].map(([name, entry]) => ({
      name,
      sizeBytes: entry.bytes.byteLength,
      modifiedAt: entry.modifiedAt,
    }));
  }

  async read(name: string): Promise<Uint8Array | null> {
    this.reads.push(name);
    return this.holding.get(name)?.bytes ?? null;
  }
}

/* ── The repository, also made of objects ──────────────────────────────────── */

class FakePublishRepo implements ExportPublisher {
  /** path → the sha the server says it holds. */
  entries = new Map<string, string>();
  writes: { path: string; bytes: Uint8Array; sha: string | null; message: string }[] = [];
  /** One 409, to prove the retry writes against the sha the other PC left. */
  conflictsFirst = 0;

  async getEntrySha(path: string): Promise<string | null> {
    return this.entries.get(path) ?? null;
  }

  async putBinaryFile(path: string, bytes: Uint8Array, sha: string | null, message: string): Promise<{ sha: string }> {
    if (this.conflictsFirst > 0) {
      this.conflictsFirst -= 1;
      // The other computer's commit lands first, which is what the server would be
      // holding when the loser asks for the sha again.
      this.entries.set(path, 'sha-someone-else');
      throw new ConflictError(`${path} changed`, 'sha-someone-else', '{}');
    }
    this.writes.push({ path, bytes, sha, message });
    // GitHub reports the *content* sha of what it just committed, which is the git
    // blob sha — the very number the watch computes. A fake that invented its own
    // would let "these bytes are already there" pass in tests and fail on a real PC.
    const written = await gitBlobSha(bytes, sha1);
    this.entries.set(path, written);
    return { sha: written };
  }
}

async function sha1(joined: Uint8Array): Promise<string> {
  const digest = await webcrypto.subtle.digest('SHA-1', joined as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function ledger(action: string) {
  return (await db.events.toArray()).filter((e) => e.action === action);
}

async function watching(): Promise<Settings> {
  const settings = await getSettings();
  const patched = await saveSettings({
    deviceName: 'Shop PC',
    sync: { ...settings.sync, githubOwner: 'Freo-Stone', githubRepo: 'Production-App-Data', githubBranch: 'main' },
    sources: { exports: { folder: { ...DEFAULT_SETTINGS.sources.exports.folder, enabled: true } } },
  });
  return patched;
}

async function bothFilesInFolder(): Promise<FakeFolder> {
  const folder = new FakeFolder();
  folder.add('location.xlsx', stockBytes());
  folder.add('future.xlsx', jobsBytes());
  return folder;
}

async function look(folder: FakeFolder, repo: FakePublishRepo, force = false): Promise<FolderRun> {
  return checkFolder({
    source: folder,
    publisher: repo,
    digest: sha1,
    now: () => NOW,
    ...(force ? { force: true } : {}),
  });
}

async function outcomeOf(run: FolderRun, kind: 'location' | 'future') {
  return run.looks.find((l) => l.kind === kind)?.outcome;
}

beforeEach(async () => {
  await Promise.all([
    db.products.clear(),
    db.batches.clear(),
    db.events.clear(),
    db.meta.clear(),
    db.stockSnapshots.clear(),
    db.stockRows.clear(),
    db.jobsSnapshots.clear(),
    db.jobRows.clear(),
  ]);
  await saveSettings(structuredClone(DEFAULT_SETTINGS));
  await clearFolderPublishMap();
  await setDeviceToken('ghp_test');
  signInForTests('maker');
});

describe('a computer that finds a new export in its folder', () => {
  it('sends both reports and imports them here', async () => {
    await watching();
    const folder = await bothFilesInFolder();
    const repo = new FakePublishRepo();

    const run = await look(folder, repo);
    expect(run.ran).toBe(true);
    expect(run.published).toBe(2);
    expect(repo.writes.map((w) => w.path).sort()).toEqual([FUTURE, LOCATION]);

    // The machine that has the file uses it itself — it should not have to wait for
    // the pull it just caused.
    expect(await latestStockSnapshot()).not.toBeNull();
    expect(await latestJobsSnapshot()).not.toBeNull();

    const message = repo.writes.find((w) => w.path === LOCATION)?.message ?? '';
    expect(message).toContain('exports/location.xlsx');
    expect(message).toContain('Shop PC');
    expect(message).toContain('2 rows');
  });

  it('leaves the pull loop knowing these bytes are already here', async () => {
    // Without this, the next automatic check would fetch the copy that was in the
    // repository *before* the publish and write an older snapshot over the fresh one.
    await watching();
    const folder = await bothFilesInFolder();
    const repo = new FakePublishRepo();
    await look(folder, repo);

    const states = await readExportStates();
    expect(states.location.sha).toBe(await gitBlobSha(stockBytes(), sha1));
    expect(states.location.status).toBe('imported');
    expect(states.location.detail).toContain('on this PC');
  });

  it('says so in the log, naming the machine', async () => {
    await watching();
    const folder = await bothFilesInFolder();
    await look(folder, new FakePublishRepo());
    const rows = await ledger('export.publish');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toContain('Shop PC published');
    expect(rows[0]?.detail).toContain(LOCATION);
    expect(rows[0]?.detail).toContain(FUTURE);
  });

  it('asks nothing of the repository when the folder has not changed', async () => {
    await watching();
    const folder = await bothFilesInFolder();
    const repo = new FakePublishRepo();
    await look(folder, repo);
    repo.writes = [];

    const second = await look(folder, repo);
    expect(second.published).toBe(0);
    expect(repo.writes).toHaveLength(0);
    // Not even the bytes: they are megabytes, and OneDrive may not have them locally.
    expect(folder.reads).toEqual(['location.xlsx', 'future.xlsx']);
    // And no sha lookup either — the fingerprint already answered the question.
    expect(second.looks.every((l) => l.outcome.action === 'unchanged')).toBe(true);
  });

  it('publishes again when the file is written again with different numbers', async () => {
    await watching();
    const folder = await bothFilesInFolder();
    const repo = new FakePublishRepo();
    await look(folder, repo);
    repo.writes = [];

    folder.replace('location.xlsx', stockBytes(9_999), FRESH + 120_000);

    // The look that notices the file moved sends nothing; the one after it does.
    // That is the settle rule, and it is what stops a workbook being sent while
    // MYOB is still writing it — one interval of delay is the price.
    const noticing = await look(folder, repo);
    expect((await outcomeOf(noticing, 'location'))?.action).toBe('refused');
    expect(repo.writes).toHaveLength(0);

    const run = await look(folder, repo);
    expect(run.published).toBe(1);
    expect(repo.writes.map((w) => w.path)).toEqual([LOCATION]);

    const stock = await latestStockSnapshot();
    expect(stock?.rows.find((r) => r.code === 'A3')?.qtyOnHandRaw).toBe(9_999);
  });

  it('does not send a file whose size or time is still moving', async () => {
    // MYOB writing straight into the folder, or OneDrive still downloading it. What
    // the folder looked like on the previous look is what catches it, so this needs
    // the file to move between two looks.
    await watching();
    const folder = await bothFilesInFolder();
    const repo = new FakePublishRepo();
    await look(folder, repo);
    expect(repo.writes.filter((w) => w.path === LOCATION)).toHaveLength(1);

    // A new export is being written: a later write time and a different size than
    // the look before is what "still arriving" looks like from the outside.
    const readsBefore = folder.reads.length;
    folder.replace('location.xlsx', stockBytes(9_999), FRESH + 60_000);
    const moving = await look(folder, repo);
    const during = await outcomeOf(moving, 'location');
    expect(during?.action).toBe('refused');
    if (during?.action === 'refused') expect(during.detail).toContain('left alone until it stops moving');
    expect(repo.writes.filter((w) => w.path === LOCATION)).toHaveLength(1);
    // Three megabytes of half-written workbook were not pulled across the disk and
    // the internet to find out nothing could be done with them yet.
    expect(folder.reads.length).toBe(readsBefore);

    // The next look sees exactly what the one before saw — same size, same write
    // time — so the file has stopped moving and can be read.
    const settled = await look(folder, repo);
    expect((await outcomeOf(settled, 'location'))?.action).toBe('published');
    expect(repo.writes.filter((w) => w.path === LOCATION)).toHaveLength(2);
    const stock = await latestStockSnapshot();
    expect(stock?.rows.find((r) => r.code === 'A3')?.qtyOnHandRaw).toBe(9_999);
  });

  it('will not send the other report, and says which one it found', async () => {
    // The failure this feature must never have: jobs numbers in the stock mirror,
    // on every computer at once.
    await watching();
    const folder = await bothFilesInFolder();
    folder.replace('location.xlsx', jobsBytes());
    const repo = new FakePublishRepo();

    const run = await look(folder, repo);
    const location = await outcomeOf(run, 'location');
    expect(location?.action).toBe('refused');
    if (location?.action === 'refused') {
      expect(location.detail).toContain('Sales [Item Detail]');
      expect(location.detail).toContain('nothing was published');
    }
    expect(repo.writes.map((w) => w.path)).toEqual([FUTURE]);
    expect(await latestStockSnapshot()).toBeNull();
    const failures = await ledger('export.failed');
    expect(failures).toHaveLength(1);
  });

  it('will not send a stub, even when the button was pressed', async () => {
    await watching();
    const folder = await bothFilesInFolder();
    folder.replace('location.xlsx', new Uint8Array(12));
    const repo = new FakePublishRepo();

    const run = await look(folder, repo, true);
    const location = await outcomeOf(run, 'location');
    expect(location?.action).toBe('refused');
    if (location?.action === 'refused') expect(location.detail).toContain('12 bytes');
    expect(repo.writes.map((w) => w.path)).toEqual([FUTURE]);
  });

  it('will not send an old file as though it were today’s, but a person may overrule that', async () => {
    await watching();
    const folder = await bothFilesInFolder();
    folder.touch('location.xlsx', NOW - 40 * 3_600_000);
    const repo = new FakePublishRepo();

    const run = await look(folder, repo);
    const location = await outcomeOf(run, 'location');
    expect(location?.action).toBe('refused');
    if (location?.action === 'refused') expect(location.detail).toContain('more than 30 hours ago');
    expect(repo.writes.map((w) => w.path)).toEqual([FUTURE]);

    const forced = await look(folder, new FakePublishRepo(), true);
    expect((await outcomeOf(forced, 'location'))?.action).toBe('published');
  });

  it('does not send the same bytes twice because a file was touched', async () => {
    // Copied into place, or re-stamped by a sync: new timestamp, same workbook.
    await watching();
    const folder = await bothFilesInFolder();
    const repo = new FakePublishRepo();
    await look(folder, repo);
    repo.writes = [];

    folder.touch('location.xlsx', FRESH + 5_000);
    const firstLook = await look(folder, repo);
    // Still-writing on the look that sees the stamp move…
    expect((await outcomeOf(firstLook, 'location'))?.action).toBe('refused');
    const settled = await look(folder, repo);
    expect((await outcomeOf(settled, 'location'))?.action).toBe('unchanged');
    if ((await outcomeOf(settled, 'location'))?.action === 'unchanged') {
      expect((await outcomeOf(settled, 'location'))?.detail).toContain('same bytes');
    }
    expect(repo.writes).toHaveLength(0);
  });

  it('writes again when the other computer got there first', async () => {
    await watching();
    const folder = await bothFilesInFolder();
    const repo = new FakePublishRepo();
    repo.conflictsFirst = 1;

    const run = await look(folder, repo);
    expect(run.published).toBe(2);
    const message = repo.writes.find((w) => w.message.includes('another PC'))?.message ?? '';
    expect(message).toContain('after another PC wrote first');
    // The retry compares against the sha the other machine left, not the one we read
    // before the fight started.
    expect(repo.writes.some((w) => w.sha === 'sha-someone-else')).toBe(true);
  });

  it('imports here when it cannot publish, and says which half failed', async () => {
    // No token on the device: the folder is still this PC's own data.
    const settings = await watching();
    await setDeviceToken('');
    const folder = await bothFilesInFolder();
    const noRepo = new FakePublishRepo();

    // No publisher injected: the code has to build one from the device, and cannot.
    const run = await checkFolder({ source: folder, digest: sha1, now: () => NOW, settings });
    expect(run.published).toBe(0);
    expect(run.held).toBe(2);
    const location = await outcomeOf(run, 'location');
    expect(location?.action).toBe('failed');
    if (location?.action === 'failed') {
      expect(location.detail).toContain('imported here but not published');
      expect(location.detail).toContain('no repository token');
    }
    expect(await latestStockSnapshot()).not.toBeNull();
    expect(noRepo.writes).toHaveLength(0);
  });
});

describe('who is allowed to publish', () => {
  it('does nothing while the watch is switched off on this computer', async () => {
    await saveSettings(structuredClone(DEFAULT_SETTINGS));
    const folder = await bothFilesInFolder();
    const run = await look(folder, new FakePublishRepo());
    expect(run.ran).toBe(false);
    expect(run.reason).toBe('the folder watch is switched off on this computer');
  });

  it('does nothing until somebody points this computer at a folder', async () => {
    await watching();
    const folder = await bothFilesInFolder();
    folder.access = { state: 'needs-a-click', folderName: 'MYOB exports', detail: 'needs one click' };
    const run = await look(folder, new FakePublishRepo());
    expect(run.ran).toBe(false);
    expect(run.reason).toBe('this computer has not been shown the folder yet');
  });

  it('does nothing for a viewer, without making a fuss', async () => {
    await watching();
    signInForTests('viewer');
    const folder = await bothFilesInFolder();
    const run = await look(folder, new FakePublishRepo());
    expect(run.ran).toBe(false);
    expect(run.reason).toBe('this device is signed in as a viewer');
  });

  it('does nothing with no signal', async () => {
    const settings = await watching();
    expect(folderBlockerReason(settings, true, false)).toBe('this device is offline');
    expect(folderBlockerReason(settings, true, true)).toBeNull();
    expect(folderBlockerReason(settings, false, true)).toBe('this computer has not been shown the folder yet');
  });

  it('will not publish when the sign-in has gone altogether', async () => {
    await watching();
    signOutForTests();
    const folder = await bothFilesInFolder();
    const run = await look(folder, new FakePublishRepo());
    expect(run.ran).toBe(false);
  });
});

describe('a folder that does not use the names in Settings', () => {
  it('offers a file that only looks right, rather than using it', async () => {
    // Guessing here overwrites the wrong mirror on every computer at once.
    await watching();
    const folder = new FakeFolder();
    folder.add('Item List [Summary] 18-09-2026.xlsx', stockBytes());
    const repo = new FakePublishRepo();

    const run = await look(folder, repo);
    const location = await outcomeOf(run, 'location');
    expect(location?.action).toBe('needs-a-name');
    if (location?.action === 'needs-a-name') {
      expect(location.detail).toContain('Item List [Summary] 18-09-2026.xlsx');
      expect(location.detail).toContain('not called location.xlsx');
    }
    expect(repo.writes).toHaveLength(0);
    expect(folder.reads).toHaveLength(0);
  });

  it('publishes that same file once Settings is told its name', async () => {
    await saveSettings({ sources: { exports: { folder: { ...DEFAULT_SETTINGS.sources.exports.folder, enabled: true, locationFile: 'Item List [Summary] 18-09-2026.xlsx' } } } });
    const folder = new FakeFolder();
    folder.add('Item List [Summary] 18-09-2026.xlsx', stockBytes());
    const repo = new FakePublishRepo();

    const run = await look(folder, repo);
    expect((await outcomeOf(run, 'location'))?.action).toBe('published');
    expect(repo.writes.map((w) => w.path)).toEqual([LOCATION]);
  });

  it('asks a person to choose when two files both look right', async () => {
    await watching();
    const folder = new FakeFolder();
    folder.add('Sales item detail 18-09-2026.xlsx', jobsBytes());
    folder.add('Sales item detail 12-09-2026.xlsx', jobsBytes(1));
    const run = await look(folder, new FakePublishRepo());
    const future = await outcomeOf(run, 'future');
    expect(future?.action).toBe('needs-a-name');
    if (future?.action === 'needs-a-name') {
      expect(future.candidates.map((f) => f.name)).toEqual([
        'Sales item detail 18-09-2026.xlsx',
        'Sales item detail 12-09-2026.xlsx',
      ]);
    }
  });

  it('says the folder does not hold it, and names what is there instead', async () => {
    await watching();
    const folder = new FakeFolder();
    folder.add('location.csv', new Uint8Array(4096));
    const run = await look(folder, new FakePublishRepo());
    const location = await outcomeOf(run, 'location');
    expect(location?.action).toBe('missing');
    if (location?.action === 'missing') expect(location.detail).toContain('nothing in the folder called location.xlsx');
  });

  it('complains about a name that was cleared out of Settings', async () => {
    await saveSettings({ sources: { exports: { folder: { ...DEFAULT_SETTINGS.sources.exports.folder, enabled: true, locationFile: '   ' } } } });
    const folder = await bothFilesInFolder();
    const run = await look(folder, new FakePublishRepo());
    const location = await outcomeOf(run, 'location');
    expect(location?.action).toBe('missing');
    if (location?.action === 'missing') expect(location.detail).toContain('no location file name is set');
  });
});

describe('what the next look remembers', () => {
  it('keeps what it published, so a restart does not republish it', async () => {
    await watching();
    const folder = await bothFilesInFolder();
    await look(folder, new FakePublishRepo());
    const map = await readFolderPublishMap();
    expect(map.location?.name).toBe('location.xlsx');
    expect(map.location?.sha).toBe(await gitBlobSha(stockBytes(), sha1));
    expect(map.location?.publishedAt).toBe(NOW);
    expect(map.location?.rows).toBe(2);
  });

  it('forgets a record that has no sha in it', async () => {
    await db.meta.put({
      key: 'folder.publish',
      value: { location: { name: 'location.xlsx', sizeBytes: 10, modifiedAt: NOW, sha: '', publishedAt: NOW, rows: null } },
    });
    expect((await readFolderPublishMap()).location).toBeNull();
  });

  it('will not run two looks at once', async () => {
    await watching();
    const folder = await bothFilesInFolder();
    const repo = new FakePublishRepo();
    const [a, b] = await Promise.all([look(folder, repo), look(folder, repo)]);
    // One run, shared: the second caller is told about the first one's work rather
    // than publishing the same file twice.
    expect(a).toBe(b);
    expect(repo.writes).toHaveLength(2);
  });
});
