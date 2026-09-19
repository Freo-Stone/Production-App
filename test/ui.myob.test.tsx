// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LINES, DEFAULT_SETTINGS } from '@/core/defaults';
import { dayStart, formatDayFull, isoDate, nextWeekday } from '@/core/dates';
import type { Batch, Product } from '@/core/types';
import { db, saveSettings } from '@/data/db';
import { MyobEntry } from '@/screens/MyobEntry';
import { Toaster } from '@/ui/primitives';
import { setMediaWidth } from './setup';
import { signInForTests } from './support/who';
import { byText, click, render, settle, typeInto, type Rendered } from './support/render';

/**
 * The weekly run on screen.
 *
 * Two things have to be right here that no other screen does. The first is the
 * *split*: the shop keys one weekday's worth of stock, and everything else has to
 * be visibly somewhere else rather than quietly in the same list. The second is
 * that the copy-out and the mark-entered press always describe the *same* racks —
 * untick one and it must leave both at once, because a run copied out one way and
 * keyed another is the discrepancy nobody spots until MYOB and the app disagree.
 */

const DAY = 86_400_000;
/**
 * The clock is pinned, and not for tidiness. This screen's job is "which run does this
 * rack belong to", so its answers move with the day of the week the tests happen to
 * run on: on a Saturday, last Friday's run is genuinely overdue and a rack that came
 * ready on Tuesday joins it — correctly — so a test asserting "1 rack is overdue a run"
 * reads 2 with nothing wrong but the calendar. Fixing the day fixes the test and leaves
 * the rule alone. Wednesday 16 September 2026, 11am Perth: midweek, the shop's entry
 * day still ahead of it.
 */
const CLOCK = Date.parse('2026-09-16T11:00:00+08:00');
const TODAY = dayStart(CLOCK);
const ENTRY_WEEKDAY = DEFAULT_SETTINGS.myobEntry.entryWeekday;

function product(code: string, over: Partial<Product> = {}): Product {
  return {
    code,
    description: `${code} paver`,
    enabled: true,
    route: 'manufacture',
    usesBaseline10000: false,
    unit: 'm2',
    trayYield: 2,
    target: 100,
    cureDays: 2,
    notes: '',
    rank: 1000,
    seenInJobs: true,
    updatedAt: 1,
    ...over,
  };
}

function rack(over: Partial<Batch> = {}): Batch {
  const madeAt = over.madeAt ?? Date.now() - 9 * DAY;
  const trays = over.trays ?? 5;
  return {
    id: over.id ?? `b-${over.batchNo ?? 'x'}`,
    batchNo: over.batchNo ?? '2026-09-09-01',
    code: over.code ?? 'A3',
    lineId: over.lineId ?? 'line-1',
    trays,
    qty: over.qty ?? trays * 2,
    qtyOverridden: false,
    routeSnapshot: 'manufacture',
    stage: over.stage ?? 'ready',
    madeAt,
    cureDaysSnapshot: over.cureDaysSnapshot ?? 2,
    cureDueAt: over.cureDueAt ?? TODAY - 3 * DAY,
    blastedQty: over.blastedQty ?? 0,
    blastedAt: over.blastedAt ?? null,
    myobRunDate: null,
    enteredAt: over.enteredAt ?? null,
    enteredRef: over.enteredRef ?? '',
    operator: 'Test Person',
    note: '',
    rank: 1000,
    parentBatchId: null,
    updatedAt: 1,
    ...over,
  };
}

async function seed(batches: Batch[]): Promise<void> {
  signInForTests('maker');
  await Promise.all([db.batches.clear(), db.events.clear(), db.products.clear(), db.lines.clear(), db.meta.clear()]);
  await saveSettings(structuredClone(DEFAULT_SETTINGS));
  await db.lines.bulkAdd(DEFAULT_LINES.map((l) => ({ ...l, updatedAt: 1 })));
  await db.products.bulkAdd([
    product('A3'),
    product('B2', { description: 'B2 slab' }),
    product('L1', { description: 'L1 kerb', unit: 'lm' }),
  ]);
  if (batches.length > 0) await db.batches.bulkAdd(batches);
}

const rowFor = (r: Rendered, batchNo: string): Element | undefined =>
  [...r.host.querySelectorAll('[data-myob-rack]')].find((el) => el.getAttribute('data-myob-rack') === batchNo);

const pickOf = (r: Rendered, batchNo: string): Element | undefined =>
  rowFor(r, batchNo)?.querySelector('[role="checkbox"]') ?? undefined;

/**
 * The control a test reached for has to be there. A click on a detached `<span>`
 * would pass silently, which is the one failure mode a UI test must not have.
 */
function need(el: Element | null | undefined): Element {
  if (el == null) throw new Error('the control this test reached for is not on the screen');
  return el;
}

/** The screen with the toaster mounted, so a toast can be read the way a person reads it. */
function withToasts(): Rendered {
  return render(
    <>
      <MyobEntry />
      <Toaster />
    </>,
  );
}

const lineCells = (r: Rendered, code: string): string[] => {
  const tr = r.host.querySelector(`[data-myob-line="${code}"]`);
  return tr === null ? [] : [...tr.querySelectorAll('td')].map((td) => td.textContent ?? '');
};

const dialog = (): HTMLElement => document.querySelector('[role="dialog"]') ?? document.body;
const says = (text: string, root: Element = document.body): boolean => (root.textContent ?? '').includes(text);
const buttonIn = (name: string, root: Element = document.body): HTMLButtonElement | undefined =>
  [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => (b.textContent ?? '').includes(name));

beforeEach(() => {
  // Only `Date` is faked, so the awaits in `settle` still run on real timers.
  vi.useFakeTimers({ now: CLOCK, toFake: ['Date'] });
  setMediaWidth(1280);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the run', () => {
  it('says so when there is nothing to key', async () => {
    await seed([]);
    const r = render(<MyobEntry />);
    await settle();
    expect(byText(r.host, 'Nothing to key this week')).toBeDefined();
    expect(says('after their blast, if they need one', r.host)).toBe(true);
  });

  it('lists the ready racks with their quantities, and the entry day in words', async () => {
    await seed([rack({ id: 'one', batchNo: 'R-1', code: 'A3', trays: 5, qty: 10 })]);
    const r = render(<MyobEntry />);
    await settle();

    expect(says('Friday is the day the shop keys stock into MYOB', r.host)).toBe(true);
    // Interpolated, not printed: a template literal left bare in JSX shows its own
    // backticks and `$` to the shop, and a `contains` match alone cannot tell.
    expect(says('after midday that day', r.host)).toBe(true);
    expect((r.host.textContent ?? '').includes('`')).toBe(false);
    expect((r.host.textContent ?? '').includes('$')).toBe(false);
    const row = rowFor(r, 'R-1');
    expect(row?.textContent).toContain('5 trays');
    expect(row?.textContent).toContain('10.00 m²');
    expect(row?.textContent).toContain('A3 paver');
    // It came off the cure three days ago, and the row says so — that is what tells
    // the person keying it that this rack is not fresh off the machine.
    expect(row?.textContent).toContain('ready 3 days ago');
  });

  it('puts a rack that came ready in an earlier week under its own run', async () => {
    const oldCure = TODAY - 12 * DAY;
    await seed([
      rack({ id: 'new', batchNo: 'NEW', cureDueAt: TODAY - 3 * DAY }),
      rack({ id: 'old', batchNo: 'OLD', madeAt: Date.now() - 20 * DAY, cureDueAt: oldCure }),
    ]);
    const r = render(<MyobEntry />);
    await settle();

    const runs = [...r.host.querySelectorAll('[data-myob-run]')];
    // Two runs, oldest first: a rack whose week has gone by is not allowed to hide
    // inside "this week" where nobody would think to look for it.
    expect(runs.map((el) => el.getAttribute('data-myob-run'))).toEqual([isoDate(nextWeekday(oldCure, ENTRY_WEEKDAY)), isoDate(nextWeekday(TODAY - 3 * DAY, ENTRY_WEEKDAY))]);
    expect(runs[0]?.querySelector('h3')?.textContent).toContain('Overdue');
    expect(says('1 rack is overdue a run', r.host)).toBe(true);
  });

  it('keeps a rack that is still curing out of the run', async () => {
    await seed([rack({ id: 'soon', batchNo: 'SOON', cureDueAt: TODAY + 4 * DAY })]);
    const r = render(<MyobEntry />);
    await settle();
    expect(says('Nothing to key this week', r.host)).toBe(true);
  });
});

describe('the copy-out', () => {
  it('is one line per item code, in the columns the shop set', async () => {
    await seed([
      rack({ id: 'a', batchNo: 'RA', code: 'A3', trays: 5, qty: 10 }),
      rack({ id: 'b', batchNo: 'RB', code: 'A3', trays: 3, qty: 6, madeAt: Date.now() - 4 * DAY }),
      rack({ id: 'c', batchNo: 'RC', code: 'B2', trays: 4, qty: 8 }),
    ]);
    const r = render(<MyobEntry />);
    await settle();

    expect([...r.host.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual([
      'Item No.',
      'Description',
      'Quantity',
      'Unit',
      'Memo',
    ]);
    // Two racks of A3, one line, quantities added.
    expect(lineCells(r, 'A3')[0]).toBe('A3');
    expect(lineCells(r, 'A3')[2]).toBe('16.00');
    expect(lineCells(r, 'B2')[2]).toBe('8.00');
    expect(lineCells(r, 'A3')[4]).toContain('Cured/blasted production');
    expect(says('2 lines from 3 racks', r.host)).toBe(true);
  });

  it('keeps the table’s cells under the headings the shop chose', async () => {
    // The copy-out text has always been built from the configured columns; the table
    // on screen printed five fixed cells no matter what. Reorder or drop a column in
    // Settings and that is a quantity sitting under "Description".
    await seed([rack({ id: 'a', batchNo: 'RA', code: 'A3', trays: 5, qty: 10 })]);
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.myobEntry.exportColumns = [
      { key: 'qty', header: 'Quantity' },
      { key: 'code', header: 'Item No.' },
      { key: 'total weight', header: 'Weight' },
    ];
    await saveSettings(settings);
    const r = render(<MyobEntry />);
    await settle();

    const heads = [...r.host.querySelectorAll('thead th')].map((th) => th.textContent ?? '');
    expect(heads).toEqual(['Quantity', 'Item No.', 'Weight']);
    // The quantity is printed for a person, and pasted as a plain number; an unknown
    // column key prints an empty cell rather than dropping out of the table.
    expect(lineCells(r, 'A3')).toEqual(['10.00', 'A3', '']);
  });

  it('takes an unticked rack out of the copy-out and says it was left out', async () => {
    await seed([
      rack({ id: 'a', batchNo: 'RA', code: 'A3', trays: 5, qty: 10 }),
      rack({ id: 'b', batchNo: 'RB', code: 'B2', trays: 4, qty: 8 }),
    ]);
    const r = render(<MyobEntry />);
    await settle();

    expect(rowFor(r, 'RB')?.getAttribute('data-myob-picked')).toBe('yes');
    click(need(pickOf(r, 'RB')));
    await settle();

    expect(rowFor(r, 'RB')?.getAttribute('data-myob-picked')).toBe('no');
    expect(lineCells(r, 'B2')).toEqual([]);
    expect(says('1 line from 1 rack', r.host)).toBe(true);
    expect(says('1 left out', r.host)).toBe(true);
    expect(says('1 of 2 racks ticked', r.host)).toBe(true);
  });

  it('shows the text when the browser will not copy it', async () => {
    await seed([rack({ id: 'a', batchNo: 'RA', code: 'A3', qty: 10 })]);
    const r = withToasts();
    await settle();

    // jsdom has neither the clipboard API nor `execCommand`, which is exactly the
    // case the fallback exists for: the text has to end up selectable, not lost.
    click(need(buttonIn('Copy for MYOB', r.host)));
    await settle();
    const box = r.host.querySelector('[data-myob-copytext]') as HTMLTextAreaElement | null;
    expect(box).not.toBeNull();
    // A textarea normalises CRLF to LF in its `value`, so the lines are read apart
    // the way they will be after the paste, not as bytes.
    expect(box?.value.split('\n')[0]).toBe('Item No.\tDescription\tQuantity\tUnit\tMemo');
    expect(box?.value).toContain('A3');
    expect(says('The browser would not let the app copy')).toBe(true);
  });

  it('writes a CSV file when the browser lets it', async () => {
    await seed([rack({ id: 'a', batchNo: 'RA', code: 'A3', qty: 10 })]);
    const r = render(<MyobEntry />);
    await settle();

    let bytes = 0;
    const names: string[] = [];
    const realCreate = URL.createObjectURL;
    const realClick = HTMLAnchorElement.prototype.click;
    URL.createObjectURL = (blob: Blob | MediaSource) => {
      bytes = (blob as Blob).size;
      return 'blob:run';
    };
    HTMLAnchorElement.prototype.click = function fake(this: HTMLAnchorElement) {
      names.push(this.download);
    };
    click(need(buttonIn('CSV', r.host)));
    await settle();
    HTMLAnchorElement.prototype.click = realClick;
    URL.createObjectURL = realCreate;

    expect(bytes).toBeGreaterThan(0);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^freo-myob-run-\d{4}-\d{2}-\d{2}\.csv$/);
  });
});

describe('marking the run entered', () => {
  it('asks first, then writes the keying and one ledger line per rack', async () => {
    await seed([
      rack({ id: 'a', batchNo: 'RA', code: 'A3', trays: 5, qty: 10 }),
      rack({ id: 'b', batchNo: 'RB', code: 'B2', trays: 4, qty: 8 }),
    ]);
    const r = withToasts();
    await settle();

    click(need(buttonIn('Mark entered', r.host)));
    await settle();
    expect(says('Mark 2 racks entered', dialog())).toBe(true);
    expect(says('does not type anything in for you', dialog())).toBe(true);

    const refBox = dialog().querySelector('input');
    expect(refBox).not.toBeNull();
    if (refBox !== null) typeInto(refBox, 'INV-42');
    click(need(buttonIn('They are in MYOB', dialog())));
    await settle(10);

    expect(await db.batches.get('a')).toMatchObject({ stage: 'entered_myob', enteredRef: 'INV-42' });
    expect(await db.batches.get('b')).toMatchObject({ stage: 'entered_myob', enteredRef: 'INV-42' });
    const lines = await db.events.where('action').equals('batch.enterMyob').toArray();
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.detail).join('\n')).toContain('ref INV-42');

    // Off the queue and into the pile that says it is not in the export yet.
    await settle();
    expect(says('Nothing to key this week', r.host)).toBe(true);
    expect(r.host.querySelector('[data-myob-keyed="RA"]')).not.toBeNull();
    expect(says('2 racks keyed into MYOB')).toBe(true);
  });

  it('names a rack that is marked ready but is not, instead of letting the press fail', async () => {
    // The stage says ready; the cure says otherwise. Such a rack cannot be keyed —
    // the writer would refuse it — so it is not in the run, and the screen has to
    // say where it went rather than let the count differ from the ready pile.
    await seed([
      rack({ id: 'ok', batchNo: 'OK', cureDueAt: TODAY - 3 * DAY }),
      rack({ id: 'weird', batchNo: 'WEIRD', cureDueAt: TODAY + 4 * DAY }),
    ]);
    const r = render(<MyobEntry />);
    await settle();

    expect(rowFor(r, 'OK')).toBeDefined();
    expect(rowFor(r, 'WEIRD')).toBeUndefined();
    expect(says('1 still curing', r.host)).toBe(true);
    expect(says('on the ready pile but still curing — WEIRD', r.host)).toBe(true);

    click(need(buttonIn('Mark entered', r.host)));
    await settle();
    expect(says('Mark 1 rack entered', dialog())).toBe(true);
  });

  it('offers nothing while the whole queue is unticked', async () => {
    await seed([rack({ id: 'a', batchNo: 'RA' })]);
    const r = render(<MyobEntry />);
    await settle();
    click(need(pickOf(r, 'RA')));
    await settle();

    expect(says('Every rack in the queue is unticked', r.host)).toBe(true);
    expect(buttonIn('Mark entered', r.host)?.disabled).toBe(true);
    expect(buttonIn('Copy for MYOB', r.host)?.disabled).toBe(true);
  });

  it('is not offered to a viewer, who can still read the run', async () => {
    await seed([rack({ id: 'a', batchNo: 'RA', code: 'A3', qty: 10 })]);
    signInForTests('viewer');
    const r = render(<MyobEntry />);
    await settle();

    expect(rowFor(r, 'RA')).toBeDefined();
    expect(buttonIn('Mark entered', r.host)).toBeUndefined();
    expect(buttonIn('Copy for MYOB', r.host)).toBeUndefined();
    expect(says('Marking it entered takes a maker or owner sign-in', r.host)).toBe(true);
  });
});

describe('what has been keyed but not exported', () => {
  it('keeps keyed racks visible until a stock export accounts for them', async () => {
    await seed([
      rack({ id: 'k', batchNo: 'K-1', code: 'A3', stage: 'entered_myob', enteredAt: Date.now(), enteredRef: 'INV-7', myobRunDate: TODAY }),
    ]);
    const r = render(<MyobEntry />);
    await settle();

    expect(says('Keyed, not in the export yet', r.host)).toBe(true);
    const row = r.host.querySelector('[data-myob-keyed="K-1"]');
    expect(row?.textContent).toContain('ref INV-7');
    expect(row?.textContent).toContain(`run ${formatDayFull(TODAY)}`);
  });

  it('takes a rack back out of the run, and writes a line saying so', async () => {
    await seed([rack({ id: 'k', batchNo: 'K-1', code: 'A3', stage: 'entered_myob', enteredAt: Date.now(), myobRunDate: TODAY })]);
    const r = withToasts();
    await settle();

    click(need(buttonIn('It was not keyed', r.host)));
    await settle(10);

    expect(await db.batches.get('k')).toMatchObject({ stage: 'ready', enteredAt: null, enteredRef: '', myobRunDate: null });
    expect(await db.events.where('action').equals('batch.undo').count()).toBe(1);
    expect(r.host.querySelector('[data-myob-keyed="K-1"]')).toBeNull();
    expect(rowFor(r, 'K-1')).toBeDefined();
    expect(says('is back in the queue')).toBe(true);
  });
});

describe('on a phone', () => {
  it('keeps the queue when the viewport narrows', async () => {
    await seed([rack({ id: 'a', batchNo: 'RA', code: 'A3', qty: 10 })]);
    setMediaWidth(1280);
    const r = render(<MyobEntry />);
    await settle();
    expect(rowFor(r, 'RA')).toBeDefined();

    // The regression this guards: a media-query hook that short-circuits changes its
    // hook count and React tears the screen down instead of reflowing it.
    setMediaWidth(390);
    await settle();
    expect(rowFor(r, 'RA')).toBeDefined();
    expect(buttonIn('Mark entered', r.host)).toBeDefined();
  });
});
