// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@/core/defaults';
import {
  awaitsEntry,
  copyOutCsv,
  copyOutTsv,
  entryQueue,
  entryRuns,
  enterProblem,
  exportCell,
  groupForExport,
  heldBack,
  keyedSince,
  memoFor,
  runDateFor,
  runTotals,
  unenterProblem,
} from '@/core/myobQueue';
import type { Batch, BatchStage, Product, Settings } from '@/core/types';

/**
 * The weekly run.
 *
 * One rule carries the whole file: the run date is derived, never remembered. If
 * this file ever needs a stored `myobRunDate` to pass, the design has been
 * broken — the week a rack belongs to is a function of when it became ready and
 * the shop's cut-off, and both of those can be corrected after the fact.
 */

const DAY = 86_400_000;
const at = (day: number, hour = 9): number => new Date(2026, 8, day, hour, 0).getTime();

// 18 September 2026 is a Friday, which is the shop's default entry weekday. A run
// date is a *day*, so it is midnight — `nextWeekday` floors it, and everything
// downstream compares against it.
const FRIDAY = new Date(2026, 8, 18, 0, 0).getTime();
const WEDNESDAY = at(16);
const NEXT_FRIDAY = FRIDAY + 7 * DAY;
// Asking on a Friday afternoon, after the midday cut-off. Half the tests are about
// which side of that line a rack fell on.
const NOW = at(18, 15);

function settings(over: Partial<Settings['myobEntry']> = {}): Settings {
  return { ...DEFAULT_SETTINGS, myobEntry: { ...DEFAULT_SETTINGS.myobEntry, ...over } };
}

function rack(over: Partial<Batch> = {}): Batch {
  const madeAt = over.madeAt ?? WEDNESDAY - 2 * DAY;
  return {
    id: over.id ?? `b-${over.batchNo ?? 'x'}`,
    batchNo: over.batchNo ?? '2026-09-16-01',
    code: over.code ?? 'A3',
    lineId: 'line-1',
    trays: over.trays ?? 5,
    qty: over.qty ?? 10,
    qtyOverridden: over.qtyOverridden ?? false,
    routeSnapshot: over.routeSnapshot ?? 'manufacture',
    stage: (over.stage ?? 'ready') as BatchStage,
    madeAt,
    cureDaysSnapshot: over.cureDaysSnapshot ?? 2,
    cureDueAt: over.cureDueAt ?? madeAt + 2 * DAY,
    blastedQty: over.blastedQty ?? 0,
    blastedAt: over.blastedAt ?? null,
    myobRunDate: over.myobRunDate ?? null,
    enteredAt: over.enteredAt ?? null,
    enteredRef: over.enteredRef ?? '',
    operator: over.operator ?? 'Sam',
    note: over.note ?? '',
    rank: over.rank ?? 0,
    parentBatchId: over.parentBatchId ?? null,
    updatedAt: over.updatedAt ?? madeAt,
    deleted: over.deleted,
  };
}

function product(code: string, over: Partial<Product> = {}): Product {
  return {
    code,
    description: over.description ?? `Stone ${code}`,
    enabled: over.enabled ?? true,
    route: over.route ?? 'manufacture',
    usesBaseline10000: over.usesBaseline10000 ?? false,
    unit: over.unit ?? 'm2',
    trayYield: over.trayYield ?? 2,
    target: over.target ?? 0,
    cureDays: over.cureDays ?? 2,
    notes: over.notes ?? '',
    rank: over.rank ?? 0,
    seenInJobs: over.seenInJobs ?? false,
    updatedAt: over.updatedAt ?? 1,
  };
}

describe('what is waiting to be keyed', () => {
  it('is a rack that is off the racks and has not been keyed', () => {
    expect(awaitsEntry(rack())).toBe(true);
    expect(awaitsEntry(rack({ enteredAt: NOW }))).toBe(false);
    expect(awaitsEntry(rack({ stage: 'curing' }))).toBe(false);
    expect(awaitsEntry(rack({ stage: 'written_off' }))).toBe(false);
    expect(awaitsEntry(rack({ deleted: true }))).toBe(false);
  });

  it('has a run date worked out from when it became ready', () => {
    // Ready on Wednesday, cut-off Friday midday: this week's run.
    expect(runDateFor(rack(), settings(), NOW)).toBe(FRIDAY);
  });

  it('rolls to the next run when the cut-off has passed', () => {
    const lateOnFriday = rack({ cureDueAt: at(18, 14), madeAt: at(16, 14) });
    expect(runDateFor(lateOnFriday, settings(), NOW)).toBe(NEXT_FRIDAY);
    // The same day, come to hand before the cut-off: this week's run. What decides
    // it is when the rack was ready, not when somebody happens to look.
    const beforeCutOff = rack({ cureDueAt: at(18, 11), madeAt: at(16, 11) });
    expect(runDateFor(beforeCutOff, settings(), NOW)).toBe(FRIDAY);
    // And a shop that never cuts off never rolls at all.
    expect(runDateFor(lateOnFriday, settings({ cutoffHours: 24 }), NOW)).toBe(FRIDAY);
  });

  it('has no run date while it is not ready', () => {
    expect(runDateFor(rack({ cureDueAt: NOW + DAY }), settings(), NOW)).toBeNull();
  });

  it('orders the queue by run, then by the oldest make inside it', () => {
    const rows = entryQueue(
      [
        rack({ batchNo: 'late', cureDueAt: at(18, 14), madeAt: at(17, 14) }),
        rack({ batchNo: 'old', madeAt: WEDNESDAY - 6 * DAY }),
        rack({ batchNo: 'new', madeAt: WEDNESDAY - DAY }),
      ],
      settings(),
      NOW,
    );
    // The afternoon-ready rack belongs to next week, so it is last despite being
    // the most recently made.
    expect(rows.map((r) => r.batch.batchNo)).toEqual(['old', 'new', 'late']);
    expect(rows.map((r) => r.runDate)).toEqual([FRIDAY, FRIDAY, NEXT_FRIDAY]);
  });

  it('leaves out a rack whose stage says ready but whose cure does not, and names it', () => {
    const stillCuring = rack({ batchNo: 'WEIRD', cureDueAt: NOW + 4 * DAY });
    const queue = entryQueue([rack({ batchNo: 'OK' }), stillCuring], settings(), NOW);
    expect(queue.map((r) => r.batch.batchNo)).toEqual(['OK']);
    expect(heldBack([rack({ batchNo: 'OK' }), stillCuring], settings(), NOW).map((b) => b.batchNo)).toEqual(['WEIRD']);
    // Keyed or written-off racks are not "waiting" either way, so they are not named.
    expect(heldBack([rack({ batchNo: 'K', cureDueAt: NOW + 4 * DAY, enteredAt: NOW })], settings(), NOW)).toEqual([]);
  });

  it('splits the queue into runs, soonest first', () => {
    const rows = entryQueue(
      [rack({ batchNo: 'a' }), rack({ batchNo: 'b', cureDueAt: at(18, 14), madeAt: at(17, 14) })],
      settings(),
      NOW,
    );
    const runs = entryRuns(rows);
    expect(runs).toHaveLength(2);
    expect(runs[0]?.runDate).toBe(FRIDAY);
    expect(runs[0]?.rows.map((r) => r.batch.batchNo)).toEqual(['a']);
    expect(runs[1]?.runDate).toBe(NEXT_FRIDAY);
  });

  it('keeps quantities in different units apart', () => {
    const rows = entryQueue([rack({ batchNo: 'a', code: 'A3', qty: 10 }), rack({ batchNo: 'b', code: 'L1', qty: 30 })], settings(), NOW);
    const totals = runTotals(rows, (code) => (code === 'L1' ? 'lm' : 'm2'));
    expect(totals).toMatchObject({ racks: 2, trays: 10, codes: 2 });
    expect(totals.byUnit).toEqual([
      { unit: 'lm', qty: 30 },
      { unit: 'm2', qty: 10 },
    ]);
  });
});

describe('the copy-out', () => {
  const rows = entryQueue(
    [
      rack({ batchNo: 'r1', code: 'A3', qty: 10, trays: 5 }),
      rack({ batchNo: 'r2', code: 'A3', qty: 4, trays: 2 }),
      rack({ batchNo: 'r3', code: 'B2', qty: 6, trays: 3 }),
    ],
    settings(),
    NOW,
  );
  const products = [product('A3'), product('B2', { description: 'Bespoke, large', unit: 'm2' })];

  it('puts one line per item code, with every rack named on it', () => {
    const lines = groupForExport(rows, products, settings(), FRIDAY);
    expect(lines.map((l) => [l.code, l.qty, l.racks])).toEqual([
      ['A3', 14, 2],
      ['B2', 6, 1],
    ]);
    expect(lines[0]?.batchNos).toEqual(['r1', 'r2']);
    expect(lines[1]?.description).toBe('Bespoke, large');
  });

  it('writes the memo from the template, with the run date in it', () => {
    const lines = groupForExport(rows, products, settings(), FRIDAY);
    expect(lines[0]?.memo).toBe('Cured/blasted production 18/09/2026');
    expect(memoFor('Weekly run {runDate} — {code}', NEXT_FRIDAY)).toBe('Weekly run 25/09/2026 — {code}');
    expect(memoFor('No date here', FRIDAY)).toBe('No date here');
  });

  it('still lists a code whose product has gone missing', () => {
    const lines = groupForExport(rows, [product('A3')], settings(), FRIDAY);
    expect(lines.map((l) => [l.code, l.description, l.unit])).toEqual([
      ['A3', 'Stone A3', 'm2'],
      ['B2', '', 'pieces'],
    ]);
  });

  it('answers the columns Settings asks for, and nothing it does not know', () => {
    const line = groupForExport(rows, products, settings(), FRIDAY)[0];
    if (line === undefined) throw new Error('no export line');
    expect(exportCell(line, 'code')).toBe('A3');
    expect(exportCell(line, 'qty')).toBe('14');
    expect(exportCell(line, 'racks')).toBe('2');
    expect(exportCell(line, 'batches')).toBe('r1 r2');
    expect(exportCell(line, 'colour')).toBe('');
  });

  it('copies out in the column order the shop configured', () => {
    const columns = [
      { key: 'qty', header: 'Quantity' },
      { key: 'code', header: 'Item No.' },
      { key: 'memo', header: 'Memo' },
    ];
    const tsv = copyOutTsv(groupForExport(rows, products, settings(), FRIDAY), columns);
    expect(tsv.split('\r\n')[0]).toBe('Quantity\tItem No.\tMemo');
    expect(tsv.split('\r\n')[1]).toBe(`14\tA3\tCured/blasted production 18/09/2026`);
    expect(tsv.split('\r\n')).toHaveLength(3);
  });

  it('strips tabs and newlines from a description rather than breaking the grid', () => {
    const messy = entryQueue([rack({ batchNo: 'r9', code: 'C9' })], settings(), NOW);
    const tsv = copyOutTsv(
      groupForExport(messy, [product('C9', { description: 'One line\ttwo\nthree' })], settings(), FRIDAY),
      [{ key: 'description', header: 'Description' }],
    );
    expect(tsv).toBe('Description\r\nOne line two three');
  });

  it('quotes a CSV cell that contains a comma or a quote', () => {
    const csv = copyOutCsv(groupForExport(rows, products, settings(), FRIDAY), [
      { key: 'code', header: 'Item No.' },
      { key: 'description', header: 'Description' },
    ]);
    expect(csv.split('\r\n')[2]).toBe('B2,"Bespoke, large"');
  });
});

describe('refusals', () => {
  it('accepts a rack that is off the racks and not keyed', () => {
    expect(enterProblem(rack(), settings(), NOW)).toBeNull();
  });

  it('names what is still holding a rack on the racks', () => {
    expect(enterProblem(rack({ cureDueAt: NOW + 2 * DAY }), settings(), NOW)).toBe('2026-09-16-01 is still curing — due in 2 days.');
    const owesBlast = rack({ routeSnapshot: 'shotblast', blastedQty: 0, cureDueAt: WEDNESDAY - DAY });
    expect(enterProblem(owesBlast, settings(), NOW)).toBe('2026-09-16-01 still has 10 to go through the blaster.');
  });

  it('will not key the same rack into MYOB twice', () => {
    const keyed = rack({ enteredAt: NOW, myobRunDate: FRIDAY });
    expect(enterProblem(keyed, settings(), NOW)).toBe('2026-09-16-01 is already keyed into MYOB for 18/09/2026. Take it back out first if that was a mistake.');
  });

  it('refuses a rack that has left the shop by another door', () => {
    expect(enterProblem(rack({ deleted: true }), settings(), NOW)).toBe('That rack has been taken back, so there is nothing to put into MYOB.');
    expect(enterProblem(rack({ stage: 'written_off' }), settings(), NOW)).toContain('was written off');
  });

  it('says so when a rack claims to be in MYOB without being keyed', () => {
    expect(enterProblem(rack({ stage: 'entered_myob' }), settings(), NOW)).toBe(
      '2026-09-16-01 is marked in MYOB but has no entry time on it. Put it back on the racks and bring it through again.',
    );
  });

  it('only takes back a rack that was actually keyed', () => {
    expect(unenterProblem(rack({ enteredAt: NOW }))).toBeNull();
    expect(unenterProblem(rack())).toBe('2026-09-16-01 has not been keyed into MYOB, so there is nothing to take back.');
    expect(unenterProblem(rack({ enteredAt: NOW, deleted: true }))).toBe('That rack has been taken back, so there is nothing to take out of MYOB.');
  });
});

describe('the keyed pile after the export', () => {
  it('lists what was keyed after the stock export was taken, newest first', () => {
    const since = keyedSince(
      [
        rack({ batchNo: 'before', enteredAt: NOW - 2 * DAY }),
        rack({ batchNo: 'after', enteredAt: NOW + DAY }),
        rack({ batchNo: 'newest', enteredAt: NOW + 2 * DAY }),
        rack({ batchNo: 'notkeyed' }),
      ],
      NOW,
      NOW + 3 * DAY,
    );
    expect(since.map((b) => b.batchNo)).toEqual(['newest', 'after']);
  });

  it('with no export on the device, everything still on the pile is shown', () => {
    const since = keyedSince([rack({ batchNo: 'a', enteredAt: NOW - 3 * DAY })], null, NOW);
    expect(since.map((b) => b.batchNo)).toEqual(['a']);
  });

  it('drops a keying old enough that the export must have caught it', () => {
    expect(keyedSince([rack({ batchNo: 'old', enteredAt: NOW - 40 * DAY })], NOW - 60 * DAY, NOW)).toEqual([]);
  });
});
