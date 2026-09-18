// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { dayStart } from '@/core/dates';
import type { Batch, EventAction, EventLog } from '@/core/types';
import { db } from '@/data/db';
import { ProductionLog } from '@/screens/ProductionLog';
import { setMediaWidth } from './setup';
import { signInForTests } from './support/who';
import { buttonNamed, click, render, settle, typeInto, type Rendered } from './support/render';

/**
 * The shop's diary, on screen.
 *
 * The rules of the log are tested in `test/core.ledger.test.ts`; what is tested here
 * is what only a screen has to get right: that lines land under the day a person
 * would name, that a filter says how much it hid rather than just shrinking, that
 * *This rack* really does reach back further than the page loaded, and that a device
 * with nothing in it says so instead of showing an empty list.
 */

const DAY = 86_400_000;
const TODAY = dayStart(Date.now());
const at = (dayOffset: number, hour = 9): number => TODAY + dayOffset * DAY + hour * 3_600_000;

function rack(over: Partial<Batch> = {}): Batch {
  return {
    id: over.id ?? 'b-1',
    batchNo: over.batchNo ?? '2026-09-10-01',
    code: over.code ?? 'A3',
    lineId: 'line-1',
    trays: 5,
    qty: 10,
    qtyOverridden: false,
    routeSnapshot: 'manufacture',
    stage: 'ready',
    madeAt: at(-6),
    cureDaysSnapshot: 2,
    cureDueAt: at(-4),
    blastedQty: 0,
    blastedAt: null,
    myobRunDate: null,
    enteredAt: null,
    enteredRef: '',
    operator: 'Test Person',
    note: '',
    rank: 1000,
    parentBatchId: null,
    updatedAt: Date.now(),
    ...over,
  };
}

function line(over: Partial<EventLog>): EventLog {
  return {
    id: over.id ?? `ev-${Math.random().toString(36).slice(2, 8)}`,
    at: over.at ?? at(0, 9),
    action: (over.action ?? 'batch.move') as EventAction,
    batchId: over.batchId ?? null,
    code: over.code ?? null,
    fromStage: null,
    toStage: null,
    qty: over.qty ?? 0,
    trays: over.trays ?? 0,
    device: over.device ?? 'floor tablet',
    actor: over.actor ?? 'Test Person',
    detail: over.detail ?? '',
  };
}

async function seed(events: EventLog[], batches: Batch[] = []): Promise<void> {
  signInForTests('maker');
  window.location.hash = '#/log';
  await Promise.all([db.events.clear(), db.batches.clear()]);
  if (batches.length > 0) await db.batches.bulkAdd(batches);
  if (events.length > 0) await db.events.bulkAdd(events);
}

const linesOn = (r: Rendered): Element[] => [...r.host.querySelectorAll('[data-log-line]')];
const textOf = (el: Element | undefined): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const dayHeadings = (r: Rendered): string[] => [...r.host.querySelectorAll('h2')].map((h) => h.textContent ?? '');
const says = (text: string, root: ParentNode = document.body): boolean => (root.textContent ?? '').includes(text);

beforeEach(() => {
  setMediaWidth(1280);
});

describe('the diary', () => {
  it('says so on a device that has logged nothing', async () => {
    await seed([]);
    const r = render(<ProductionLog />);
    await settle();

    expect(says('Nothing logged yet', r.host)).toBe(true);
    expect(linesOn(r)).toHaveLength(0);
  });

  it('groups lines under the day a person would name, newest first', async () => {
    await seed([
      line({ id: 'a', at: at(-3, 8), action: 'batch.create', detail: '2026-09-10-01 logged on Line 1' }),
      line({ id: 'b', at: at(0, 14), detail: '2026-09-14-01 off the racks — 5 trays ready' }),
      line({ id: 'c', at: at(-1, 10), detail: '2026-09-13-01 through the blaster' }),
      line({ id: 'd', at: at(0, 9), action: 'auth.signin', detail: 'Mia signed in as maker', actor: 'Mia' }),
    ]);
    const r = render(<ProductionLog />);
    await settle();

    // The card title is an h2 too, so the diary's own headings come after it.
    expect(dayHeadings(r).slice(1)).toEqual(['Today', 'Yesterday', expect.stringMatching(/^\w{3} \d{2}\/\d{2}\/\d{4}$/)]);
    expect(textOf(linesOn(r)[0])).toContain('off the racks');
    expect(textOf(linesOn(r)[3])).toContain('logged on Line 1');
    // The day says what it was made of before you read a single line.
    const today = [...r.host.querySelectorAll('section')].find((s) => says('Today', s));
    expect(today).toBeDefined();
    expect(textOf(today)).toContain('1 on the floor · 1 person or device');
    expect(says('Mia · floor tablet', r.host)).toBe(true);
  });

  it('shows who did it as nobody signed in when no account was behind it', async () => {
    await seed([line({ id: 'a', actor: '', detail: '2026-09-10-01 put back on the racks' })]);
    const r = render(<ProductionLog />);
    await settle();

    expect(says('nobody signed in', r.host)).toBe(true);
  });

  it('shows a line with no sentence on it as the kind of thing it was', async () => {
    await seed([line({ id: 'a', action: 'batch.blast', trays: 4, qty: 4, code: 'GL4', detail: '' })]);
    const r = render(<ProductionLog />);
    await settle();

    expect(says('Through the blaster — 4 trays · 4 GL4', r.host)).toBe(true);
  });
});

describe('reading it', () => {
  const week = (): EventLog[] => [
    line({ id: 'made', at: at(0, 8), action: 'batch.create', batchId: 'b-1', code: 'A3', trays: 8, detail: '2026-09-14-01 logged on Line 1', actor: 'Mia' }),
    line({ id: 'off', at: at(0, 11), action: 'batch.move', batchId: 'b-1', code: 'A3', detail: '2026-09-14-01 off the racks — 8 trays ready', actor: 'Mia' }),
    line({ id: 'keyed', at: at(-1, 9), action: 'batch.enterMyob', batchId: 'b-1', code: 'A3', detail: '2026-09-14-01 keyed into MYOB — run 18/09/2026 · ref INV-42', actor: 'Owner' }),
    line({ id: 'load', at: at(-1, 8), action: 'import.commit', detail: 'Stock import from location.xlsx: 2691 rows', actor: 'Owner' }),
    line({ id: 'sign', at: at(-2, 7), action: 'auth.signin', detail: 'Mia signed in as maker', actor: 'Mia' }),
  ];

  it('filters by the part of the shop the chip names, and says how much it hid', async () => {
    await seed(week(), [rack()]);
    const r = render(<ProductionLog />);
    await settle();
    expect(linesOn(r)).toHaveLength(5);

    click(buttonNamed(r.host, 'MYOB'));
    await settle();
    expect(linesOn(r)).toHaveLength(1);
    expect(says('keyed into MYOB', r.host)).toBe(true);
    expect(says('4 lines hidden by the filter', r.host)).toBe(true);

    click(buttonNamed(r.host, 'Clear'));
    await settle();
    expect(linesOn(r)).toHaveLength(5);
  });

  it('finds a rack, a reference and a file by the words on the line', async () => {
    await seed(week(), [rack()]);
    const r = render(<ProductionLog />);
    await settle();

    typeInto(r.host.querySelector('[data-log-query]')!, 'INV-42');
    await settle();
    expect(linesOn(r)).toHaveLength(1);
    expect(says('2026-09-14-01 keyed into MYOB', r.host)).toBe(true);

    typeInto(r.host.querySelector('[data-log-query]')!, 'location.xlsx');
    await settle();
    expect(linesOn(r)).toHaveLength(1);
    expect(says('Stock import from location.xlsx', r.host)).toBe(true);

    typeInto(r.host.querySelector('[data-log-query]')!, 'nothing here');
    await settle();
    expect(linesOn(r)).toHaveLength(0);
    expect(says('Nothing matches', r.host)).toBe(true);
    expect(says('“nothing here”', r.host)).toBe(true);

    // With a group and a person on as well, it says all three without turning them
    // into a clause nobody would say out loud.
    click(buttonNamed(r.host, 'MYOB'));
    await settle();
    expect(says('Only by Owner.', r.host)).toBe(false);
    click(buttonNamed(r.host, 'Clear'));
    await settle();
    click(buttonNamed(r.host, 'Mia'));
    click(buttonNamed(r.host, 'Products'));
    await settle();
    expect(says('Only by Mia.', r.host)).toBe(true);
    expect(says('Only products.', r.host)).toBe(true);
  });

  it('narrows to one person when there is more than one in the log', async () => {
    await seed(week(), [rack()]);
    const r = render(<ProductionLog />);
    await settle();

    expect(r.host.querySelector('[data-log-actor-filter="Mia"]')).not.toBeNull();
    click(buttonNamed(r.host, 'Mia'));
    await settle();
    expect(linesOn(r)).toHaveLength(3);
  });

  it('reads back further when asked, and stops offering once it has the lot', async () => {
    const many: EventLog[] = [];
    for (let i = 0; i < 402; i += 1) {
      many.push(line({ id: `x-${i}`, at: at(0, 8) + i * 1000, detail: `line ${i}` }));
    }
    await seed(many);
    const r = render(<ProductionLog />);
    await settle();

    expect(linesOn(r)).toHaveLength(400);
    expect(says('showing 400 of 402', r.host)).toBe(true);

    click(buttonNamed(r.host, 'Show earlier lines'));
    await settle();
    expect(linesOn(r)).toHaveLength(402);
    expect(r.host.querySelector('[data-log-earlier]')).toBeNull();
    expect(says('line 0', r.host)).toBe(true);
  });
});

describe('one rack’s history', () => {
  const history = (): EventLog[] => [
    line({ id: 'old', at: at(-40, 9), batchId: 'b-1', code: 'A3', detail: '2026-09-10-01 logged on Line 1' }),
    line({ id: 'new', at: at(0, 9), batchId: 'b-1', code: 'A3', detail: '2026-09-10-01 keyed into MYOB — ref INV-7' }),
    line({ id: 'else', at: at(0, 10), batchId: 'b-2', code: 'B2', detail: '2026-09-14-02 off the racks — 4 trays ready' }),
  ];

  it('reaches back past the loaded window to the day the rack was made', async () => {
    await seed(history(), [rack()]);
    window.location.hash = '#/log?rack=b-1';
    const r = render(<ProductionLog />);
    await settle();

    expect(says('Every line about 2026-09-10-01 (A3) — 2 lines', r.host)).toBe(true);
    expect(linesOn(r)).toHaveLength(2);
    expect(says('2026-09-10-01 logged on Line 1', r.host)).toBe(true);
    expect(says('2026-09-14-02 off the racks', r.host)).toBe(false);
    window.location.hash = '#/log';
  });

  it('gets there from a line, without losing the diary behind it', async () => {
    await seed(history(), [rack()]);
    const r = render(<ProductionLog />);
    await settle();

    const rackLine = linesOn(r).find((el) => el.getAttribute('data-log-batch') === 'b-1');
    const button = rackLine === undefined ? undefined : [...rackLine.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('This rack'));
    expect(button).toBeDefined();
    click(button!);
    await settle();

    expect(window.location.hash).toBe('#/log?rack=b-1');
    expect(says('One rack’s history', r.host)).toBe(true);
    expect(linesOn(r)).toHaveLength(2);
    // In a rack's own history there is nothing to narrow further.
    expect(r.host.querySelector('[data-log-family-filter]')).toBeNull();
  });

  it('folds a long list of names and says how many it folded away', async () => {
    // A dozen casuals on one device should not turn the filter row into a wall.
    const crowd = Array.from({ length: 11 }, (_, i) =>
      line({ id: `p${i}`, at: at(0, 9), actor: `Person ${i}`, action: 'batch.create' }),
    );
    await seed(crowd);
    const r = render(<ProductionLog />);
    await settle();

    const chip = () => r.host.querySelectorAll('[data-log-actor-filter]').length;
    expect(chip()).toBe(8);
    expect(says('+3 more', r.host)).toBe(true);

    click(buttonNamed(r.host, '+3 more'));
    await settle();
    expect(chip()).toBe(11);
    expect(says('+3 more', r.host)).toBe(false);
  });

  it('counts one line as one line', async () => {
    await seed([line({ id: 'only', at: at(0, 9), batchId: 'b-1', code: 'A3', detail: '2026-09-10-01 logged on Line 1' })], [rack()]);
    window.location.hash = '#/log?rack=b-1';
    const r = render(<ProductionLog />);
    await settle();

    expect(says('Every line about 2026-09-10-01 (A3) — 1 line', r.host)).toBe(true);
    expect(says('1 lines', r.host)).toBe(false);
    window.location.hash = '#/log';
  });

  it('says plainly when the rack behind the link is not on this device', async () => {
    await seed(history(), [rack({ id: 'b-2', batchNo: '2026-09-14-02', code: 'B2' })]);
    window.location.hash = '#/log?rack=b-1';
    const r = render(<ProductionLog />);
    await settle();

    expect(says('a rack that is not on this device', r.host)).toBe(true);
    expect(linesOn(r)).toHaveLength(2);
    window.location.hash = '#/log';
  });
});

describe('on a phone', () => {
  it('still shows the diary when the viewport narrows', async () => {
    await seed([line({ id: 'a', detail: '2026-09-14-01 off the racks — 5 trays ready' })]);
    const r = render(<ProductionLog />);
    await settle();
    expect(linesOn(r)).toHaveLength(1);

    setMediaWidth(390);
    await settle();
    // A short-circuited media hook would unmount the screen and leave nothing here.
    expect(linesOn(r)).toHaveLength(1);
    expect(says('off the racks', r.host)).toBe(true);
  });
});
