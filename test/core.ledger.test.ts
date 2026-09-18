import { describe, expect, it } from 'vitest';
import { dayStart } from '@/core/dates';
import {
  LEDGER_ACTIONS,
  LEDGER_FAMILIES,
  actorsIn,
  dayLabel,
  familyCounts,
  familyMeta,
  familyOf,
  filterLedger,
  groupDays,
  isRackLine,
  labelOf,
  ledgerLine,
  shortDevice as ledgerDevice,
  matches,
  spanOf,
  summariseDay,
} from '@/core/ledger';
import type { EventAction, EventLog } from '@/core/types';

/**
 * Reading the ledger.
 *
 * The lines themselves are written by the screens that did the work, so what is
 * tested here is the reading: that every action has a name and a place to live, that
 * a line with no sentence on it still says something, that days fall where a person
 * would put them, and that a filter does what the chip says it does.
 */

const DAY = 86_400_000;
/** Friday 18/09/2026, 3pm — the "now" everything is measured against. */
const NOW = new Date(2026, 8, 18, 15, 0).getTime();

function at(dayOffset: number, hour = 9, minute = 0): number {
  const base = dayStart(NOW) + dayOffset * DAY;
  return base + hour * 3_600_000 + minute * 60_000;
}

function ev(over: Partial<EventLog> = {}): EventLog {
  return {
    id: over.id ?? `ev-${Math.random().toString(36).slice(2)}`,
    at: over.at ?? NOW,
    action: over.action ?? 'batch.create',
    batchId: over.batchId ?? null,
    code: over.code ?? null,
    fromStage: over.fromStage ?? null,
    toStage: over.toStage ?? null,
    qty: over.qty ?? 0,
    trays: over.trays ?? 0,
    device: over.device ?? 'floor tablet',
    actor: over.actor ?? 'Test Person',
    detail: over.detail ?? '',
  };
}

describe('the action map', () => {
  const actions = Object.keys(LEDGER_ACTIONS) as EventAction[];

  it('names every action, in a family that exists', () => {
    const families = new Set(LEDGER_FAMILIES.map((f) => f.key));
    for (const action of actions) {
      expect(labelOf(action).trim(), action).not.toBe('');
      expect(families.has(familyOf(action)), action).toBe(true);
    }
    // Nothing written by the app is filed under a family the filter chips do not
    // offer. A family nobody uses is a chip that leads to an empty screen.
    const used = new Set(actions.map((a) => familyOf(a)));
    for (const family of families) expect(used.has(family), family).toBe(true);
  });

  it('puts the make side on the floor and the keying under MYOB', () => {
    expect(familyOf('batch.create')).toBe('floor');
    expect(familyOf('batch.blast')).toBe('floor');
    expect(familyOf('batch.writeOff')).toBe('floor');
    expect(familyOf('batch.undo')).toBe('floor');
    expect(familyOf('batch.enterMyob')).toBe('myob');
    expect(familyOf('import.commit')).toBe('stock');
    expect(familyOf('auth.signin')).toBe('people');
    expect(familyOf('view.setDefault')).toBe('shop');
  });

  it('has a hint for every chip, so a filter can explain itself', () => {
    for (const family of LEDGER_FAMILIES) {
      expect(familyMeta(family.key).hint.length, family.key).toBeGreaterThan(20);
    }
    expect(() => familyMeta('nonsense' as never)).toThrow(/no ledger family/);
  });
});

describe('the line on the row', () => {
  it('shows the sentence the writer left', () => {
    const line = ev({ detail: '2026-09-14-01 keyed into MYOB — run 18/09/2026 · ref INV-42' });
    expect(ledgerLine(line)).toBe('2026-09-14-01 keyed into MYOB — run 18/09/2026 · ref INV-42');
  });

  it('still says something when a writer left the detail empty', () => {
    // A blank row in a log is the one thing a log may never be.
    expect(ledgerLine(ev({ action: 'batch.move', trays: 5, qty: 10, code: 'A3' }))).toBe(
      'Rack moved — 5 trays · 10 A3',
    );
    expect(ledgerLine(ev({ action: 'batch.move', trays: 3 }))).toBe('Rack moved — 3 trays');
    expect(ledgerLine(ev({ action: 'product.update', code: 'GL4' }))).toBe('Product changed — GL4');
    expect(ledgerLine(ev({ action: 'auth.signout' }))).toBe('Signed out');
  });

  it('trims a detail that is only spaces', () => {
    expect(ledgerLine(ev({ action: 'auth.signin', detail: '   ' }))).toBe('Signed in');
  });

  it('shortens a device id to something a phone line can carry', () => {
    // The ledger stores the id; a name only exists once someone renames the tablet
    // in People. The id is the only true thing to say, so say it briefly.
    expect(ledgerDevice('dev_8f4c1a2e-3b77-4c10-9a11-0d2e4f6a8b0c')).toBe('8f4c1a2e…');
    expect(ledgerDevice('dev_floor-tablet')).toBe('floor-tablet');
    expect(ledgerDevice('device')).toBe('an unnamed device');
    expect(ledgerDevice('')).toBe('an unnamed device');
  });

  it('knows which lines are about a rack', () => {
    expect(isRackLine(ev({ batchId: 'b-1' }))).toBe(true);
    expect(isRackLine(ev({ batchId: null }))).toBe(false);
    expect(isRackLine(ev({ batchId: '' }))).toBe(false);
  });
});

describe('days', () => {
  it('calls a line from yesterday yesterday, and one from today today', () => {
    expect(dayLabel(at(0, 6), NOW)).toBe('Today');
    expect(dayLabel(at(-1, 23), NOW)).toBe('Yesterday');
    expect(dayLabel(at(-2), NOW)).toBe('Wed 16/09/2026');
    // A device whose clock is running ahead is still today, not yesterday.
    expect(dayLabel(NOW + 2 * DAY, NOW)).toBe('Today');
  });

  it('groups lines into days, newest day first and newest line first inside', () => {
    const days = groupDays(
      [
        ev({ id: 'a', at: at(-2, 8) }),
        ev({ id: 'b', at: at(0, 9) }),
        ev({ id: 'c', at: at(-1, 12) }),
        ev({ id: 'd', at: at(0, 14, 30) }),
      ],
      NOW,
    );
    expect(days.map((d) => d.label)).toEqual(['Today', 'Yesterday', 'Wed 16/09/2026']);
    expect(days[0]?.items.map((e) => e.id)).toEqual(['d', 'b']);
    expect(days[1]?.items.map((e) => e.id)).toEqual(['c']);
  });

  it('breaks a tie between two lines in the same second by id', () => {
    const days = groupDays([ev({ id: 'aa', at: at(0, 9) }), ev({ id: 'bb', at: at(0, 9) })], NOW);
    expect(days[0]?.items.map((e) => e.id)).toEqual(['bb', 'aa']);
  });

  it('has no days when nothing has been logged', () => {
    expect(groupDays([], NOW)).toEqual([]);
  });
});

describe('what a day was made of', () => {
  it('counts the families the chips use, in the chips’ order', () => {
    const summary = summariseDay([
      ev({ action: 'batch.create' }),
      ev({ action: 'batch.move' }),
      ev({ action: 'auth.signin' }),
      ev({ action: 'batch.enterMyob' }),
      ev({ action: 'view.setDefault' }),
      ev({ action: 'product.update' }),
    ]);
    expect(summary).toEqual([
      '2 on the floor',
      '1 keyed into MYOB',
      '1 product or export',
      '1 person or device',
      '1 setting or sync',
    ]);
  });

  it('drops to counters on a phone, where the sentence gets cut off mid-word', () => {
    const items = [
      ev({ action: 'batch.create' }),
      ev({ action: 'batch.move' }),
      ev({ action: 'batch.enterMyob' }),
      ev({ action: 'product.update' }),
      ev({ action: 'auth.signin' }),
    ];
    expect(summariseDay(items, 'terse')).toEqual(['floor 2', 'MYOB 1', 'products 1', 'people 1']);
    // Families in the same order as the chips either way, so the strip and the
    // filters underneath still line up.
    expect(summariseDay(items, 'terse').length).toBe(summariseDay(items, 'words').length);
  });

  it('says nothing about a family with no lines in it', () => {
    expect(summariseDay([ev({ action: 'batch.create' })])).toEqual(['1 on the floor']);
    expect(summariseDay([])).toEqual([]);
  });
});

describe('the filters', () => {
  const lines = [
    ev({ id: 'made', action: 'batch.create', batchId: 'b-1', code: 'A3', trays: 5, detail: 'Logged 5 trays of A3 on Line 1', actor: 'Mia' }),
    ev({ id: 'keyed', action: 'batch.enterMyob', batchId: 'b-1', code: 'A3', detail: '2026-09-14-01 keyed into MYOB — ref INV-42', actor: 'Owner' }),
    ev({ id: 'sign', action: 'auth.signin', detail: 'Mia signed in as maker', actor: 'Mia' }),
    ev({ id: 'load', action: 'import.commit', detail: 'Stock import from location.xlsx: 2691 rows', actor: 'Owner' }),
  ];

  it('keeps the chip that was pressed, and everything when none was', () => {
    expect(filterLedger(lines, { families: ['myob'] }).map((e) => e.id)).toEqual(['keyed']);
    expect(filterLedger(lines, { families: ['myob', 'floor'] }).map((e) => e.id)).toEqual(['made', 'keyed']);
    expect(filterLedger(lines, { families: [] })).toHaveLength(4);
  });

  it('narrows to one rack', () => {
    expect(filterLedger(lines, { batchId: 'b-1' }).map((e) => e.id)).toEqual(['made', 'keyed']);
    expect(filterLedger(lines, { batchId: 'nope' })).toEqual([]);
  });

  it('narrows to a person, by name as it was written', () => {
    expect(filterLedger(lines, { actor: 'Mia' }).map((e) => e.id)).toEqual(['made', 'sign']);
  });

  it('finds a rack number, a reference, and a file name in the words on the line', () => {
    expect(filterLedger(lines, { query: '2026-09-14-01' }).map((e) => e.id)).toEqual(['keyed']);
    expect(filterLedger(lines, { query: 'inv-42' }).map((e) => e.id)).toEqual(['keyed']);
    expect(filterLedger(lines, { query: 'LOCATION.XLSX' }).map((e) => e.id)).toEqual(['load']);
  });

  it('searches the code and the kind as well as the sentence', () => {
    expect(filterLedger(lines, { query: 'A3' }).map((e) => e.id)).toEqual(['made', 'keyed']);
    expect(filterLedger(lines, { query: 'Keyed into MYOB' }).map((e) => e.id)).toEqual(['keyed']);
    expect(filterLedger(lines, { query: 'nothing like this' })).toEqual([]);
  });

  it('combines the filters rather than letting the last one win', () => {
    expect(filterLedger(lines, { families: ['floor'], batchId: 'b-1', query: '5 trays' }).map((e) => e.id)).toEqual(['made']);
    expect(matches(lines[0]!, { families: ['myob'] })).toBe(false);
  });

  it('treats a query of spaces as no query at all', () => {
    expect(filterLedger(lines, { query: '   ' })).toHaveLength(4);
  });
});

describe('who, how many, and over what span', () => {
  const lines = [
    ev({ id: 'a', action: 'batch.create', at: at(0, 9), actor: 'Mia' }),
    ev({ id: 'b', action: 'batch.move', at: at(-1, 9), actor: 'Owner' }),
    ev({ id: 'c', action: 'batch.blast', at: at(-1, 10), actor: 'Mia' }),
    ev({ id: 'd', action: 'auth.signin', at: at(-2, 7), actor: '   ' }),
  ];

  it('lists people by whoever was seen most recently', () => {
    expect(actorsIn(lines)).toEqual([
      { name: 'Mia', count: 2 },
      { name: 'Owner', count: 1 },
      { name: 'nobody signed in', count: 1 },
    ]);
  });

  it('counts the families for the chips', () => {
    const counts = familyCounts(lines);
    expect(counts.get('floor')).toBe(3);
    expect(counts.get('people')).toBe(1);
    expect(counts.has('myob')).toBe(false);
  });

  it('gives the span a window covers, and nothing when it is empty', () => {
    expect(spanOf(lines)).toEqual({ from: at(-2, 7), to: at(0, 9) });
    expect(spanOf([])).toBeNull();
  });
});
