// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { cureDueAt } from '@/core/batches';
import { DEFAULT_LINES, DEFAULT_SETTINGS } from '@/core/defaults';
import type { Batch, Product } from '@/core/types';
import { batchesOnDay, batchesOnLineOnDay, EntryRefusedError, recordEntry, undoEntry } from '@/data/batchRepo';
import { db, getSettings, saveSettings } from '@/data/db';
import { signInForTests, signOutForTests } from './support/who';

/**
 * Writing production down — the moment a number typed on a floor becomes a rack
 * with a date on it. What is worth proving here is not that Dexie stores rows but
 * that the writer refuses the things that would leave the shop with stock it never
 * made, and that it says who did it in the words the log will be read in.
 */

const FRIDAY = new Date(2026, 8, 18, 15, 30).getTime();
const MONDAY = new Date(2026, 8, 21, 9, 0).getTime();

function product(code: string, over: Partial<Product> = {}): Product {
  return {
    code,
    description: `${code} paver`,
    enabled: true,
    route: 'manufacture',
    usesBaseline10000: false,
    unit: 'm2',
    trayYield: 2,
    target: 1000,
    cureDays: 2,
    notes: '',
    rank: 1000,
    seenInJobs: false,
    updatedAt: 1,
    ...over,
  };
}

async function reset(): Promise<void> {
  signInForTests('maker');
  await Promise.all([db.batches.clear(), db.products.clear(), db.events.clear(), db.lines.clear(), db.meta.clear()]);
  await saveSettings(structuredClone(DEFAULT_SETTINGS));
  await db.products.bulkAdd([
    product('S3'),
    product('S4', { trayYield: 0.5 }),
    product('S7', { route: 'unset' }),
    product('S8', { trayYield: 0 }),
    product('B2', { route: 'shotblast' }),
  ]);
  await db.lines.bulkAdd(DEFAULT_LINES.map((l) => ({ ...l, updatedAt: 1 })));
}

describe('logging a day’s making', () => {
  beforeEach(reset);

  it('turns trays into a rack: quantity by yield, cure date by the product', async () => {
    const { created } = await recordEntry({
      lineId: 'line-1',
      madeAt: FRIDAY,
      rows: [
        { key: 'a', code: 'S3', trays: 10 },
        { key: 'b', code: 'S4', trays: 4 },
      ],
    });

    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({
      code: 'S3',
      lineId: 'line-1',
      trays: 10,
      qty: 20,
      stage: 'curing',
      cureDaysSnapshot: 2,
      cureDueAt: cureDueAt(FRIDAY, 2),
      batchNo: '2026-09-18-01',
    });
    expect(created[1]).toMatchObject({ code: 'S4', qty: 2, batchNo: '2026-09-18-02' });

    // A shotblast make is born in the blaster's queue as well as on the clock.
    const blasted = await recordEntry({ lineId: 'line-shotblast', madeAt: FRIDAY, rows: [{ key: 'c', code: 'B2', trays: 3 }] });
    expect(blasted.created[0]?.stage).toBe('awaiting_shotblast');
  });

  it('numbers the day’s racks in order, and carries on from what is already there', async () => {
    await recordEntry({ lineId: 'line-1', madeAt: FRIDAY, rows: [{ key: 'a', code: 'S3', trays: 1 }] });
    const second = await recordEntry({ lineId: 'line-2', madeAt: FRIDAY, rows: [{ key: 'b', code: 'S3', trays: 1 }] });
    expect(second.created[0]?.batchNo).toBe('2026-09-18-02');

    // Monday is Monday's own sequence. The number is read out over a running
    // machine, so it has to mean "the first one today".
    const monday = await recordEntry({ lineId: 'line-1', madeAt: MONDAY, rows: [{ key: 'c', code: 'S3', trays: 1 }] });
    expect(monday.created[0]?.batchNo).toBe('2026-09-21-01');
  });

  it('refuses the rows it cannot log, says why, and still writes the ones it can', async () => {
    const { created, refused } = await recordEntry({
      lineId: 'line-1',
      madeAt: FRIDAY,
      rows: [
        { key: 'good', code: 'S3', trays: 5 },
        { key: 'no-route', code: 'S7', trays: 5 },
        { key: 'no-yield', code: 'S8', trays: 5 },
        { key: 'no-trays', code: 'S4', trays: null },
      ],
    });

    expect(created.map((b) => b.code)).toEqual(['S3']);
    expect(refused).toEqual([
      { key: 'no-route', problem: 'S7 has no route — set it on Products' },
      { key: 'no-yield', problem: 'S8 has no tray yield — set it on Products' },
      { key: 'no-trays', problem: 'how many trays?' },
    ]);
    // Nothing was invented for the refused rows: they are not in the day at all.
    expect(await batchesOnDay(FRIDAY)).toHaveLength(1);
  });

  it('says who logged it, from the login rather than a box on the screen', async () => {
    const { created } = await recordEntry({ lineId: 'line-1', madeAt: FRIDAY, rows: [{ key: 'a', code: 'S3', trays: 2 }] });
    expect(created[0]?.operator).toBe('Test Person');

    const rows = await db.events.where('action').equals('batch.create').toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: 'Test Person', actorId: 'acct-maker', code: 'S3', trays: 2, qty: 4, toStage: 'curing' });
    expect(rows[0]?.detail).toContain('2026-09-18-01');
  });

  it('will not log on a line the shop does not have, or one it has switched off', async () => {
    await expect(recordEntry({ lineId: 'line-9', madeAt: FRIDAY, rows: [{ key: 'a', code: 'S3', trays: 1 }] })).rejects.toBeInstanceOf(
      EntryRefusedError,
    );

    await db.lines.update('line-3', { active: false });
    await expect(recordEntry({ lineId: 'line-3', madeAt: FRIDAY, rows: [{ key: 'a', code: 'S3', trays: 1 }] })).rejects.toThrow(
      /switched off/,
    );
    expect(await db.batches.count()).toBe(0);
  });

  it('refuses a viewer, because this is the work itself', async () => {
    signOutForTests();
    signInForTests('viewer');
    await expect(recordEntry({ lineId: 'line-1', madeAt: FRIDAY, rows: [{ key: 'a', code: 'S3', trays: 1 }] })).rejects.toMatchObject({
      name: 'PermissionError',
    });
    expect(await db.batches.count()).toBe(0);
  });
});

describe('taking a make back', () => {
  beforeEach(async () => {
    await reset();
  });

  async function one(): Promise<Batch> {
    const { created } = await recordEntry({ lineId: 'line-1', madeAt: FRIDAY, rows: [{ key: 'a', code: 'S3', trays: 3 }] });
    return created[0] as Batch;
  }

  it('removes it from the day and keeps the ledger honest about it', async () => {
    const batch = await one();
    const cleared = await undoEntry(batch.id, 'keyed 30 not 3');

    // A tombstone, not an erasure: the other devices have to hear that it went away.
    expect(cleared.deleted).toBe(true);
    expect(await batchesOnDay(FRIDAY)).toEqual([]);
    expect((await db.batches.get(batch.id))?.deleted).toBe(true);

    const rows = await db.events.where('action').equals('batch.undo').toArray();
    expect(rows[0]).toMatchObject({ batchId: batch.id, code: 'S3', trays: 3, qty: 6, fromStage: 'curing' });
    expect(rows[0]?.detail).toContain('keyed 30 not 3');
  });

  it('refuses once the batch has gone further, and says what to do instead', async () => {
    const blasted = await one();
    await db.batches.put({ ...blasted, blastedQty: 1, blastedAt: FRIDAY });
    await expect(undoEntry(blasted.id)).rejects.toThrow(/blasted.*Write it off/s);

    const onRun = await one();
    await db.batches.update(onRun.id, { myobRunDate: MONDAY });
    await expect(undoEntry(onRun.id)).rejects.toThrow(/MYOB run/);

    const keyed = await one();
    await db.batches.update(keyed.id, { enteredAt: MONDAY, stage: 'entered_myob' });
    await expect(undoEntry(keyed.id)).rejects.toThrow(/keyed into MYOB/);

    // None of those refusals changed anything.
    expect(await db.events.where('action').equals('batch.undo').count()).toBe(0);
  });

  it('refuses a viewer', async () => {
    const batch = await one();
    signInForTests('viewer');
    await expect(undoEntry(batch.id)).rejects.toMatchObject({ name: 'PermissionError' });
  });
});

describe('reading a day back', () => {
  beforeEach(reset);

  it('shows a line only its own making, and only the day it was made', async () => {
    await recordEntry({ lineId: 'line-1', madeAt: FRIDAY, rows: [{ key: 'a', code: 'S3', trays: 1 }] });
    await recordEntry({ lineId: 'line-2', madeAt: FRIDAY, rows: [{ key: 'b', code: 'S4', trays: 1 }] });
    await recordEntry({ lineId: 'line-1', madeAt: MONDAY, rows: [{ key: 'c', code: 'S3', trays: 1 }] });

    const friday = await batchesOnDay(FRIDAY);
    expect(friday.map((b) => b.batchNo)).toEqual(['2026-09-18-02', '2026-09-18-01']);
    expect((await batchesOnLineOnDay('line-1', FRIDAY)).map((b) => b.batchNo)).toEqual(['2026-09-18-01']);
    expect((await batchesOnLineOnDay('line-1', MONDAY)).map((b) => b.batchNo)).toEqual(['2026-09-21-01']);
  });

  it('does not need the settings to be re-read to answer, so a stale board still reads', async () => {
    await recordEntry({ lineId: 'line-1', madeAt: FRIDAY, rows: [{ key: 'a', code: 'S3', trays: 1 }] });
    const s = await getSettings();
    expect(s.production.defaultCureDays).toBe(2);
    expect(await batchesOnDay(FRIDAY)).toHaveLength(1);
  });
});
