// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { dueToAdvance } from '@/core/batches';
import { DEFAULT_LINES, DEFAULT_SETTINGS } from '@/core/defaults';
import type { Batch } from '@/core/types';
import {
  finishBlast,
  MoveRefusedError,
  racksAwaitingBlast,
  startBlast,
} from '@/data/batchRepo';
import { db, getSettings, saveSettings } from '@/data/db';
import { PermissionError } from '@/data/principal';
import { signInForTests } from './support/who';

/**
 * The blaster's writes.
 *
 * A blast is a physical event with two records hanging off it: the rack that came
 * out, and — when only part of it went through — the rack that did not. These
 * tests are about the bookkeeping that has to be exactly right: quantities that
 * add back to the rack that was made, a number that is not already on another
 * pallet, and one ledger line per thing that happened.
 */

const MONDAY = new Date(2026, 8, 21, 9, 0).getTime();
const DAY = 86_400_000;
const NOW = MONDAY + DAY;

function rack(over: Partial<Batch> = {}): Batch {
  const madeAt = over.madeAt ?? MONDAY - 6 * DAY;
  const trays = over.trays ?? 8;
  return {
    id: over.id ?? `b-${over.batchNo ?? 'x'}`,
    batchNo: over.batchNo ?? '2026-09-15-01',
    code: over.code ?? 'SB1',
    lineId: over.lineId ?? 'line-1',
    trays,
    qty: over.qty ?? trays * 2,
    qtyOverridden: false,
    routeSnapshot: over.routeSnapshot ?? 'shotblast',
    stage: over.stage ?? 'awaiting_shotblast',
    madeAt,
    cureDaysSnapshot: over.cureDaysSnapshot ?? 2,
    cureDueAt: over.cureDueAt ?? madeAt + 2 * DAY,
    blastedQty: over.blastedQty ?? 0,
    blastedAt: over.blastedAt ?? null,
    myobRunDate: null,
    enteredAt: over.enteredAt ?? null,
    enteredRef: '',
    operator: 'Test Person',
    note: '',
    rank: 1000,
    parentBatchId: null,
    updatedAt: MONDAY,
    ...over,
  };
}

async function reset(): Promise<void> {
  signInForTests('maker');
  await Promise.all([db.batches.clear(), db.events.clear(), db.products.clear(), db.lines.clear(), db.meta.clear()]);
  await saveSettings(structuredClone(DEFAULT_SETTINGS));
  await db.lines.bulkAdd(DEFAULT_LINES.map((l) => ({ ...l, updatedAt: 1 })));
}

const ledger = (action: string) => db.events.where('action').equals(action).toArray();

beforeEach(reset);

describe('putting a rack on the blaster', () => {
  it('marks it on the blaster and writes one line saying so', async () => {
    await db.batches.add(rack({ id: 'one', batchNo: '2026-09-15-01', trays: 8 }));
    const onIt = await startBlast('one', NOW);
    expect(onIt.stage).toBe('blasting');

    const lines = await ledger('batch.blast');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      action: 'batch.blast',
      batchId: 'one',
      fromStage: 'awaiting_shotblast',
      toStage: 'blasting',
      trays: 8,
      detail: '2026-09-15-01 on the blaster — 8 trays in',
      actor: 'Test Person',
    });
  });

  it('will not put a rack on that does not need it', async () => {
    await db.batches.add(rack({ id: 'done', blastedQty: 16, blastedAt: MONDAY, stage: 'curing' }));
    await expect(startBlast('done', NOW)).rejects.toThrow('2026-09-15-01 has already had its blast');
    expect(await db.events.count()).toBe(0);
  });

  it('says so when it is already on the blaster', async () => {
    await db.batches.add(rack({ id: 'on', stage: 'blasting' }));
    await expect(startBlast('on', NOW)).rejects.toThrow('It is already marked on the blaster');
  });

  it('will not let a viewer touch the machine', async () => {
    await db.batches.add(rack({ id: 'one' }));
    signInForTests('viewer');
    await expect(startBlast('one', NOW)).rejects.toThrow(PermissionError);
    expect((await db.batches.get('one'))?.stage).toBe('awaiting_shotblast');
    expect(await db.events.count()).toBe(0);
  });
});

describe('taking a whole rack out of the blaster', () => {
  it('records the blast and puts the rack back on the racks', async () => {
    await db.batches.add(rack({ id: 'one', batchNo: '2026-09-15-01', trays: 8, qty: 16, stage: 'blasting' }));
    const { blasted, remainder } = await finishBlast('one', 8, NOW);

    expect(remainder).toBeNull();
    expect(blasted).toMatchObject({ trays: 8, qty: 16, blastedQty: 16, blastedAt: NOW, stage: 'curing' });
    expect(await db.batches.count()).toBe(1);

    const lines = await ledger('batch.blast');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.detail).toBe('2026-09-15-01 through the blaster — all 8 trays out');
    expect(lines[0]?.toStage).toBe('curing');
    expect(await ledger('batch.split')).toHaveLength(0);
  });

  it('makes it sellable, because on this shop’s settings the blast stands in for the cure', async () => {
    await db.batches.add(rack({ id: 'one', trays: 8, qty: 16, stage: 'blasting' }));
    await finishBlast('one', 8, NOW);
    const settings = await getSettings();
    const due = dueToAdvance(await db.batches.toArray(), settings, NOW);
    expect(due.map((b) => b.id)).toEqual(['one']);
  });

  it('leaves the cure to decide when the shop runs the other way', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.production.blastingCompletesCure = false;
    await saveSettings(settings);
    await db.batches.add(rack({ id: 'one', madeAt: MONDAY, cureDueAt: MONDAY + 2 * DAY, stage: 'blasting' }));
    await finishBlast('one', 8, NOW);

    const due = dueToAdvance(await db.batches.toArray(), await getSettings(), NOW);
    expect(due).toEqual([]);
  });
});

describe('blasting part of a rack', () => {
  it('keeps the number on the trays that came out and gives the rest its own', async () => {
    await db.batches.add(rack({ id: 'one', batchNo: '2026-09-15-01', trays: 8, qty: 16, stage: 'blasting' }));
    const { blasted, remainder } = await finishBlast('one', 5, NOW);

    expect(blasted.batchNo).toBe('2026-09-15-01');
    expect(blasted).toMatchObject({ trays: 5, qty: 10, blastedQty: 10, blastedAt: NOW, stage: 'curing' });

    expect(remainder).not.toBeNull();
    expect(remainder?.id).not.toBe('one');
    expect(remainder?.batchNo).toBe('2026-09-15-02');
    expect(remainder).toMatchObject({
      trays: 3,
      qty: 6,
      blastedQty: 0,
      blastedAt: null,
      stage: 'awaiting_shotblast',
      parentBatchId: 'one',
      code: 'SB1',
      lineId: 'line-1',
    });
    // The making and the cure belong to the day it was cast, not the blast.
    expect(remainder?.madeAt).toBe(MONDAY - 6 * DAY);
    expect(remainder?.cureDueAt).toBe(MONDAY - 4 * DAY);
    expect(remainder?.cureDaysSnapshot).toBe(2);
  });

  it('loses nothing between the two halves', async () => {
    await db.batches.add(rack({ id: 'odd', trays: 7, qty: 2.333, stage: 'blasting' }));
    await finishBlast('odd', 3, NOW);
    const rows = await db.batches.toArray();
    expect(rows.reduce((sum, b) => sum + b.trays, 0)).toBe(7);
    expect(rows.reduce((sum, b) => sum + b.qty, 0)).toBeCloseTo(2.333, 10);
  });

  it('writes the blast and the split as two lines that name each other', async () => {
    await db.batches.add(rack({ id: 'one', batchNo: '2026-09-15-01', trays: 8, qty: 16, stage: 'blasting' }));
    await finishBlast('one', 5, NOW);

    const blasts = await ledger('batch.blast');
    const splits = await ledger('batch.split');
    expect(blasts).toHaveLength(1);
    expect(blasts[0]?.detail).toBe('2026-09-15-01 through the blaster — 5 of 8 trays out');
    expect(splits).toHaveLength(1);
    expect(splits[0]?.detail).toBe('2026-09-15-02 — the other 3 trays off 2026-09-15-01, still to be blasted');
    expect(splits[0]?.batchId).not.toBe('one');
  });

  it('takes the next number of the making day, whatever else is on the device', async () => {
    await db.batches.bulkAdd([
      rack({ id: 'one', batchNo: '2026-09-15-01', stage: 'blasting' }),
      rack({ id: 'taken', batchNo: '2026-09-15-02', deleted: true }),
      rack({ id: 'other', batchNo: '2026-09-21-01', madeAt: MONDAY }),
    ]);
    const { remainder } = await finishBlast('one', 2, NOW);
    expect(remainder?.batchNo).toBe('2026-09-15-03');
  });

  it('only leaves the unfinished half in the queue', async () => {
    await db.batches.add(rack({ id: 'one', trays: 8, qty: 16, stage: 'blasting' }));
    await finishBlast('one', 5, NOW);
    const queue = await racksAwaitingBlast();
    expect(queue.map((b) => b.id)).toEqual([expect.any(String)]);
    expect(queue[0]?.batchNo).toBe('2026-09-15-02');
  });

  it('refuses a count that is not a count of trays, and writes nothing', async () => {
    await db.batches.add(rack({ id: 'one', trays: 8, qty: 16, stage: 'blasting' }));
    for (const [trays, sentence] of [
      [0, 'How many trays went through the blaster?'],
      [2.5, 'Trays are whole ones.'],
      [9, 'Only 8 trays are on that rack.'],
    ] as const) {
      await expect(finishBlast('one', trays, NOW)).rejects.toThrow(sentence);
    }
    const after = await db.batches.get('one');
    expect(after).toMatchObject({ trays: 8, qty: 16, blastedQty: 0, stage: 'blasting' });
    expect(await db.batches.count()).toBe(1);
    expect(await db.events.count()).toBe(0);
  });

  it('refuses a rack that has finished by other means', async () => {
    await db.batches.add(rack({ id: 'gone', deleted: true }));
    await expect(finishBlast('gone', 4, NOW)).rejects.toThrow(MoveRefusedError);
    await db.batches.add(rack({ id: 'off', stage: 'written_off' }));
    await expect(finishBlast('off', 4, NOW)).rejects.toThrow('was written off');
    await db.batches.add(rack({ id: 'in', stage: 'entered_myob', enteredAt: MONDAY }));
    await expect(finishBlast('in', 4, NOW)).rejects.toThrow('is keyed into MYOB');
  });

  it('will not let a viewer record a blast', async () => {
    await db.batches.add(rack({ id: 'one', stage: 'blasting' }));
    signInForTests('viewer');
    await expect(finishBlast('one', 8, NOW)).rejects.toThrow(PermissionError);
    expect((await db.batches.get('one'))?.blastedAt).toBeNull();
  });
});

describe('reading the queue', () => {
  it('lists every rack the blaster is owed, and nothing it is not', async () => {
    await db.batches.bulkAdd([
      rack({ id: 'waiting', batchNo: 'w' }),
      rack({ id: 'on', batchNo: 'o', stage: 'blasting' }),
      rack({ id: 'curing-but-owed', batchNo: 'c', stage: 'curing' }),
      rack({ id: 'blasted', batchNo: 'b', blastedQty: 16, blastedAt: MONDAY, stage: 'curing' }),
      rack({ id: 'plain', batchNo: 'p', routeSnapshot: 'manufacture', stage: 'curing' }),
      rack({ id: 'ready', batchNo: 'r', blastedQty: 16, blastedAt: MONDAY, stage: 'ready' }),
      rack({ id: 'back', batchNo: 'k', deleted: true }),
    ]);
    const queue = await racksAwaitingBlast();
    expect(queue.map((b) => b.id).sort()).toEqual(['curing-but-owed', 'on', 'waiting']);
  });
});
