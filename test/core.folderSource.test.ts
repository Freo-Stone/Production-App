// @vitest-environment node
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatClock, formatDayFull } from '@/core/dates';
import { DEFAULT_SETTINGS } from '@/core/defaults';
import {
  MIN_EXPORT_BYTES,
  ageInHours,
  blobHeader,
  decidePublish,
  findExactFile,
  folderRules,
  gitBlobSha,
  hintMatches,
  isSameFile,
  isWorkbookName,
  pickFolderFile,
  publishCommitMessage,
  type FolderFile,
} from '@/core/folderSource';

/**
 * The rules that decide whether a folder watch is allowed to write to the
 * repository everybody else reads. The two that would cost the shop real money if
 * they were wrong are the settle rule (half a workbook published as if it were a
 * report) and the sha compare (a watch that could not tell "changed" from "touched"
 * fills the repository's history with duplicate megabytes), so both are checked
 * against the shop's own workbooks rather than against made-up numbers.
 */

const root = fileURLToPath(new URL('..', import.meta.url));

async function sha1(joined: Uint8Array): Promise<string> {
  const digest = await webcrypto.subtle.digest('SHA-1', joined as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function file(overrides: Partial<FolderFile> = {}): FolderFile {
  const now = Date.parse('2026-09-18T07:00:00+08:00');
  return { name: 'location.xlsx', sizeBytes: 2_400_000, modifiedAt: now - 60_000, ...overrides };
}

const NOW = Date.parse('2026-09-18T07:00:00+08:00');

describe('the sha the repository compares against', () => {
  it('is the number git hash-object prints for the shop’s own exports', async () => {
    // These two values came out of `git hash-object` in the repo, not out of this
    // code. If the header or the join is wrong, the compare silently never
    // matches — every tick republishes the same workbook — and this is the only
    // place that would show up.
    const cases = [
      { path: 'test/fixtures/real/location.xlsx', sha: '24a217a7a0947470f630cfe7072e3bc04e8c91bf' },
      { path: 'test/fixtures/real/future.xlsx', sha: '259fcd96f406f492ec25328fa6505ef512370935' },
    ];
    for (const { path, sha } of cases) {
      const bytes = new Uint8Array(readFileSync(`${root}/${path}`));
      await expect(gitBlobSha(bytes, sha1)).resolves.toBe(sha);
    }
  });

  it('puts the byte count in the header, not the character count', () => {
    // A multibyte workbook would be the only way to get this wrong, hence the
    // explicit bytes rather than a string.
    expect(new TextDecoder().decode(blobHeader(413))).toBe('blob 413\0');
  });

  it('gives an empty file the sha of an empty blob', async () => {
    // `git hash-object /dev/null` is e69de29… — the well-known empty-blob sha, and
    // a check that nothing is being added to what gets hashed.
    expect(await gitBlobSha(new Uint8Array(0), sha1)).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  });
});

describe('whether these bytes should go to the repository', () => {
  const base = {
    kind: 'location' as const,
    file: file(),
    lastSeen: null,
    localSha: 'abc',
    publishedSha: null,
    sameFingerprint: false,
    now: NOW,
    maxAgeHours: 30,
  };

  it('publishes a file that is new to this PC', () => {
    expect(decidePublish(base).action).toBe('publish');
  });

  it('says so when the folder does not hold the file', () => {
    const decision = decidePublish({ ...base, file: null });
    expect(decision.action).toBe('missing');
    expect(decision.detail).toContain('nothing in the folder');
  });

  it('leaves a file alone while its size or time keeps moving', () => {
    const decision = decidePublish({ ...base, lastSeen: file({ sizeBytes: 1_000_000 }) });
    expect(decision.action).toBe('still-writing');
    // The numbers are in the sentence: "still writing" without the sizes is a
    // riddle when the file is in fact a different report entirely.
    expect(decision.detail).toContain('1,000,000');
    expect(decision.detail).toContain('2,400,000');
  });

  it('publishes again once two looks agree', () => {
    expect(decidePublish({ ...base, lastSeen: file() }).action).toBe('publish');
  });

  it('refuses a stub, and does not care that a button was pressed', () => {
    const tiny = file({ sizeBytes: 12 });
    expect(decidePublish({ ...base, file: tiny }).action).toBe('too-small');
    // A deliberate publish cannot make a 12-byte file into a report. Every other
    // computer would then have no stock numbers to read.
    expect(decidePublish({ ...base, file: tiny, force: true }).action).toBe('too-small');
  });

  it('refuses an old file, and lets a person overrule that one', () => {
    const stale = file({ modifiedAt: NOW - 40 * 3_600_000 });
    const decision = decidePublish({ ...base, file: stale });
    expect(decision.action).toBe('too-old');
    expect(decision.detail).toContain('more than 30 hours ago');
    // Overrulable because a shop that exports once a fortnight is a real shop, and
    // the person standing there knows the file is the one they just made.
    expect(decidePublish({ ...base, file: stale, force: true }).action).toBe('publish');
  });

  it('will not commit the same bytes twice, even when asked to', () => {
    const same = { ...base, localSha: 'abc', publishedSha: 'abc' };
    expect(decidePublish(same).action).toBe('already-there');
    // GitHub would answer this with an empty commit: a permanent entry in the
    // history holding another copy of a multi-megabyte workbook for nothing.
    expect(decidePublish({ ...same, force: true }).action).toBe('already-there');
  });

  it('does not even read a file it published last time, or twice a day', () => {
    const decision = decidePublish({ ...base, sameFingerprint: true, localSha: 'abc', publishedSha: 'abc' });
    expect(decision.action).toBe('already-there');
    if (decision.action === 'already-there') expect(decision.why).toBe('same-file');
    // Pressing "publish now" on a file that has not been written since the last
    // publish would create an empty commit — a permanent history entry holding
    // another copy of the workbook for nothing. The button does not buy that.
    expect(decidePublish({ ...base, sameFingerprint: true, force: true }).action).toBe('already-there');
  });

  it('still compares bytes when the file was touched but not changed', () => {
    const decision = decidePublish({ ...base, sameFingerprint: false, localSha: 'abc', publishedSha: 'abc' });
    expect(decision.action).toBe('already-there');
    if (decision.action === 'already-there') expect(decision.why).toBe('same-bytes');
  });

  it('publishes when the bytes differ from the last publish, though only one sha is known', () => {
    expect(decidePublish({ ...base, localSha: 'abc', publishedSha: 'def' }).action).toBe('publish');
    // First run on a new PC: nothing published yet, so there is nothing to match.
    expect(decidePublish({ ...base, localSha: null, publishedSha: null }).action).toBe('publish');
    expect(decidePublish({ ...base, localSha: null, publishedSha: 'def' }).action).toBe('publish');
  });

  it('measures age from the file’s own time, not from the app’s memory of it', () => {
    expect(ageInHours(file({ modifiedAt: NOW - 90 * 60_000 }), NOW)).toBeCloseTo(1.5, 5);
  });

  it('treats the size floor as the same floor the PC script uses', () => {
    expect(MIN_EXPORT_BYTES).toBe(2048);
  });
});

describe('finding the file when the folder does not use the name in Settings', () => {
  const files: FolderFile[] = [
    file({ name: 'location.xlsx' }),
    file({ name: 'Item List [Summary] 18-09-2026.xlsx', modifiedAt: NOW - 30_000 }),
    file({ name: 'Sales [Item Detail] 18-09-2026.xlsx', modifiedAt: NOW - 20_000 }),
    file({ name: 'Company.qbm' }),
    file({ name: '~$location.xlsx' }),
  ];

  it('takes the exact name first, whatever the case', () => {
    expect(findExactFile(files, 'LOCATION.XLSX')?.name).toBe('location.xlsx');
    expect(pickFolderFile(files, 'location.xlsx', 'location').how).toBe('exact');
  });

  it('ignores the backup and the lock file MYOB leaves behind', () => {
    expect(isWorkbookName('Company.qbm')).toBe(false);
    // Excel's owner file is a few hundred bytes and would otherwise be published
    // as the week's stock.
    expect(isWorkbookName('~$location.xlsx')).toBe(false);
    // The name in Settings is excluded the way `pickFolderFile` does it: the wanted
    // name is itself a hint ("location" inside "location.xlsx"), and a list that
    // offers the file we just failed to find is nonsense.
    expect(hintMatches(files, 'location', 'location.xlsx').map((f) => f.name)).toEqual([
      'Item List [Summary] 18-09-2026.xlsx',
    ]);
  });

  it('offers one plausible file, and asks when there are two', () => {
    const single = pickFolderFile(files, 'future.xlsx', 'future');
    expect(single.how).toBe('hint');
    expect(single.file?.name).toBe('Sales [Item Detail] 18-09-2026.xlsx');

    const two = pickFolderFile(
      [...files, file({ name: 'Sales item detail 12-09-2026.xlsx', modifiedAt: NOW - 6 * 3_600_000 })],
      'future.xlsx',
      'future',
    );
    // Guessing between two dated exports is the one thing this must not do: the
    // screen lists them newest first and a person picks.
    expect(two.file).toBeNull();
    expect(two.candidates.map((f) => f.name)).toEqual([
      'Sales [Item Detail] 18-09-2026.xlsx',
      'Sales item detail 12-09-2026.xlsx',
    ]);
  });

  it('says nothing was found rather than inventing a match', () => {
    const none = pickFolderFile([file({ name: 'notes.txt' })], 'future.xlsx', 'future');
    expect(none.file).toBeNull();
    expect(none.how).toBeNull();
    expect(none.candidates).toEqual([]);
  });

  it('has no opinion about a name that is blank', () => {
    expect(findExactFile(files, '   ')).toBeNull();
  });
});

describe('the line the other computers read afterwards', () => {
  it('names the file, the machine, the time and the rows', () => {
    const at = NOW;
    const message = publishCommitMessage({
      path: 'exports/location.xlsx',
      fileName: 'Item List [Summary] 18-09-2026.xlsx',
      deviceName: 'Shop PC',
      at,
      rows: 2691,
    });
    expect(message).toBe(
      `exports: exports/location.xlsx from Shop PC @ ${formatDayFull(at)} ${formatClock(at)} (2,691 rows)`,
    );
  });

  it('still names a machine when this one has no label', () => {
    expect(publishCommitMessage({ path: 'p', fileName: 'f', deviceName: '', at: NOW, rows: null })).toContain(
      'a PC in the shop',
    );
  });

  it('agrees with itself about whether two looks are the same file', () => {
    expect(isSameFile(file(), file())).toBe(true);
    expect(isSameFile(file(), file({ sizeBytes: 1 }))).toBe(false);
    expect(isSameFile(file(), file({ modifiedAt: NOW }))).toBe(false);
    expect(isSameFile(file(), file({ name: 'other.xlsx' }))).toBe(false);
  });
});

describe('what the folder settings actually mean', () => {
  function withFolder(patch: Record<string, unknown>) {
    const settings = structuredClone(DEFAULT_SETTINGS);
    Object.assign(settings.sources.exports.folder as unknown as Record<string, unknown>, patch);
    return settings;
  }

  it('carries a settings document written before this existed', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    delete (settings.sources.exports as unknown as Record<string, unknown>).folder;
    expect(folderRules(settings)).toEqual({
      enabled: false,
      intervalMinutes: 1,
      names: { location: 'location.xlsx', future: 'future.xlsx' },
      maxAgeHours: 30,
    });
  });

  it('will not poll a network folder faster than once a minute', () => {
    // A 0 here would stat a folder on someone's PC hundreds of times a minute,
    // which is how a shop ends up with a file server that will not answer.
    expect(folderRules(withFolder({ intervalMinutes: 0 })).intervalMinutes).toBe(1);
    expect(folderRules(withFolder({ intervalMinutes: 900 })).intervalMinutes).toBe(60);
  });

  it('will not publish a file of unknown age as current', () => {
    expect(folderRules(withFolder({ maxAgeHours: 0 })).maxAgeHours).toBe(1);
    // Two weeks is as long as "recent" can mean for a shop that exports weekly.
    expect(folderRules(withFolder({ maxAgeHours: 100_000 })).maxAgeHours).toBe(336);
    // `Infinity` is a number. Unchecked it makes every file look ancient, and the
    // watch refuses everything with a straight face.
    expect(folderRules(withFolder({ maxAgeHours: Number.POSITIVE_INFINITY })).maxAgeHours).toBe(30);
    expect(folderRules(withFolder({ maxAgeHours: 'yesterday' })).maxAgeHours).toBe(30);
  });

  it('trims the names, because Windows and Settings disagree about spaces', () => {
    const rules = folderRules(withFolder({ locationFile: '  location.xlsx  ', futureFile: '' }));
    expect(rules.names.location).toBe('location.xlsx');
    // Blank means "not set", and the screen has to be able to tell that from a name.
    expect(rules.names.future).toBe('');
  });

  it('treats anything other than true as not watching', () => {
    expect(folderRules(withFolder({ enabled: 'yes' as unknown as boolean })).enabled).toBe(false);
    expect(folderRules(withFolder({ enabled: true })).enabled).toBe(true);
  });
});
