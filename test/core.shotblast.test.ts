// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { cureDueAt } from '@/core/batches';
import {
  awaitsBlast,
  blastCureWords,
  blastLists,
  blastPreview,
  blastProblem,
  blastSummary,
  onTheBlaster,
  splitBlast,
} from '@/core/shotblast';
import type { Batch, BatchStage } from '@/core/types';

/**
 * The blaster's queue.
 *
 * Two rules carry this file. The first is that blasting runs beside the cure: a
 * rack whose cure is finished and whose blast has not happened is the one being
 * held up, and it belongs above the racks that are still hardening. The second is
 * the part-blast — the floor counts trays, so a blast is recorded in trays, and
 * anything less than the whole rack splits it into two records whose quantities
 * must still add up to the rack that was made.
 */

const MONDAY = new Date(2026, 8, 21, 9, 0).getTime();
const DAY = 86_400_000;
const NOW = MONDAY + DAY;

type RackFixture = Partial<Batch> & { cureDays?: number };

/** A shotblast rack by default: that is what the queue is made of. */
function rack(fixture: RackFixture = {}): Batch {
  const { cureDays: shorthand, ...over } = fixture;
  const madeAt = over.madeAt ?? MONDAY - 2 * DAY;
  const cureDays = shorthand ?? over.cureDaysSnapshot ?? 2;
  const trays = over.trays ?? 5;
  const qty = over.qty ?? trays * 2;
  return {
    id: over.id ?? `b-${over.batchNo ?? 'x'}`,
    batchNo: over.batchNo ?? '2026-09-19-01',
    code: over.code ?? 'SB1',
    lineId: 'line-1',
    trays,
    qty,
    qtyOverridden: false,
    routeSnapshot: 'shotblast',
    stage: over.stage ?? 'awaiting_shotblast',
    madeAt,
    cureDaysSnapshot: cureDays,
    cureDueAt: over.cureDueAt ?? cureDueAt(madeAt, cureDays),
    blastedQty: over.blastedQty ?? 0,
    blastedAt: over.blastedAt ?? null,
    myobRunDate: null,
    enteredAt: null,
    enteredRef: '',
    operator: 'Test Person',
    note: '',
    rank: 1000,
    parentBatchId: null,
    updatedAt: MONDAY,
    ...over,
  };
}

describe('what the blaster is owed', () => {
  it('owes a blast whatever stage the rack is sitting in', () => {
    const onIt: BatchStage[] = ['green', 'curing', 'awaiting_shotblast', 'blasting'];
    for (const stage of onIt) expect(awaitsBlast(rack({ stage }))).toBe(true);
  });

  it('owes nothing when it is blasted, not a shotblast make, or off the floor', () => {
    expect(awaitsBlast(rack({ blastedQty: 10, blastedAt: MONDAY }))).toBe(false);
    expect(awaitsBlast(rack({ routeSnapshot: 'manufacture' }))).toBe(false);
    for (const stage of ['ready', 'entered_myob', 'written_off'] as BatchStage[]) {
      expect(awaitsBlast(rack({ stage }))).toBe(false);
    }
    expect(awaitsBlast(rack({ deleted: true }))).toBe(false);
  });

  it('says a half-blasted rack is still owed', () => {
    // The remainder of a split carries its own quantity, but a rack marked with a
    // partial blast has to read as unfinished, not as done.
    expect(awaitsBlast(rack({ trays: 8, qty: 8, blastedQty: 5 }))).toBe(true);
    expect(awaitsBlast(rack({ trays: 8, qty: 8, blastedQty: 8, blastedAt: MONDAY }))).toBe(false);
  });

  it('is only on the blaster while it is on the blaster', () => {
    expect(onTheBlaster(rack({ stage: 'blasting' }))).toBe(true);
    expect(onTheBlaster(rack({ stage: 'awaiting_shotblast' }))).toBe(false);
    expect(onTheBlaster(rack({ stage: 'blasting', blastedQty: 10, blastedAt: MONDAY }))).toBe(false);
  });
});

describe('the queue the screen shows', () => {
  const running = rack({ batchNo: 'in-1', stage: 'blasting', updatedAt: MONDAY + 200 });
  const runningEarlier = rack({ batchNo: 'in-2', stage: 'blasting', updatedAt: MONDAY + 100 });
  // Cure finished before now, so only the blast stands in the way.
  const heldUp = rack({ batchNo: 'held', madeAt: MONDAY - 6 * DAY, cureDays: 2 });
  const heldUpLonger = rack({ batchNo: 'older', madeAt: MONDAY - 9 * DAY, cureDays: 2 });
  // Cure still running.
  const hardening = rack({ batchNo: 'new', madeAt: MONDAY, cureDays: 3 });

  const lists = blastLists([running, runningEarlier, heldUp, heldUpLonger, hardening], NOW);

  it('puts the cure-finished racks above the ones still hardening', () => {
    expect(lists.cureFinished.map((b) => b.batchNo)).toEqual(['older', 'held']);
    expect(lists.stillCuring.map((b) => b.batchNo)).toEqual(['new']);
  });

  it('lists what is in the blaster in the order it went in', () => {
    expect(lists.blasting.map((b) => b.batchNo)).toEqual(['in-2', 'in-1']);
  });

  it('leaves anything that does not owe a blast out of all three lists', () => {
    const other = blastLists(
      [
        rack({ batchNo: 'done', blastedQty: 10, blastedAt: MONDAY }),
        rack({ batchNo: 'plain', routeSnapshot: 'manufacture' }),
        rack({ batchNo: 'gone', stage: 'ready' }),
        running,
      ],
      NOW,
    );
    expect(other.cureFinished).toEqual([]);
    expect(other.stillCuring).toEqual([]);
    expect(other.blasting.map((b) => b.batchNo)).toEqual(['in-1']);
  });

  it('counts the queue for the header, and how long the oldest has waited', () => {
    const summary = blastSummary([running, heldUp, heldUpLonger, hardening], NOW);
    expect(summary).toEqual({
      waiting: 3,
      onBlaster: 1,
      trays: 20,
      urgent: 2,
      // The longest-waiting rack was made on 12 September, its cure ended on the
      // 14th, and it has been sitting in the queue since. Now is the 22nd.
      oldestDays: 8,
    });
  });

  it('says nothing about waiting when nothing is waiting', () => {
    expect(blastSummary([], NOW)).toEqual({ waiting: 0, onBlaster: 0, trays: 0, urgent: 0, oldestDays: 0 });
  });
});

describe('blasting part of a rack', () => {
  it('does not split the rack when the whole of it went through', () => {
    const split = splitBlast(rack({ trays: 6, qty: 12 }), 6);
    expect(split).toEqual({ blastedTrays: 6, blastedQty: 12, remainderTrays: 0, remainderQty: 0, whole: true });
  });

  it('splits by the trays the floor counted, not by today’s tray yield', () => {
    // 5 trays, 10 m²: 2 m² a tray, from the rack's own numbers.
    const split = splitBlast(rack({ trays: 5, qty: 10 }), 3);
    expect(split.blastedTrays).toBe(3);
    expect(split.blastedQty).toBe(6);
    expect(split.remainderTrays).toBe(2);
    expect(split.remainderQty).toBe(4);
    expect(split.whole).toBe(false);
  });

  it('leaves no quantity on the floor when the yield does not divide evenly', () => {
    const batch = rack({ trays: 3, qty: 1 });
    const split = splitBlast(batch, 1);
    expect(split.blastedQty).toBe(0.333);
    expect(split.remainderQty).toBe(0.667);
    // The two halves are the rack. Not a rounding error between them.
    expect(split.blastedQty + split.remainderQty).toBeCloseTo(batch.qty, 10);
  });

  it('keeps the remainder exact when the quantity is an odd fraction', () => {
    const batch = rack({ trays: 7, qty: 2.333 });
    const split = splitBlast(batch, 3);
    expect(split.blastedQty + split.remainderQty).toBeCloseTo(batch.qty, 10);
    expect(split.blastedQty).toBe(1);
  });
});

describe('what cannot be blasted', () => {
  it('refuses a rack that has finished, whatever stage finished it', () => {
    expect(blastProblem(rack({ deleted: true }), null)).toBe('That rack has been taken back, so there is nothing to blast.');
    expect(blastProblem(rack({ stage: 'written_off' }), null)).toContain('was written off');
    expect(blastProblem(rack({ stage: 'ready', enteredAt: MONDAY }), null)).toContain('is keyed into MYOB');
  });

  it('refuses a rack that does not need it', () => {
    expect(blastProblem(rack({ blastedQty: 10, blastedAt: MONDAY }), null)).toBe('2026-09-19-01 has already had its blast.');
    expect(blastProblem(rack({ routeSnapshot: 'manufacture' }), null)).toContain('is not a shotblast make');
  });

  it('refuses trays that are not a count of trays', () => {
    const batch = rack({ trays: 5, qty: 10 });
    expect(blastProblem(batch, 0)).toBe('How many trays went through the blaster?');
    expect(blastProblem(batch, -2)).toBe('How many trays went through the blaster?');
    expect(blastProblem(batch, 2.5)).toBe('Trays are whole ones.');
    expect(blastProblem(batch, 6)).toBe('Only 5 trays are on that rack.');
  });

  it('says yes to a rack that owes a blast, and to any whole part of it', () => {
    const batch = rack({ trays: 5, qty: 10 });
    expect(blastProblem(batch, null)).toBeNull();
    expect(blastProblem(batch, 1)).toBeNull();
    expect(blastProblem(batch, 5)).toBeNull();
  });
});

describe('what the blaster is told before it presses', () => {
  it('says the rack is done when all of it goes through', () => {
    expect(blastPreview(rack({ batchNo: 'A3', trays: 8, qty: 8 }), 8)).toBe(
      'All 8 trays come out blasted. The rack is done.',
    );
  });

  it('names the number the blasted trays keep and the ones that split off', () => {
    expect(blastPreview(rack({ batchNo: 'A3', trays: 8, qty: 8 }), 5)).toBe(
      '5 trays come out blasted and keep A3. The other 3 become their own rack, still to be blasted.',
    );
  });

  it('says what the cure has done, which is the thing that decides urgency', () => {
    const late = rack({ madeAt: MONDAY - 6 * DAY, cureDays: 2 });
    const early = rack({ madeAt: MONDAY, cureDays: 3 });
    expect(blastCureWords(late, NOW)).toBe('cure finished 5 days ago');
    expect(blastCureWords(early, NOW)).toBe('cure due in 2 days');
  });
});
