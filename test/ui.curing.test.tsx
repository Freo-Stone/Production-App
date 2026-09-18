// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_LINES, DEFAULT_SETTINGS } from '@/core/defaults';
import { addDays, dayStart } from '@/core/dates';
import type { Batch, Product } from '@/core/types';
import { db, saveSettings } from '@/data/db';
import { Curing } from '@/screens/Curing';
import { setMediaWidth } from './setup';
import { signInForTests } from './support/who';
import { byText, click, render, settle, typeInto, waitUntil, type Rendered } from './support/render';

/**
 * The racks on screen.
 *
 * A person reads this screen standing up, in a minute, to decide what to move. So
 * the tests are about reading it correctly: which rack is under which heading,
 * which one offers a button and which one explains itself instead, and that a
 * press moves the rack in the database rather than only on the screen.
 */

const DAY = 86_400_000;
const TODAY = dayStart(Date.now());

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
  const madeAt = over.madeAt ?? Date.now() - 6 * DAY;
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
    myobRunDate: null,
    enteredAt: null,
    enteredRef: '',
    operator: 'Test Person',
    note: '',
    rank: 1000,
    parentBatchId: null,
    updatedAt: 1,
    ...over,
  };
}

/** A rack that has finished curing and is still sitting where it was cured. */
const due = (over: Partial<Batch> = {}): Batch =>
  rack({ madeAt: Date.now() - 6 * DAY, cureDueAt: TODAY - 4 * DAY, ...over });

/** A rack that comes off the cure tomorrow. */
const tomorrow = (over: Partial<Batch> = {}): Batch =>
  rack({ madeAt: TODAY - DAY, cureDueAt: addDays(TODAY, 1), ...over });

async function reset(): Promise<void> {
  signInForTests('maker');
  window.location.hash = '#/curing';
  await Promise.all([db.batches.clear(), db.products.clear(), db.events.clear(), db.lines.clear(), db.meta.clear()]);
  await saveSettings(structuredClone(DEFAULT_SETTINGS));
  await db.products.bulkAdd([product('S3'), product('B2', { route: 'shotblast', rank: 2000 })]);
  await db.lines.bulkAdd(DEFAULT_LINES.map((l) => ({ ...l, updatedAt: 1 })));
}

let mounted: Rendered | null = null;

async function open(): Promise<Rendered> {
  mounted?.unmount();
  const view = render(<Curing />);
  mounted = view;
  await settle();
  return view;
}

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  setMediaWidth(null);
});

function dialog(): HTMLElement {
  const panel = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!panel) throw new Error('no dialog open');
  return panel;
}

/** Which racks the screen is showing, in the order it shows them. */
function racksOn(host: HTMLElement): string[] {
  return [...host.querySelectorAll<HTMLElement>('[data-curing-rack]')].map((el) => el.getAttribute('data-curing-rack') ?? '');
}

function bucketOf(host: HTMLElement, bucket: string): string[] {
  const section = host.querySelector<HTMLElement>(`[data-curing-bucket="${bucket}"]`);
  if (!section) return [];
  return [...section.querySelectorAll<HTMLElement>('[data-curing-rack]')].map((el) => el.getAttribute('data-curing-rack') ?? '');
}

describe('reading the racks', () => {
  beforeEach(reset);

  it('puts what is off the cure above what still is, and says how many of each', async () => {
    await db.batches.bulkAdd([
      due({ batchNo: 'A', id: 'a' }),
      due({ batchNo: 'B', id: 'b', cureDueAt: TODAY - 2 * DAY }),
      tomorrow({ batchNo: 'C', id: 'c' }),
    ]);
    const { host } = await open();

    expect(byText(host, '3 racks · 15 trays').textContent).toBeTruthy();
    expect(bucketOf(host, 'now')).toEqual(['A', 'B']);
    // The row carries the product's own words and unit, not just its code — the
    // screen reads the products table for that, and a rack labelled only "S3" is
    // no help to whoever is standing in front of it.
    expect(host.querySelector('[data-curing-rack="A"]')?.textContent).toContain('S3 paver');
    expect(host.querySelector('[data-curing-rack="A"]')?.textContent).toContain('10.00 m²');
    expect(bucketOf(host, 'tomorrow')).toEqual(['C']);
    expect(racksOn(host)).toEqual(['A', 'B', 'C']);
  });

  it('tells a curing rack when it comes off, and offers nothing for it', async () => {
    await db.batches.add(tomorrow({ batchNo: 'C', id: 'c', cureDueAt: addDays(TODAY, 2) }));
    const { host } = await open();

    const row = host.querySelector('[data-curing-rack="C"]');
    expect(row?.textContent).toContain('due in 2 days');
    expect(row?.querySelector('[data-curing-move]')).toBeNull();
    expect(host.querySelector('[data-curing-sweep]')).toBeNull();
    expect(byText(host, 'Nothing is due').textContent).toBeTruthy();
  });

  it('keeps the cure date the rack was made with, not the one the product has now', async () => {
    // The shop moved S3 to a nine-day cure. A rack made under the old two-day cure
    // is not allowed to become young again because of it.
    await db.products.put(product('S3', { cureDays: 9 }));
    await db.batches.add(rack({ batchNo: 'OLD', id: 'old', madeAt: TODAY - 3 * DAY, cureDueAt: TODAY - 1 * DAY }));
    const { host } = await open();

    expect(bucketOf(host, 'now')).toEqual(['OLD']);
    expect(host.querySelector('[data-curing-rack="OLD"]')?.textContent).toContain('off the cure now');
  });

  it('says a rack is waiting for its blast, and does not offer to take it off', async () => {
    await db.batches.add(
      due({ batchNo: 'BL', id: 'bl', code: 'B2', routeSnapshot: 'shotblast', stage: 'awaiting_shotblast', blastedQty: 0 }),
    );
    const { host } = await open();

    expect(bucketOf(host, 'waiting')).toEqual(['BL']);
    const row = host.querySelector('[data-curing-rack="BL"]');
    expect(row?.textContent).toContain('Needs blast');
    expect(row?.querySelector('[data-curing-move]')).toBeNull();
    expect(host.querySelector('[data-curing-problem="BL"]')?.textContent).toContain('still has 10 to go through the blaster');
    expect(byText(host, '1 needs a blast').textContent).toBeTruthy();
  });

  it('counts the racks it is holding and the ones that are waiting to be moved', async () => {
    await db.batches.bulkAdd([due({ batchNo: 'A', id: 'a' }), tomorrow({ batchNo: 'C', id: 'c' })]);
    const { host } = await open();
    expect(byText(host, '1 to move').textContent).toBeTruthy();
    expect(byText(host, '1 rack has come off the cure').textContent).toBeTruthy();
  });

  it('says so when there is nothing on the clock at all', async () => {
    const { host } = await open();
    expect(byText(host, 'No racks on the clock').textContent).toBeTruthy();
    expect(host.querySelector('[data-curing-rack]')).toBeNull();
  });
});

describe('taking racks off the cure', () => {
  beforeEach(async () => {
    await reset();
    await db.batches.bulkAdd([
      due({ batchNo: 'A', id: 'a' }),
      due({ batchNo: 'B', id: 'b', trays: 3, qty: 6 }),
      tomorrow({ batchNo: 'C', id: 'c' }),
    ]);
  });

  it('moves one rack when its own button is pressed, and drops it out of the list', async () => {
    const { host } = await open();
    click(host.querySelector<HTMLButtonElement>('[data-curing-move="A"]')!);
    await settle();

    await waitUntil(() => racksOn(host).join(',') === 'B,C', 'the rack to leave the list');
    const stored = await db.batches.get('a');
    expect(stored?.stage).toBe('ready');
    expect(await db.events.where('action').equals('batch.move').count()).toBe(1);
    // The rack that was not touched stays where it was, due tomorrow.
    expect((await db.batches.get('b'))?.stage).toBe('curing');
  });

  it('moves everything that is due in one press, and leaves what is not', async () => {
    const { host } = await open();
    const sweep = host.querySelector<HTMLButtonElement>('[data-curing-sweep]');
    expect(sweep?.textContent).toContain('Move them to Ready');
    click(sweep!);
    await settle();

    await waitUntil(() => racksOn(host).join(',') === 'C', 'the due racks to go');
    const moved = (await db.batches.toArray()).filter((b) => b.stage === 'ready');
    expect(moved.map((b) => b.batchNo).sort()).toEqual(['A', 'B']);
    expect(await db.events.where('action').equals('batch.move').count()).toBe(2);
    // The offer is gone, because nothing is waiting any more.
    expect(host.querySelector('[data-curing-sweep]')).toBeNull();
  });

  it('writes the reason the log will be read in, with the name of whoever pressed it', async () => {
    const { host } = await open();
    click(host.querySelector<HTMLButtonElement>('[data-curing-sweep]')!);
    await settle();

    const events = await db.events.where('action').equals('batch.move').toArray();
    expect(events.map((e) => e.detail).sort()).toEqual([
      'A off the racks — 5 trays ready',
      'B off the racks — 3 trays ready',
    ]);
    expect(events.every((e) => e.actor === 'Test Person')).toBe(true);
    expect(events.every((e) => e.toStage === 'ready' && e.fromStage === 'curing')).toBe(true);
  });
});

describe('writing a rack off', () => {
  beforeEach(async () => {
    await reset();
    await db.batches.add(due({ batchNo: 'A', id: 'a', trays: 4, qty: 8 }));
  });

  it('asks why, and will not do it without an answer', async () => {
    const { host } = await open();
    click(host.querySelector<HTMLButtonElement>('[data-curing-writeoff="A"]')!);
    await settle();

    const panel = dialog();
    expect(panel.textContent).toContain('Write A off');
    const confirm = [...panel.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Write it off');
    expect(confirm?.disabled).toBe(true);

    typeInto(panel.querySelector<HTMLInputElement>('[aria-label="Why this rack is being written off"]')!, 'Cracked in the sling');
    await settle();
    expect([...panel.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Write it off')?.disabled).toBe(false);
    click([...panel.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Write it off')!);
    await settle();

    await waitUntil(() => racksOn(host).length === 0, 'the rack to leave the racks');
    expect((await db.batches.get('a'))?.stage).toBe('written_off');
    const [event] = await db.events.where('action').equals('batch.writeOff').toArray();
    expect(event?.detail).toBe('A written off — Cracked in the sling');
  });

  it('leaves the rack alone when the dialog is closed instead', async () => {
    const { host } = await open();
    click(host.querySelector<HTMLButtonElement>('[data-curing-writeoff="A"]')!);
    await settle();
    const panel = dialog();
    click([...panel.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Leave it on the racks')!);
    await settle();

    expect((await db.batches.get('a'))?.stage).toBe('curing');
    expect(await db.events.where('action').equals('batch.writeOff').count()).toBe(0);
  });
});

describe('narrowing the window, or turning a phone sideways', () => {
  it('keeps the racks on screen and gives the actions their 44px', async () => {
    await reset();
    await db.batches.add(due({ batchNo: 'A', id: 'a' }));
    setMediaWidth(1280);
    const { host } = await open();
    expect(host.querySelector('[data-curing-move="A"]')?.className).not.toContain('btn-touch');

    setMediaWidth(390);
    await settle();

    // The regression this exists for: crossing the breakpoint used to tear the
    // whole screen down, because once the first media hook said "compact" the
    // second was never called again, and React calls that an error and unmounts.
    expect(racksOn(host)).toEqual(['A']);
    expect(byText(host, 'off the cure now').textContent).toBeTruthy();
    expect(host.querySelector('[data-curing-move="A"]')?.className).toContain('btn-touch');
    expect(host.querySelector('[data-curing-writeoff="A"]')?.className).toContain('btn-touch');
  });
});

describe('a rack that has come off the racks', () => {
  beforeEach(reset);

  it('is listed where it can be seen, and goes back on the clock when asked', async () => {
    await db.batches.add(due({ batchNo: 'A', id: 'a', stage: 'ready', updatedAt: Date.now() }));
    const { host } = await open();

    // Nothing on the racks, so the screen must still say what is waiting to be
    // entered — otherwise a rack that came off by mistake simply disappears.
    expect(byText(host, 'Off the racks, not entered yet')).toBeTruthy();
    expect(host.querySelector('[data-curing-offrack="A"]')?.textContent).toContain('5 trays');
    expect(host.querySelector('[data-curing-offrack="A"]')?.textContent).toContain('S3 paver');

    click(host.querySelector('[data-curing-putback="A"]') as HTMLElement);
    await waitUntil(() => racksOn(host).includes('A'), 'the rack is back on the clock');

    expect((await db.batches.get('a'))?.stage).toBe('curing');
    expect(host.querySelector('[data-curing-offrack="A"]')).toBeNull();
  });

  it('keeps the empty screen honest when a rack is off the racks but nothing is curing', async () => {
    await db.batches.add(due({ batchNo: 'A', id: 'a', stage: 'ready' }));
    const { host } = await open();
    expect(host.textContent).not.toContain('No racks on the clock');
  });
});

describe('a viewer reading the racks', () => {
  it('sees everything and touches nothing', async () => {
    await reset();
    await db.batches.add(due({ batchNo: 'A', id: 'a' }));
    signInForTests('viewer');
    const { host } = await open();

    expect(racksOn(host)).toEqual(['A']);
    expect(host.querySelector('[data-curing-move]')).toBeNull();
    expect(host.querySelector('[data-curing-writeoff]')).toBeNull();
    expect(host.querySelector('[data-curing-sweep]')).toBeNull();
    expect(byText(host, 'Moving them takes a maker or owner sign-in').textContent).toBeTruthy();
    expect((await db.batches.get('a'))?.stage).toBe('curing');
  });
});
