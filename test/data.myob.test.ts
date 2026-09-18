// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_LINES, DEFAULT_SETTINGS } from '@/core/defaults';
import type { Batch, BatchStage } from '@/core/types';
import { keyedRacks, markEntered, MoveRefusedError, readyRacks, unmarkEntered } from '@/data/batchRepo';
import { db, saveSettings } from '@/data/db';
import { PermissionError } from '@/data/principal';
import { signInForTests } from './support/who';

/**
 * The weekly run, written down.
 *
 * Marking a run entered is the biggest single write in the app: one press stands
 * for a morning of typing into MYOB and it moves every rack in the queue out of
 * the shop's books. So the tests are about what happens to the *ones that did not
 * go* — the rack that stopped being ready while the list was on screen, the rack
 * keyed last week, the rack that turns up twice in one call — because that is
 * where a bulk write either tells the truth or quietly loses stock.
 */

const DAY = 86_400_000;
const WEDNESDAY = new Date(2026, 8, 16, 9, 0).getTime();
const NOW = WEDNESDAY;
// The shop's entry weekday is Friday and the cut-off is midday, so a rack ready by
// Wednesday belongs to the 18th.
const RUN = new Date(2026, 8, 18, 0, 0).getTime();

function rack(over: Partial<Batch> = {}): Batch {
  const madeAt = over.madeAt ?? WEDNESDAY - 6 * DAY;
  const trays = over.trays ?? 5;
  return {
    id: over.id ?? `b-${over.batchNo ?? 'x'}`,
    batchNo: over.batchNo ?? '2026-09-10-01',
    code: over.code ?? 'A3',
    lineId: over.lineId ?? 'line-1',
    trays,
    qty: over.qty ?? trays * 2,
    qtyOverridden: false,
    routeSnapshot: over.routeSnapshot ?? 'manufacture',
    stage: (over.stage ?? 'ready') as BatchStage,
    madeAt,
    cureDaysSnapshot: over.cureDaysSnapshot ?? 2,
    cureDueAt: over.cureDueAt ?? madeAt + 2 * DAY,
    blastedQty: over.blastedQty ?? 0,
    blastedAt: over.blastedAt ?? null,
    myobRunDate: null,
    enteredAt: over.enteredAt ?? null,
    enteredRef: over.enteredRef ?? '',
    operator: 'Test Person',
    note: '',
    rank: 1000,
    parentBatchId: null,
    updatedAt: over.updatedAt ?? WEDNESDAY,
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

describe('keying a run into MYOB', () => {
  it('records the keying, the run it belongs to, and the reference', async () => {
    await db.batches.add(rack({ id: 'one', batchNo: '2026-09-10-01', trays: 5, qty: 10 }));
    const { entered, refused } = await markEntered(['one'], 'INV-42', NOW);

    expect(refused).toEqual([]);
    expect(entered).toHaveLength(1);
    expect(await db.batches.get('one')).toMatchObject({
      stage: 'entered_myob',
      myobRunDate: RUN,
      enteredAt: NOW,
      enteredRef: 'INV-42',
    });

    const lines = await ledger('batch.enterMyob');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      action: 'batch.enterMyob',
      batchId: 'one',
      fromStage: 'ready',
      toStage: 'entered_myob',
      trays: 5,
      qty: 10,
      actor: 'Test Person',
    });
    expect(lines[0]?.detail).toBe('2026-09-10-01 keyed into MYOB — run 18/09/2026 · 5 trays · 10.00 A3 · ref INV-42');
  });

  it('leaves the reference out of the ledger when there was none', async () => {
    await db.batches.add(rack({ id: 'one' }));
    await markEntered(['one'], '   ', NOW);
    const lines = await ledger('batch.enterMyob');
    expect(lines[0]?.detail).not.toContain('ref');
    expect((await db.batches.get('one'))?.enteredRef).toBe('');
  });

  it('empties the queue, which is the whole point', async () => {
    await db.batches.bulkAdd([rack({ id: 'a', batchNo: 'A' }), rack({ id: 'b', batchNo: 'B' })]);
    expect((await readyRacks()).map((r) => r.id)).toEqual(['a', 'b']);

    const { entered } = await markEntered(['a', 'b'], '', NOW);
    expect(entered).toHaveLength(2);
    expect(await readyRacks()).toEqual([]);
    expect(await ledger('batch.enterMyob')).toHaveLength(2);
  });

  it('carries on past a rack that is no longer ready, and says why', async () => {
    await db.batches.bulkAdd([
      rack({ id: 'good', batchNo: '2026-09-10-01' }),
      rack({ id: 'bad', batchNo: '2026-09-10-02', cureDueAt: NOW + 3 * DAY }),
    ]);
    const { entered, refused } = await markEntered(['good', 'bad'], '', NOW);

    expect(entered.map((b) => b.id)).toEqual(['good']);
    expect(refused).toEqual([{ batchNo: '2026-09-10-02', reason: '2026-09-10-02 is still curing — due in 3 days.' }]);
    // The refused rack is exactly as it was: no stage, no ledger line.
    expect(await db.batches.get('bad')).toMatchObject({ stage: 'ready', enteredAt: null });
    expect(await ledger('batch.enterMyob')).toHaveLength(1);
  });

  it('will not key the same rack twice', async () => {
    await db.batches.add(rack({ id: 'twice', batchNo: '2026-09-10-01', enteredAt: NOW - DAY, myobRunDate: RUN }));
    const { entered, refused } = await markEntered(['twice'], '', NOW);
    expect(entered).toEqual([]);
    expect(refused[0]?.reason).toBe(
      '2026-09-10-01 is already keyed into MYOB for 18/09/2026. Take it back out first if that was a mistake.',
    );
  });

  it('will not key a rack that still owes its blast', async () => {
    await db.batches.add(rack({ id: 'blast', batchNo: '2026-09-10-01', routeSnapshot: 'shotblast', cureDueAt: NOW - DAY }));
    const { refused } = await markEntered(['blast'], '', NOW);
    expect(refused[0]?.reason).toBe('2026-09-10-01 still has 10 to go through the blaster.');
  });

  it('counts a rack once when it is handed over twice', async () => {
    await db.batches.add(rack({ id: 'one' }));
    const { entered } = await markEntered(['one', 'one'], '', NOW);
    expect(entered).toHaveLength(1);
    expect(await ledger('batch.enterMyob')).toHaveLength(1);
  });

  it('says so when a rack is not on this device', async () => {
    const { entered, refused } = await markEntered(['gone'], '', NOW);
    expect(entered).toEqual([]);
    expect(refused).toEqual([{ batchNo: 'gone', reason: 'That rack is not on this device.' }]);
  });

  it('gives each rack the run it belongs to rather than one date for the lot', async () => {
    const lateFriday = rack({
      id: 'late',
      batchNo: 'late',
      madeAt: new Date(2026, 8, 16, 14, 0).getTime(),
      cureDueAt: new Date(2026, 8, 18, 14, 0).getTime(),
    });
    await db.batches.bulkAdd([rack({ id: 'early', batchNo: 'early' }), lateFriday]);
    // Asked on the Friday afternoon, after the midday cut-off.
    const onTheDay = new Date(2026, 8, 18, 15, 0).getTime();
    const { entered, refused } = await markEntered(['early', 'late'], '', onTheDay);

    expect(refused).toEqual([]);
    expect(entered.find((b) => b.id === 'early')?.myobRunDate).toBe(RUN);
    expect(entered.find((b) => b.id === 'late')?.myobRunDate).toBe(RUN + 7 * DAY);
  });

  it('is not something a viewer can do', async () => {
    await db.batches.add(rack({ id: 'one' }));
    signInForTests('viewer');
    await expect(markEntered(['one'], '', NOW)).rejects.toThrow(PermissionError);
    expect(await db.batches.get('one')).toMatchObject({ stage: 'ready', enteredAt: null });
    expect(await db.events.count()).toBe(0);
  });
});

describe('taking a rack back out of a run', () => {
  it('puts it back on the ready pile and writes one line saying so', async () => {
    await db.batches.add(rack({ id: 'one', batchNo: '2026-09-10-01', stage: 'entered_myob', enteredAt: NOW, enteredRef: 'INV-42', myobRunDate: RUN }));
    const back = await unmarkEntered('one', NOW + DAY);

    expect(back).toMatchObject({ stage: 'ready', enteredAt: null, enteredRef: '', myobRunDate: null });
    expect((await readyRacks()).map((r) => r.id)).toEqual(['one']);

    const lines = await ledger('batch.undo');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      action: 'batch.undo',
      fromStage: 'entered_myob',
      toStage: 'ready',
      detail: '2026-09-10-01 taken out of the MYOB run — it was not keyed after all',
    });
  });

  it('refuses a rack that was never keyed', async () => {
    await db.batches.add(rack({ id: 'one' }));
    await expect(unmarkEntered('one', NOW)).rejects.toThrow(MoveRefusedError);
    await expect(unmarkEntered('one', NOW)).rejects.toThrow('has not been keyed into MYOB');
    expect(await db.events.count()).toBe(0);
  });

  it('is not something a viewer can do', async () => {
    await db.batches.add(rack({ id: 'one', stage: 'entered_myob', enteredAt: NOW }));
    signInForTests('viewer');
    await expect(unmarkEntered('one', NOW)).rejects.toThrow(PermissionError);
  });
});

describe('the keyed pile', () => {
  it('lists what has been keyed, most recent first, and nothing else', async () => {
    await db.batches.bulkAdd([
      rack({ id: 'a', batchNo: 'A', stage: 'entered_myob', enteredAt: NOW - DAY }),
      rack({ id: 'b', batchNo: 'B', stage: 'entered_myob', enteredAt: NOW }),
      rack({ id: 'c', batchNo: 'C' }),
      rack({ id: 'd', batchNo: 'D', stage: 'entered_myob', enteredAt: NOW, deleted: true }),
    ]);
    expect((await keyedRacks()).map((r) => r.id)).toEqual(['b', 'a']);
  });
});
