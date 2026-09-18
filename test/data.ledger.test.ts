// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { dayStart } from '@/core/dates';
import type { Batch, EventAction, EventLog } from '@/core/types';
import { describeRack } from '@/data/batchRepo';
import { db } from '@/data/db';
import { ledgerForBatch, ledgerSize, ledgerWindow, logEvent } from '@/data/events';
import { signInForTests, signOutForTests } from './support/who';

/**
 * Reading the ledger back.
 *
 * The writers and their sentences are tested where they happen — the entry screen,
 * the cure, the blaster, the weekly run. What is tested here is the reading, because
 * a log nobody can get to the bottom of is not a log: the window has to come back
 * newest first and stop where it was told to, one rack's history has to include the
 * lines the window has pushed out, and a rack that is no longer on the device must
 * still be nameable.
 */

const DAY = 86_400_000;
const NOW = dayStart(Date.now()) + 9 * 3_600_000;

function rack(over: Partial<Batch> = {}): Batch {
  return {
    id: over.id ?? `b-${over.batchNo ?? 'x'}`,
    batchNo: over.batchNo ?? '2026-09-10-01',
    code: over.code ?? 'A3',
    lineId: 'line-1',
    trays: 5,
    qty: 10,
    qtyOverridden: false,
    routeSnapshot: 'manufacture',
    stage: 'ready',
    madeAt: NOW - 6 * DAY,
    cureDaysSnapshot: 2,
    cureDueAt: NOW - 4 * DAY,
    blastedQty: 0,
    blastedAt: null,
    myobRunDate: null,
    enteredAt: null,
    enteredRef: '',
    operator: 'Test Person',
    note: '',
    rank: 1000,
    parentBatchId: null,
    updatedAt: NOW,
    ...over,
  };
}

function line(over: Partial<EventLog> = {}): EventLog {
  return {
    id: over.id ?? `ev-${over.at ?? 0}-${Math.random().toString(36).slice(2, 7)}`,
    at: over.at ?? NOW,
    action: over.action ?? 'batch.move',
    batchId: over.batchId ?? null,
    code: over.code ?? null,
    fromStage: null,
    toStage: null,
    qty: over.qty ?? 0,
    trays: over.trays ?? 0,
    device: over.device ?? 'test device',
    actor: over.actor ?? 'Test Person',
    detail: over.detail ?? '',
  };
}

async function write(action: EventAction, detail: string, over: Partial<EventLog> = {}): Promise<void> {
  await db.events.add(line({ at: NOW, action, detail, ...over }));
}

beforeEach(async () => {
  signInForTests('maker');
  await Promise.all([db.events.clear(), db.batches.clear()]);
});

describe('the window', () => {
  it('comes back newest first and stops where it was told to', async () => {
    await db.events.bulkAdd([
      line({ id: 'old', at: NOW - 3 * DAY, detail: 'three days ago' }),
      line({ id: 'mid', at: NOW - DAY, detail: 'yesterday' }),
      line({ id: 'new', at: NOW, detail: 'today' }),
    ]);

    expect((await ledgerWindow(2)).map((e) => e.detail)).toEqual(['today', 'yesterday']);
    expect((await ledgerWindow(1)).map((e) => e.detail)).toEqual(['today']);
    expect((await ledgerWindow(99)).map((e) => e.id)).toEqual(['new', 'mid', 'old']);
  });

  it('does not fall over on a window of nothing, or an unreasonable size', async () => {
    expect(await ledgerWindow()).toEqual([]);

    await db.events.bulkAdd([
      line({ id: 'old', at: NOW - 2 * DAY }),
      line({ id: 'mid', at: NOW - DAY }),
      line({ id: 'new', at: NOW }),
    ]);
    // A window of zero would read the whole table; a window of a million would read
    // it too. Both are clamped to something a live query can do on every write.
    expect((await ledgerWindow(0)).map((e) => e.id)).toEqual(['new']);
    expect((await ledgerWindow(-5)).map((e) => e.id)).toEqual(['new']);
    expect(await ledgerWindow(999_999)).toHaveLength(3);
  });

  it('counts every line, including ones about racks that are gone', async () => {
    await write('batch.create', 'Logged 5 trays of A3 on Line 1', { batchId: 'b-gone' });
    await write('auth.signin', 'Test Person signed in as maker');
    expect(await ledgerSize()).toBe(2);
  });

  it('stamps who did it, from the account — not a name typed into a box', async () => {
    const entry = await logEvent('batch.move', { detail: 'A3 off the racks — 5 trays ready' });
    expect(entry.actor).toBe('Test Person');
    expect(entry.actorId).toBe('acct-maker');
    expect(entry.device).not.toBe('');

    // Signed out, a line still lands — and it says nobody was signed in rather than
    // borrowing the last person's name.
    signOutForTests();
    const nobody = await logEvent('batch.move', { detail: 'A3 put back on the racks' });
    expect(nobody.actor).toBe('');
    expect(nobody.actorId).toBeUndefined();
    signInForTests('maker');
  });
});

describe('one rack’s history', () => {
  it('brings every line about that rack, newest first, and nothing else', async () => {
    await db.events.bulkAdd([
      line({ id: 'a', at: NOW - 2 * DAY, batchId: 'b-1', detail: '2026-09-10-01 logged' }),
      line({ id: 'b', at: NOW, batchId: 'b-1', detail: '2026-09-10-01 off the racks' }),
      line({ id: 'c', at: NOW - DAY, batchId: 'b-2', detail: '2026-09-11-01 off the racks' }),
      line({ id: 'd', at: NOW - DAY, batchId: null, detail: 'Test Person signed in as maker' }),
    ]);

    expect((await ledgerForBatch('b-1')).map((e) => e.id)).toEqual(['b', 'a']);
    expect(await ledgerForBatch('b-nothing')).toEqual([]);
  });

  it('reaches further back than the window does', async () => {
    // A month of busy days, then the line the person is actually looking for.
    const many: EventLog[] = [];
    for (let i = 0; i < 60; i += 1) {
      many.push(line({ id: `noise-${i}`, at: NOW - i * 1_000, batchId: 'b-2', detail: `churn ${i}` }));
    }
    many.push(line({ id: 'the one', at: NOW - 90 * DAY, batchId: 'b-1', detail: '2026-09-10-01 logged' }));
    await db.events.bulkAdd(many);

    const window = await ledgerWindow(20);
    expect(window.some((e) => e.id === 'the one')).toBe(false);
    expect((await ledgerForBatch('b-1')).map((e) => e.id)).toEqual(['the one']);
  });
});

describe('naming a rack from its ledger lines', () => {
  it('gives the number and the code a person reads', async () => {
    await db.batches.add(rack({ id: 'b-1', batchNo: '2026-09-10-01', code: 'GL4' }));
    expect(await describeRack('b-1')).toEqual({ batchNo: '2026-09-10-01', code: 'GL4' });
  });

  it('says nothing for a rack that is not on this device', async () => {
    expect(await describeRack('made-elsewhere')).toBeNull();
  });

  it('still names a rack that has been written off', async () => {
    // Written-off racks keep their row and carry the flag, and their history is the
    // reason the flag is there.
    await db.batches.add(rack({ id: 'b-1', batchNo: '2026-09-10-01', deleted: true }));
    expect((await describeRack('b-1'))?.batchNo).toBe('2026-09-10-01');
  });
});
