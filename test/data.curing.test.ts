// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { STAGE_LABELS } from '@/core/batches';
import { DEFAULT_LINES, DEFAULT_SETTINGS } from '@/core/defaults';
import type { Batch, BatchStage } from '@/core/types';
import {
  advanceDueBatches,
  MoveRefusedError,
  moveBatchStage,
  racksOnTheClock,
  readyRacks,
  writeOffBatch,
} from '@/data/batchRepo';
import { db, saveSettings } from '@/data/db';
import { PermissionError } from '@/data/principal';
import { signInForTests } from './support/who';

/**
 * Moving racks through the shop, as stored.
 *
 * The point of these tests is that a move is a decision with a witness: the stage
 * changes, the ledger says who moved it and from what to what, and the refusals
 * are the same sentences the screen would have printed — never a silent no, and
 * never a half-done sweep that leaves the racks disagreeing with the log.
 */

const MONDAY = new Date(2026, 8, 21, 9, 0).getTime();
const DAY = 86_400_000;

function rack(over: Partial<Batch> = {}): Batch {
  const madeAt = over.madeAt ?? MONDAY - 6 * DAY;
  return {
    id: over.id ?? `b-${over.batchNo ?? 'x'}`,
    batchNo: over.batchNo ?? '2026-09-15-01',
    code: over.code ?? 'S3',
    lineId: over.lineId ?? 'line-1',
    trays: over.trays ?? 5,
    qty: over.qty ?? 10,
    qtyOverridden: false,
    routeSnapshot: over.routeSnapshot ?? 'manufacture',
    stage: over.stage ?? 'curing',
    madeAt,
    cureDaysSnapshot: over.cureDaysSnapshot ?? 2,
    cureDueAt: over.cureDueAt ?? madeAt + 2 * DAY,
    blastedQty: over.blastedQty ?? 0,
    blastedAt: over.blastedAt ?? null,
    myobRunDate: over.myobRunDate ?? null,
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

const stageOf = async (id: string): Promise<BatchStage | undefined> => (await db.batches.get(id))?.stage;
const ledger = async (action: string) => db.events.where('action').equals(action).toArray();

describe('moving one rack', () => {
  beforeEach(async () => {
    await reset();
    await db.batches.bulkAdd([
      rack({ batchNo: '2026-09-15-01', id: 'due' }),
      rack({ batchNo: '2026-09-21-01', id: 'curing', madeAt: MONDAY, cureDueAt: MONDAY + 2 * DAY }),
    ]);
  });

  it('takes a rack that has come off the cure, and writes the move down', async () => {
    const moved = await moveBatchStage('due', 'ready');
    expect(moved.stage).toBe('ready');
    expect(await stageOf('due')).toBe('ready');

    const [event] = await ledger('batch.move');
    expect(event).toMatchObject({
      batchId: 'due',
      code: 'S3',
      fromStage: 'curing',
      toStage: 'ready',
      qty: 10,
      trays: 5,
      actor: 'Test Person',
    });
    // The log has to read as a story, because it is read that way.
    expect(event?.detail).toContain('2026-09-15-01 off the racks');
  });

  it('refuses one that is still curing, with the sentence the screen would have shown', async () => {
    await expect(() => moveBatchStage('curing', 'ready')).rejects.toThrow(MoveRefusedError);
    await expect(() => moveBatchStage('curing', 'ready')).rejects.toThrow(/still curing/);
    expect(await stageOf('curing')).toBe('curing');
    expect(await ledger('batch.move')).toHaveLength(0);
  });

  it('refuses a rack that has been keyed into MYOB, and one already written off', async () => {
    await db.batches.put(rack({ id: 'keyed', batchNo: '2026-09-10-01', enteredAt: MONDAY, stage: 'entered_myob' }));
    await expect(() => moveBatchStage('keyed', 'ready')).rejects.toThrow(/keyed into MYOB/);
    const off = await writeOffBatch('due', 'cracked in the sling');
    expect(off.stage).toBe('written_off');
    await expect(() => moveBatchStage('due', 'ready')).rejects.toThrow(/written off/);
  });

  it('will not send a rack into MYOB from here, where there is no week to put it in', async () => {
    await expect(() => moveBatchStage('due', 'entered_myob')).rejects.toThrow(/MYOB entry queue/);
  });

  it('puts a rack back on the racks when it was called ready too early', async () => {
    await db.batches.put(rack({ id: 'early', stage: 'ready', cureDueAt: MONDAY + 2 * DAY }));
    const back = await moveBatchStage('early', 'curing', 'marked it ready by mistake');
    expect(back.stage).toBe('curing');
    const [event] = await ledger('batch.move');
    expect(event?.detail).toContain('put back on the racks');
    expect(event?.detail).toContain('marked it ready by mistake');
  });

  it('says what it is when the rack is already where it is being sent', async () => {
    await expect(() => moveBatchStage('curing', 'curing')).rejects.toThrow(`already marked ${STAGE_LABELS.curing.toLowerCase()}`);
  });

  it('refuses a write-off with no reason, and keeps one with a reason', async () => {
    await expect(() => writeOffBatch('due', '   ')).rejects.toThrow(/needs a reason/);
    expect(await stageOf('due')).toBe('curing');

    await writeOffBatch('due', 'cracked in the sling');
    expect(await stageOf('due')).toBe('written_off');
    const [event] = await ledger('batch.writeOff');
    expect(event?.detail).toBe('2026-09-15-01 written off — cracked in the sling');
    expect(event?.actor).toBe('Test Person');
  });

  it('will not let anyone without the floor’s permission move or write off', async () => {
    signInForTests('viewer');
    await expect(() => moveBatchStage('due', 'ready')).rejects.toThrow(PermissionError);
    await expect(() => writeOffBatch('due', 'cracked')).rejects.toThrow(PermissionError);
    expect(await stageOf('due')).toBe('curing');
    expect(await db.events.count()).toBe(0);
  });
});

describe('the sweep of everything that is due', () => {
  beforeEach(async () => {
    await reset();
    await db.batches.bulkAdd([
      // Off the cure, still sitting where it was cured.
      rack({ batchNo: 'A', id: 'a' }),
      rack({ batchNo: 'B', id: 'b', code: 'S4', lineId: 'line-2', trays: 2, qty: 4 }),
      // Cured, but the blast has not happened: not ready, whatever the calendar says.
      rack({ batchNo: 'C', id: 'c', routeSnapshot: 'shotblast', stage: 'awaiting_shotblast', blastedQty: 0 }),
      // Cured and blasted, so ready.
      rack({ batchNo: 'D', id: 'd', routeSnapshot: 'shotblast', stage: 'awaiting_shotblast', blastedQty: 8, qty: 8, blastedAt: MONDAY - DAY }),
      // Still on the clock.
      rack({ batchNo: 'E', id: 'e', madeAt: MONDAY, cureDueAt: MONDAY + 2 * DAY }),
      // Taken back, and long gone into MYOB.
      rack({ batchNo: 'F', id: 'f', deleted: true }),
      rack({ batchNo: 'G', id: 'g', stage: 'entered_myob', enteredAt: MONDAY }),
    ]);
  });

  it('moves the ones that are genuinely off the cure, and leaves the rest', async () => {
    // The sweep is given the clock, so a fixture can stand on Monday and ask what
    // is due on Monday rather than on whatever day the test suite runs.
    const { moved, refused } = await advanceDueBatches(undefined, MONDAY);
    expect(moved.map((b) => b.batchNo).sort()).toEqual(['A', 'B', 'D']);
    expect(refused).toEqual([]);
    for (const id of ['a', 'b', 'd']) expect(await stageOf(id)).toBe('ready');
    // The blasted-but-uncured rack waits for the blaster, the young one waits for
    // its cure, and a rack that has gone into MYOB or been taken back is not the
    // sweep's business at all.
    expect(await stageOf('c')).toBe('awaiting_shotblast');
    expect(await stageOf('e')).toBe('curing');
    expect(await stageOf('g')).toBe('entered_myob');
    expect((await db.batches.get('f'))?.deleted).toBe(true);
  });

  it('writes one ledger line per rack it moved, and none for the ones it left', async () => {
    await advanceDueBatches(undefined, MONDAY);
    const events = await ledger('batch.move');
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.toStage === 'ready')).toBe(true);
    expect(events.map((e) => e.trays).sort((x, y) => x - y)).toEqual([2, 5, 5]);
  });

  it('sweeps one line when the screen is looking at one line', async () => {
    const { moved } = await advanceDueBatches('line-2', MONDAY);
    expect(moved.map((b) => b.batchNo)).toEqual(['B']);
    expect(await stageOf('a')).toBe('curing');
  });

  it('does nothing at all when nothing is due', async () => {
    await db.batches.clear();
    await db.batches.add(rack({ batchNo: 'E', id: 'e', madeAt: MONDAY, cureDueAt: MONDAY + 2 * DAY }));
    const { moved, refused } = await advanceDueBatches(undefined, MONDAY);
    expect(moved).toEqual([]);
    expect(refused).toEqual([]);
    expect(await ledger('batch.move')).toHaveLength(0);
  });

  it('refuses to sweep at all without the floor’s permission', async () => {
    signInForTests('viewer');
    await expect(() => advanceDueBatches()).rejects.toThrow(PermissionError);
    expect(await stageOf('a')).toBe('curing');
  });
});

describe('reading the racks back', () => {
  beforeEach(async () => {
    await reset();
    await db.batches.bulkAdd([
      rack({ batchNo: 'A', id: 'a' }),
      rack({ batchNo: 'B', id: 'b', stage: 'awaiting_shotblast', routeSnapshot: 'shotblast' }),
      rack({ batchNo: 'C', id: 'c', stage: 'ready' }),
      rack({ batchNo: 'D', id: 'd', stage: 'written_off' }),
      rack({ batchNo: 'E', id: 'e', deleted: true }),
    ]);
  });

  it('hands the screens the racks that are still on the floor', async () => {
    const racks = await racksOnTheClock();
    expect(racks.map((b) => b.batchNo).sort()).toEqual(['A', 'B']);
  });

  it('lists the ready pile oldest make first, and skips what was taken back', async () => {
    // The queue is worked from the top, and the top of it is the rack that has been
    // sitting longest — the one holding up an invoice — not the one moved most recently.
    await db.batches.add(rack({ batchNo: 'F', id: 'f', stage: 'ready', madeAt: MONDAY - 20 * DAY }));
    await db.batches.add(rack({ batchNo: 'G', id: 'g', stage: 'ready', deleted: true }));
    expect((await readyRacks()).map((b) => b.batchNo)).toEqual(['F', 'C']);
  });
});
