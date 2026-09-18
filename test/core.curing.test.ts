// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { cureDueAt } from '@/core/batches';
import {
  blastOutstanding,
  cureBucket,
  cureState,
  cureSummary,
  groupForCure,
  moveProblem,
  needsBlast,
  onTheRacks,
} from '@/core/curing';
import { DEFAULT_SETTINGS } from '@/core/defaults';
import type { Batch, BatchStage, Settings } from '@/core/types';

/**
 * Reading the racks.
 *
 * The distinction the whole file turns on is between *cured* and *usable*: a
 * shotblast rack whose cure is over but whose blast has not happened is not
 * ready, and a rack that is ready and still sitting where it was cured is waiting
 * for a person, not for the calendar. Each test below is one of those two cases,
 * because they are the only two the floor has to tell apart.
 */

const MONDAY = new Date(2026, 8, 21, 9, 0).getTime();
const DAY = 86_400_000;

function settings(over: Partial<Settings['production']> = {}): Settings {
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    production: { ...DEFAULT_SETTINGS.production, ...over },
  };
}

/** `cureDays` is shorthand for the snapshot the batch really carries. */
type RackFixture = Partial<Batch> & { cureDays?: number };

function rack(fixture: RackFixture = {}): Batch {
  const { cureDays: shorthand, ...over } = fixture;
  const madeAt = over.madeAt ?? MONDAY - 2 * DAY;
  const cureDays = shorthand ?? over.cureDaysSnapshot ?? 2;
  const qty = over.qty ?? 10;
  return {
    id: over.id ?? `b-${over.batchNo ?? 'x'}`,
    batchNo: over.batchNo ?? '2026-09-19-01',
    code: over.code ?? 'S3',
    lineId: 'line-1',
    trays: over.trays ?? 5,
    qty,
    qtyOverridden: false,
    routeSnapshot: over.routeSnapshot ?? 'manufacture',
    stage: over.stage ?? 'curing',
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

describe('what is still on the racks', () => {
  it('counts the stages that hold a rack, and not the ones that have gone', () => {
    const onIt: BatchStage[] = ['green', 'curing', 'awaiting_shotblast', 'blasting'];
    for (const stage of onIt) expect(onTheRacks(rack({ stage }))).toBe(true);
    for (const stage of ['ready', 'entered_myob', 'written_off'] as BatchStage[]) {
      expect(onTheRacks(rack({ stage }))).toBe(false);
    }
    expect(onTheRacks(rack({ deleted: true }))).toBe(false);
  });

  it('only a shotblast make can owe a blast, and it owes what has not been through', () => {
    expect(blastOutstanding(rack({ routeSnapshot: 'manufacture' }))).toBe(0);
    expect(needsBlast(rack({ routeSnapshot: 'manufacture', blastedQty: 0 }))).toBe(false);
    const waiting = rack({ routeSnapshot: 'shotblast', qty: 10, blastedQty: 0 });
    expect(blastOutstanding(waiting)).toBe(10);
    // Half a rack through the blaster is still half a rack owing.
    expect(blastOutstanding(rack({ routeSnapshot: 'shotblast', qty: 10, blastedQty: 4 }))).toBe(6);
    expect(needsBlast(rack({ routeSnapshot: 'shotblast', qty: 10, blastedQty: 10 }))).toBe(false);
  });
});

describe('the cure clock against the blaster', () => {
  it('a plain make is not usable until its cure ends, and is afterwards', () => {
    const s = settings();
    const still = rack({ madeAt: MONDAY - DAY, cureDays: 3 });
    expect(cureState(still, s, MONDAY).ready).toBe(false);
    expect(cureState(still, s, MONDAY).planDate).toBe(still.cureDueAt);
    expect(cureState(still, s, MONDAY).cureDaysLeft).toBe(2);

    const done = rack({ madeAt: MONDAY - 2 * DAY, cureDays: 2 });
    expect(cureState(done, s, MONDAY).ready).toBe(true);
    expect(cureState(done, s, MONDAY).cureDaysLeft).toBe(0);
  });

  it('a cure that finished and was never moved reads as overdue, not as zero', () => {
    const old = rack({ madeAt: MONDAY - 6 * DAY, cureDays: 2 });
    const state = cureState(old, settings(), MONDAY);
    expect(state.ready).toBe(true);
    expect(state.cureDaysLeft).toBe(-4);
    expect(state.progress).toBe(1);
  });

  it('a rack whose blast has not happened is not usable, however old the cure', () => {
    const s = settings();
    const batch = rack({ routeSnapshot: 'shotblast', stage: 'awaiting_shotblast', blastedQty: 0, qty: 10 });
    const state = cureState(batch, s, MONDAY + 30 * DAY);
    expect(state.cureDone).toBe(true);
    expect(state.ready).toBe(false);
    // And it has no date anyone can plan around: the blaster decides.
    expect(state.planDate).toBeNull();
    expect(cureBucket(state, MONDAY)).toBe('waiting');
  });

  it('blasting ends the cure when the shop says it does, and does not when it does not', () => {
    const batch = rack({
      routeSnapshot: 'shotblast',
      stage: 'awaiting_shotblast',
      madeAt: MONDAY - DAY,
      cureDays: 5,
      blastedQty: 10,
      blastedAt: MONDAY - 3_600_000,
    });
    expect(cureState(batch, settings({ blastingCompletesCure: true }), MONDAY).ready).toBe(true);
    expect(cureState(batch, settings({ blastingCompletesCure: false }), MONDAY).ready).toBe(false);
  });
});

describe('the list a person reads', () => {
  it('groups by when the rack can be used, and puts the ones waiting for a blast apart', () => {
    const s = settings();
    const rows = [
      // Cured and still sitting there.
      rack({ batchNo: 'A', madeAt: MONDAY - 4 * DAY, cureDays: 2 }),
      // A cure measured in hours comes due in the middle of a day, which is the
      // only way a rack is "still on today" rather than already off.
      rack({ batchNo: 'H', madeAt: MONDAY - DAY, cureDays: 2, cureDueAt: MONDAY + 3 * 3_600_000 }),
      rack({ batchNo: 'B', madeAt: MONDAY - 3 * DAY, cureDays: 4 }),
      rack({ batchNo: 'C', madeAt: MONDAY, cureDays: 7 }),
      rack({ batchNo: 'D', madeAt: MONDAY + DAY, cureDays: 14 }),
      rack({ batchNo: 'E', madeAt: MONDAY, cureDays: 1, routeSnapshot: 'shotblast', blastedQty: 0, stage: 'awaiting_shotblast' }),
    ];
    const groups = groupForCure(rows, s, MONDAY);
    expect(groups.map((g) => g.bucket)).toEqual(['waiting', 'now', 'today', 'tomorrow', 'week', 'later']);
    expect(groups.map((g) => g.rows.map((b) => b.batchNo))).toEqual([['E'], ['A'], ['H'], ['B'], ['C'], ['D']]);
  });

  it('orders inside a group by the day it comes off, then by the rack number', () => {
    const s = settings();
    const rows = [
      rack({ batchNo: '2026-09-20-02', madeAt: MONDAY - 2 * DAY, cureDays: 2 }),
      rack({ batchNo: '2026-09-20-01', madeAt: MONDAY - 2 * DAY, cureDays: 2 }),
      rack({ batchNo: '2026-09-19-01', madeAt: MONDAY - 3 * DAY, cureDays: 2 }),
    ];
    const [only] = groupForCure(rows, s, MONDAY);
    expect(only?.rows.map((b) => b.batchNo)).toEqual(['2026-09-19-01', '2026-09-20-01', '2026-09-20-02']);
  });

  it('leaves out a rack that has gone, so it cannot be counted twice', () => {
    const gone = rack({ batchNo: 'Z', stage: 'ready' });
    expect(groupForCure([rack(), gone], settings(), MONDAY)).toHaveLength(1);
  });
});

describe('the figures above the list', () => {
  it('counts racks, trays and what is waiting, and how long the oldest has waited', () => {
    const s = settings();
    const rows = [
      rack({ batchNo: 'A', madeAt: MONDAY - 6 * DAY, cureDays: 2, trays: 5, qty: 10 }),
      rack({ batchNo: 'B', madeAt: MONDAY - 3 * DAY, cureDays: 4, trays: 3, qty: 6 }),
      rack({
        batchNo: 'C',
        madeAt: MONDAY,
        cureDays: 2,
        trays: 2,
        qty: 8,
        routeSnapshot: 'shotblast',
        stage: 'awaiting_shotblast',
        blastedQty: 0,
      }),
      rack({ batchNo: 'D', stage: 'ready' }),
    ];
    const summary = cureSummary(rows, s, MONDAY);
    expect(summary).toMatchObject({ racks: 3, trays: 10, qty: 24, due: 1, awaitingBlast: 1, overdueDays: 4 });
  });

  it('is all zeroes when the racks are empty', () => {
    expect(cureSummary([], settings(), MONDAY)).toMatchObject({ racks: 0, trays: 0, due: 0, awaitingBlast: 0 });
  });
});

describe('refusing a move, in a sentence', () => {
  const s = settings();

  it('will not call a curing rack ready, and says when it will be', () => {
    const still = rack({ madeAt: MONDAY - DAY, cureDays: 3 });
    const refusal = moveProblem(still, 'ready', s, MONDAY);
    expect(refusal).toContain('still curing');
    expect(refusal).toContain('in 2 days');
  });

  it('names what is still to go, without guessing at a unit', () => {
    const batch = rack({ routeSnapshot: 'shotblast', stage: 'blasting', blastedQty: 4, qty: 10 });
    expect(moveProblem(batch, 'ready', s, MONDAY)).toBe('2026-09-19-01 still has 6 to go through the blaster.');
  });

  it('lets a rack that has had it through', () => {
    const batch = rack({ madeAt: MONDAY - 3 * DAY, cureDays: 2 });
    expect(moveProblem(batch, 'ready', s, MONDAY)).toBeNull();
  });

  it('says so when the rack is already where it is being sent', () => {
    expect(moveProblem(rack({ stage: 'curing' }), 'curing', s, MONDAY)).toBe('It is already marked curing.');
  });

  it('sends MYOB entry to the screen that does it, where the week’s run is decided', () => {
    expect(moveProblem(rack(), 'entered_myob', s, MONDAY)).toContain('MYOB entry queue');
  });

  it('does not move a rack that is keyed into MYOB, or one that was written off', () => {
    const keyed = rack({ enteredAt: MONDAY, stage: 'entered_myob' });
    expect(moveProblem(keyed, 'ready', s, MONDAY)).toContain('keyed into MYOB');
    const off = rack({ stage: 'written_off' });
    expect(moveProblem(off, 'ready', s, MONDAY)).toContain('log it as a new make');
  });

  it('will not put a blasted rack back in the blaster’s queue, but will take an early one off the ready pile', () => {
    const blasted = rack({ routeSnapshot: 'shotblast', stage: 'curing', blastedQty: 10, qty: 10 });
    expect(moveProblem(blasted, 'blasting', s, MONDAY)).toContain('already had its blast');
    // Someone marking a rack ready a day early has to be able to put it back
    // without a phone call.
    expect(moveProblem(rack({ stage: 'ready' }), 'curing', s, MONDAY)).toBeNull();
  });

  it('accepts a write-off for anything still on the floor', () => {
    for (const stage of ['green', 'curing', 'awaiting_shotblast', 'blasting', 'ready'] as BatchStage[]) {
      expect(moveProblem(rack({ stage }), 'written_off', s, MONDAY)).toBeNull();
    }
  });
});
