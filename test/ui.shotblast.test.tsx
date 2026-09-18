// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_LINES, DEFAULT_SETTINGS } from '@/core/defaults';
import { dayStart } from '@/core/dates';
import type { Batch, Product } from '@/core/types';
import { db, saveSettings } from '@/data/db';
import { Shotblast } from '@/screens/Shotblast';
import { setMediaWidth } from './setup';
import { signInForTests } from './support/who';
import { byText, click, render, settle, typeInto, waitUntil, type Rendered } from './support/render';

/**
 * The blaster on screen.
 *
 * The queue is short and the decisions on it are physical, so what matters here is
 * that the screen tells the truth about a rack before anyone presses: which racks
 * still owe a blast, in the order they are holding things up, and — for a part
 * blast — what is about to be split off. Every test that presses a button then
 * checks the database, because a row that moves only on the screen is worth
 * nothing to the shop.
 */

const DAY = 86_400_000;
const TODAY = dayStart(Date.now());

function product(code: string, over: Partial<Product> = {}): Product {
  return {
    code,
    description: `${code} paver`,
    enabled: true,
    route: 'shotblast',
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
  const trays = over.trays ?? 8;
  return {
    id: over.id ?? `b-${over.batchNo ?? 'x'}`,
    batchNo: over.batchNo ?? '2026-09-15-01',
    code: over.code ?? 'SB1',
    lineId: over.lineId ?? 'line-1',
    trays,
    qty: over.qty ?? trays * 2,
    qtyOverridden: false,
    routeSnapshot: 'shotblast',
    stage: over.stage ?? 'awaiting_shotblast',
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

/** Its cure is done, so only the blast is holding it up. */
const heldUp = (over: Partial<Batch> = {}): Batch =>
  rack({ batchNo: 'A-1', madeAt: Date.now() - 9 * DAY, cureDueAt: TODAY - 3 * DAY, ...over });

/** Still hardening. It can be blasted, but nothing is waiting on it. */
const hardening = (over: Partial<Batch> = {}): Batch =>
  rack({ batchNo: 'A-2', madeAt: Date.now(), cureDueAt: TODAY + 2 * DAY, ...over });

/** Already in the machine. */
const onMachine = (over: Partial<Batch> = {}): Batch =>
  rack({ batchNo: 'A-3', stage: 'blasting', madeAt: Date.now() - 9 * DAY, cureDueAt: TODAY - 3 * DAY, ...over });

async function reset(): Promise<void> {
  signInForTests('maker');
  window.location.hash = '#/shotblast';
  await Promise.all([db.batches.clear(), db.products.clear(), db.events.clear(), db.lines.clear(), db.meta.clear()]);
  await saveSettings(structuredClone(DEFAULT_SETTINGS));
  await db.products.bulkAdd([product('SB1'), product('SB2', { rank: 2000 })]);
  await db.lines.bulkAdd(DEFAULT_LINES.map((l) => ({ ...l, updatedAt: 1 })));
}

let mounted: Rendered | null = null;

async function open(): Promise<Rendered> {
  mounted?.unmount();
  const view = render(<Shotblast />);
  mounted = view;
  await settle();
  return view;
}

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  setMediaWidth(null);
});

/** The dialog portals to the document root, not into the screen's host. */
function dialog(): HTMLElement {
  const panel = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!panel) throw new Error('no dialog open');
  return panel;
}

function queueOn(host: HTMLElement): string[] {
  return [...host.querySelectorAll<HTMLElement>('[data-blast-rack]')].map((el) => el.getAttribute('data-blast-rack') ?? '');
}

function sectionOf(host: HTMLElement, section: string): string[] {
  const el = host.querySelector<HTMLElement>(`[data-blast-section="${section}"]`);
  if (!el) return [];
  return [...el.querySelectorAll<HTMLElement>('[data-blast-rack]')].map((r) => r.getAttribute('data-blast-rack') ?? '');
}

const rowText = (host: HTMLElement, batchNo: string): string =>
  host.querySelector<HTMLElement>(`[data-blast-rack="${batchNo}"]`)?.textContent ?? '';

describe('reading the queue', () => {
  beforeEach(reset);

  it('counts the machine, the queue, and the trays in both', async () => {
    const { host } = await open();
    await db.batches.bulkAdd([onMachine(), heldUp(), hardening({ batchNo: 'A-4', trays: 4 })]);
    await settle();
    byText(host, '1 on the machine · 2 waiting · 20 trays');
  });

  it('says what a blast means on this shop’s settings', async () => {
    const { host } = await open();
    await db.batches.add(heldUp());
    await settle();
    byText(host, 'Blasting stands in for the rest of the cure');

    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.production.blastingCompletesCure = false;
    await saveSettings(settings);
    await settle(8);
    byText(host, 'still waits for its cure date');
  });

  it('puts the racks whose cure is done above the ones still hardening', async () => {
    const { host } = await open();
    await db.batches.bulkAdd([hardening({ batchNo: 'NEW' }), heldUp({ batchNo: 'OLD' }), onMachine({ batchNo: 'RUN' })]);
    await settle();
    expect(sectionOf(host, 'cure-done')).toEqual(['OLD']);
    expect(sectionOf(host, 'still-curing')).toEqual(['NEW']);
    // The one running is in its own card, above both.
    expect(queueOn(host)).toEqual(['RUN', 'OLD', 'NEW']);
  });

  it('shows what the rack is, not just a code', async () => {
    const { host } = await open();
    await db.batches.add(heldUp({ code: 'SB2', trays: 8, qty: 16 }));
    await settle();
    const text = rowText(host, 'A-1');
    expect(text).toContain('SB2 paver');
    expect(text).toContain('16.00 m²');
    expect(text).toContain('Line 1');
    expect(text).toContain('cure finished 3 days ago');
  });

  it('says how much of a half-blasted rack is still owed', async () => {
    const { host } = await open();
    await db.batches.add(heldUp({ batchNo: 'HALF', trays: 5, qty: 10, blastedQty: 3, stage: 'curing' }));
    await settle();
    const text = rowText(host, 'HALF');
    expect(text).toContain('Part blasted');
    expect(text).toContain('7.00 m² still to go');
  });

  it('leaves out anything that does not owe the machine', async () => {
    const { host } = await open();
    await db.batches.bulkAdd([
      heldUp({ batchNo: 'DONE', blastedQty: 16, blastedAt: Date.now() - DAY, stage: 'curing' }),
      heldUp({ batchNo: 'PLAIN', routeSnapshot: 'manufacture' }),
      heldUp({ batchNo: 'GONE', deleted: true }),
      hardening({ batchNo: 'IN' }),
    ]);
    await settle();
    expect(queueOn(host)).toEqual(['IN']);
  });

  it('says the blaster is clear when nothing owes it', async () => {
    const { host } = await open();
    await db.batches.add(heldUp({ blastedQty: 16, blastedAt: Date.now() - DAY, stage: 'curing' }));
    await settle();
    byText(host, 'The blaster is clear');
    expect(host.querySelector('[data-blast-rack]')).toBeNull();
  });
});

describe('putting a rack on and taking it off', () => {
  beforeEach(reset);

  it('puts it on the blaster and moves it into the machine list', async () => {
    const { host } = await open();
    await db.batches.add(heldUp({ batchNo: 'A-1', trays: 8 }));
    await settle();
    click(host.querySelector<HTMLButtonElement>('[data-blast-start="A-1"]')!);
    await settle();

    expect((await db.batches.get('b-A-1'))?.stage).toBe('blasting');
    expect(queueOn(host)).toEqual(['A-1']);
    expect(host.querySelector('[data-blast-start="A-1"]')).toBeNull();
    expect(host.querySelector('[data-blast-out="A-1"]')).not.toBeNull();
    const lines = await db.events.where('action').equals('batch.blast').toArray();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.detail).toBe('A-1 on the blaster — 8 trays in');
  });

  it('records the whole rack coming out and takes it off the list', async () => {
    const { host } = await open();
    await db.batches.add(onMachine({ batchNo: 'A-3', trays: 8, qty: 16 }));
    await settle();
    click(host.querySelector<HTMLButtonElement>('[data-blast-out="A-3"]')!);
    await waitUntil(
      () => queueOn(host).length === 0,
      "the rack to leave the blaster's queue",
    );

    const after = await db.batches.get('b-A-3');
    expect(after).toMatchObject({ stage: 'curing', blastedQty: 16, blastedAt: expect.any(Number) });
    const lines = await db.events.where('action').equals('batch.blast').toArray();
    expect(lines[0]?.detail).toBe('A-3 through the blaster — all 8 trays out');
  });

  it('says which racks are only waiting on the blast', async () => {
    const { host } = await open();
    await db.batches.bulkAdd([heldUp({ batchNo: 'A' }), heldUp({ batchNo: 'B', id: 'b-B' }), hardening({ batchNo: 'C' })]);
    await settle();
    byText(host, '2 need the blast to finish');
    byText(host, 'oldest 3 d');
  });
});

describe('blasting part of a rack', () => {
  beforeEach(reset);

  async function openDialog(host: HTMLElement, batchNo = 'A-3'): Promise<void> {
    click(host.querySelector<HTMLButtonElement>(`[data-blast-part="${batchNo}"]`)!);
    await settle();
  }

  it('asks how much came out, in trays', async () => {
    const { host } = await open();
    await db.batches.add(onMachine({ batchNo: 'A-3', trays: 8, qty: 16 }));
    await settle();
    await openDialog(host);
    expect(dialog().textContent).toContain('How much of A-3 came out?');
    expect(dialog().textContent).toContain('8 trays · 16.00 m² on this rack.');
  });

  it('refuses a count that is not a count of trays', async () => {
    const { host } = await open();
    await db.batches.add(onMachine({ batchNo: 'A-3', trays: 8, qty: 16 }));
    await settle();
    await openDialog(host);

    const confirm = [...dialog().querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      (b.textContent ?? '').includes('Out of the blaster'),
    )!;
    expect(confirm.disabled).toBe(true);

    const box = document.querySelector<HTMLInputElement>('[data-blast-trays]')!;
    typeInto(box, '0');
    await settle();
    expect(dialog().textContent).toContain('How many trays went through the blaster?');
    expect(confirm.disabled).toBe(true);

    typeInto(box, '9');
    await settle();
    expect(dialog().textContent).toContain('Only 8 trays are on that rack.');

    typeInto(box, '2.5');
    await settle();
    expect(dialog().textContent).toContain('Trays are whole ones.');
    expect(await db.batches.get('b-A-3')).toMatchObject({ blastedQty: 0, trays: 8 });
  });

  it('says what is about to be split before it splits', async () => {
    const { host } = await open();
    await db.batches.add(onMachine({ batchNo: 'A-3', trays: 8, qty: 16 }));
    await settle();
    await openDialog(host);
    typeInto(document.querySelector<HTMLInputElement>('[data-blast-trays]')!, '5');
    await settle();
    byText(dialog(), '5 trays come out blasted and keep A-3. The other 3 become their own rack, still to be blasted.');
  });

  it('splits the rack: the blasted trays keep the number, the rest waits under a new one', async () => {
    const { host } = await open();
    await db.batches.add(onMachine({ batchNo: 'A-3', trays: 8, qty: 16 }));
    await settle();
    await openDialog(host);
    const box = document.querySelector<HTMLInputElement>('[data-blast-trays]')!;
    typeInto(box, '5');
    await settle();
    click(
      [...dialog().querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        (b.textContent ?? '').includes('Out of the blaster'),
      )!,
    );
    await settle(10);

    const blasted = await db.batches.get('b-A-3');
    expect(blasted).toMatchObject({ batchNo: 'A-3', trays: 5, qty: 10, blastedQty: 10, stage: 'curing' });

    const remainder = (await db.batches.toArray()).find((b) => b.parentBatchId === 'b-A-3');
    expect(remainder).toBeDefined();
    expect(remainder).toMatchObject({ trays: 3, qty: 6, blastedQty: 0, stage: 'awaiting_shotblast' });
    expect(remainder?.batchNo).not.toBe('A-3');
    // Same making, same cure: only the blast differs between the two halves.
    expect(remainder?.madeAt).toBe(blasted?.madeAt);
    expect(remainder?.cureDueAt).toBe(blasted?.cureDueAt);
    expect(remainder?.code).toBe('SB1');

    // The queue now holds the unfinished half, with the number it was given.
    await settle(6);
    expect(queueOn(host)).toEqual([remainder?.batchNo ?? '']);
    expect(rowText(host, remainder?.batchNo ?? '')).toContain('3 trays');

    const split = await db.events.where('action').equals('batch.split').toArray();
    expect(split).toHaveLength(1);
    expect(split[0]?.detail).toBe(`${remainder?.batchNo} — the other 3 trays off A-3, still to be blasted`);
  });
});

describe('who may press what', () => {
  beforeEach(reset);

  it('lets a viewer read the queue without offering a single button', async () => {
    signInForTests('viewer');
    const { host } = await open();
    await db.batches.bulkAdd([heldUp({ batchNo: 'A' }), onMachine({ batchNo: 'B', id: 'b-B' })]);
    await settle();
    expect(queueOn(host)).toEqual(['B', 'A']);
    expect(host.querySelector('[data-blast-start]')).toBeNull();
    expect(host.querySelector('[data-blast-out]')).toBeNull();
    expect(host.querySelector('[data-blast-part]')).toBeNull();
    byText(host, 'Recording a blast takes a maker or owner sign-in.');
    expect(await db.batches.get('b-A')).toMatchObject({ stage: 'awaiting_shotblast' });
  });

  it('keeps the queue when the screen narrows to a phone, and grows the buttons', async () => {
    setMediaWidth(1280);
    const { host } = await open();
    await db.batches.add(heldUp({ batchNo: 'A' }));
    await settle();
    expect(host.querySelector<HTMLButtonElement>('[data-blast-start="A"]')?.className).not.toContain('btn-touch');

    setMediaWidth(390);
    await settle();
    // React error #311 is what a short-circuited `useIsCompact() || useIsCoarsePointer()`
    // does here: the whole screen unmounts rather than re-rendering wide-to-narrow.
    expect(queueOn(host)).toEqual(['A']);
    expect(host.querySelector<HTMLButtonElement>('[data-blast-start="A"]')?.className).toContain('btn-touch');
    expect(host.querySelector<HTMLButtonElement>('[data-blast-part="A"]')?.className).toContain('btn-touch');
  });

  it('names the line a rack belongs to, even if the line is gone', async () => {
    const { host } = await open();
    await db.batches.add(heldUp({ batchNo: 'A', lineId: 'line-gone' }));
    await settle();
    expect(rowText(host, 'A')).toContain('another line');
  });
});
