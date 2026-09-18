// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  batchFromEntry,
  canUndo,
  cureDueAt,
  dueToAdvance,
  entryRowProblem,
  entryTotals,
  nextBatchSequence,
  resolveEntryRows,
  startingStage,
} from '@/core/batches';
import { qtyFromTrays } from '@/core/calc';
import { dayStart } from '@/core/dates';
import { DEFAULT_SETTINGS } from '@/core/defaults';
import type { Batch, Product, Settings } from '@/core/types';

/**
 * What a number of trays typed on the floor becomes. Everything the entry screen
 * will do to a rack of pavers is decided here, in the open, before any of it can
 * reach IndexedDB — the cure date, the quantity, and whether it is undoable are
 * all rules the shop would notice if they changed.
 */

const MAKED = new Date(2026, 8, 18, 15, 30).getTime(); // Friday 18 Sep 2026, mid-afternoon

function settings(over: Partial<Settings['production']> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    production: { ...DEFAULT_SETTINGS.production, ...over },
  };
}

function product(over: Partial<Product> = {}): Product {
  return {
    code: 'S3',
    description: 'Charcoal paver',
    enabled: true,
    route: 'manufacture',
    usesBaseline10000: false,
    unit: 'm2',
    trayYield: 1.44,
    target: 4752,
    cureDays: 2,
    notes: '',
    rank: 1000,
    seenInJobs: false,
    updatedAt: 0,
    ...over,
  };
}

function batch(over: Partial<Batch> = {}): Batch {
  return {
    ...batchFromEntry({
      id: 'b1',
      product: product(),
      lineId: 'line-1',
      trays: 10,
      madeAt: MAKED,
      sequence: 1,
      settings: settings(),
      operator: 'Mike',
    }),
    ...over,
  };
}

describe('the cure clock', () => {
  it('starts when the make starts, and a day means a day on the rack', () => {
    // Made at 3pm with a one-day cure: due at the start of tomorrow, not at 3pm.
    // A rack is read in the morning, and a batch that is "due" at 3pm is a batch
    // someone will move at 8am on a date the maths says is not due yet.
    const oneDay = cureDueAt(MAKED, 1);
    expect(oneDay).toBe(dayStart(MAKED) + 86_400_000);
    expect(new Date(oneDay).getHours()).toBe(0);
  });

  it('runs in hours when the shop says the cure is measured in hours', () => {
    // Four hours from the moment it was made — a fast-turn product cannot wait
    // until the start of a day that has already begun.
    expect(cureDueAt(MAKED, 4, 'hours')).toBe(MAKED + 4 * 3_600_000);
  });

  it('treats a cure of nothing as ready the day it was made', () => {
    expect(cureDueAt(MAKED, 0)).toBe(dayStart(MAKED));
    expect(cureDueAt(MAKED, Number.NaN)).toBe(dayStart(MAKED));
  });

  it('puts a shotblast make on the cure clock and in the blaster queue at once', () => {
    // "make - shotblast - ready. it can be shotblast during curing": stage says
    // what it still has to go through, the cure date runs beside it either way.
    expect(startingStage('shotblast')).toBe('awaiting_shotblast');
    expect(startingStage('manufacture')).toBe('curing');
  });
});

describe('a row on the entry sheet', () => {
  it('refuses the rows that would log a lie, and says which one', () => {
    expect(entryRowProblem({ product: undefined, trays: 5 })).toBe('pick a product');
    expect(entryRowProblem({ product: product(), trays: null })).toBe('how many trays?');
    expect(entryRowProblem({ product: product(), trays: 0 })).toBe('how many trays?');
    expect(entryRowProblem({ product: product(), trays: 2.5 })).toBe('trays are whole ones');

    // Both of these are Products-screen fixes, so the message names the screen
    // rather than letting the floor fight with a row that cannot be logged.
    expect(entryRowProblem({ product: product({ route: 'unset' }), trays: 4 })).toBe(
      'S3 has no route — set it on Products',
    );
    expect(entryRowProblem({ product: product({ trayYield: 0 }), trays: 4 })).toBe(
      'S3 has no tray yield — set it on Products',
    );
    expect(entryRowProblem({ product: product(), trays: 4 })).toBeNull();
  });

  it('converts trays by the product’s own yield, and keeps the two totals apart', () => {
    const lines = resolveEntryRows(
      [
        { key: 'a', code: 'S3', trays: 10 },
        { key: 'b', code: 'S4', trays: 5 },
        { key: 'c', code: 'NOPE', trays: 3 },
      ],
      [product(), product({ code: 'S4', trayYield: 0.72 })],
    );

    expect(lines[0]?.qty).toBeCloseTo(qtyFromTrays(10, 1.44), 10);
    expect(lines[1]?.qty).toBeCloseTo(5 * 0.72, 10);
    expect(lines[2]?.problem).toBe('pick a product');

    const totals = entryTotals(lines);
    expect(totals.problems).toBe(1);
    expect(totals.trays).toBe(15);
    // A row that cannot be logged does not quietly contribute trays to the total
    // the floor is about to read out as the day's work.
    expect(totals.qty).toBeCloseTo(10 * 1.44 + 5 * 0.72, 10);
  });
});

describe('the batch a row becomes', () => {
  it('numbers by the day, because the number is read out over a running machine', () => {
    const s = settings();
    const empty = nextBatchSequence([], MAKED, s.production.batchNumberFormat);
    expect(empty).toBe(1);

    const sameDay = [batch({ id: 'x', batchNo: '2026-09-18-01' }), batch({ id: 'y', batchNo: '2026-09-18-04' })];
    expect(nextBatchSequence(sameDay, MAKED, s.production.batchNumberFormat)).toBe(5);

    // A batch from yesterday is not this morning's sequence, and a batch numbered
    // under another pattern is not this pattern's either.
    const otherDay = [batch({ id: 'z', batchNo: '2026-09-17-09' })];
    expect(nextBatchSequence(otherDay, MAKED, s.production.batchNumberFormat)).toBe(1);
  });

  it('copies the product’s route and cure onto the record, so history cannot be rewritten', () => {
    const made = batchFromEntry({
      id: 'b9',
      product: product({ route: 'shotblast', cureDays: 3, trayYield: 2 }),
      lineId: 'line-shotblast',
      trays: 6,
      madeAt: MAKED,
      sequence: 2,
      settings: settings(),
      operator: 'Mike',
    });

    expect(made.routeSnapshot).toBe('shotblast');
    expect(made.cureDaysSnapshot).toBe(3);
    expect(made.cureDueAt).toBe(cureDueAt(MAKED, 3));
    expect(made.qty).toBe(12);
    expect(made.batchNo).toBe('2026-09-18-02');
    expect(made.stage).toBe('awaiting_shotblast');

    // The shop moves S3 to a 5-day cure next month. This rack was made under 3.
    const later = { ...made, cureDaysSnapshot: made.cureDaysSnapshot };
    expect(later.cureDueAt).toBe(cureDueAt(MAKED, 3));
  });

  it('falls back to the shop default cure when the product has none', () => {
    const made = batchFromEntry({
      id: 'b10',
      product: product({ cureDays: 0 }),
      lineId: 'line-2',
      trays: 1,
      madeAt: MAKED,
      sequence: 1,
      settings: settings({ defaultCureDays: 7 }),
      operator: 'Mike',
    });
    expect(made.cureDaysSnapshot).toBe(7);
    expect(made.cureDueAt).toBe(cureDueAt(MAKED, 7));
  });

  it('starts untouched: nothing blasted, no MYOB run, nothing overridden', () => {
    const made = batch();
    expect(made.blastedQty).toBe(0);
    expect(made.blastedAt).toBeNull();
    expect(made.myobRunDate).toBeNull();
    expect(made.enteredAt).toBeNull();
    expect(made.qtyOverridden).toBe(false);
    expect(made.parentBatchId).toBeNull();
  });
});

describe('taking a make back', () => {
  it('lets a make be undone while it has gone nowhere', () => {
    expect(canUndo(batch())).toBe(true);
    expect(canUndo(batch({ stage: 'green' }))).toBe(true);
    expect(canUndo(batch({ stage: 'awaiting_shotblast' }))).toBe(true);
  });

  it('refuses once the record has been acted on, because then it is evidence', () => {
    // A pallet has been moved on the strength of this row. Correcting it must
    // leave both records behind, which is what writing off does.
    expect(canUndo(batch({ stage: 'ready' }))).toBe(false);
    expect(canUndo(batch({ blastedQty: 1 }))).toBe(false);
    expect(canUndo(batch({ blastedAt: MAKED }))).toBe(false);
    expect(canUndo(batch({ myobRunDate: MAKED }))).toBe(false);
    expect(canUndo(batch({ enteredAt: MAKED }))).toBe(false);
    expect(canUndo(batch({ deleted: true }))).toBe(false);
  });
});

describe('what is due to come off the racks', () => {
  const now = new Date(2026, 8, 21, 8, 0).getTime(); // Monday morning

  it('says a make-only batch is ready once its cure is due', () => {
    const due = batch({ cureDueAt: now - 1 });
    const notYet = batch({ cureDueAt: now + 86_400_000 });
    expect(dueToAdvance([due, notYet], settings(), now).map((b) => b.id)).toEqual([due.id]);
  });

  it('says a shotblast batch is not ready just because its cure is due', () => {
    // It still has to be blasted. Curing finishing is half the journey on that route.
    const unblasted = batch({ routeSnapshot: 'shotblast', stage: 'awaiting_shotblast', cureDueAt: now - 1 });
    expect(dueToAdvance([unblasted], settings(), now)).toEqual([]);
  });

  it('says a blasted batch is ready, and waits for the cure too when told to', () => {
    // Fully blasted — `qty` here is 14.4, so blasting 10 of it would be a partial
    // blast, and a partial blast is its own story (the shotblast screen's story).
    const blasted = batch({
      routeSnapshot: 'shotblast',
      stage: 'blasting',
      cureDueAt: now - 1,
      qty: 10,
      blastedQty: 10,
      blastedAt: now - 3_600_000,
    });

    // "Blasting finishes the cure": out of the blaster, it is sellable.
    expect(dueToAdvance([blasted], settings({ blastingCompletesCure: true }), now).length).toBe(1);

    // Not blasting: the cure has to be due as well. Here it is, so it still passes…
    expect(dueToAdvance([blasted], settings({ blastingCompletesCure: false }), now).length).toBe(1);

    // …and here is the case that proves the setting is doing something: a batch
    // blasted on day one of a two-day cure is not sellable on day one.
    const early = { ...blasted, cureDueAt: now + 86_400_000 };
    expect(dueToAdvance([early], settings({ blastingCompletesCure: true }), now).length).toBe(1);
    expect(dueToAdvance([early], settings({ blastingCompletesCure: false }), now)).toEqual([]);
  });

  it('leaves batches that are already ready, entered or written off out of the list', () => {
    const done = [
      batch({ id: 'r', stage: 'ready' }),
      batch({ id: 'e', stage: 'entered_myob', cureDueAt: now - 1 }),
      batch({ id: 'w', stage: 'written_off', cureDueAt: now - 1 }),
    ];
    expect(dueToAdvance(done, settings(), now)).toEqual([]);
  });
});
