// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Product } from '@/core/types';
import { db } from '@/data/db';
import { signInForTests } from './support/who';
import {
  applyCsvUpdates,
  bulkPatchProducts,
  moveProductInList,
  parseProductsCsv,
  patchProduct,
  productsToCsv,
  splitCsv,
} from '@/data/productRepo';

function product(code: string, over: Partial<Product> = {}): Product {
  return {
    code,
    description: `${code} paver`,
    enabled: false,
    route: 'unset',
    usesBaseline10000: false,
    unit: 'm2',
    trayYield: 1,
    target: 0,
    cureDays: 2,
    notes: '',
    rank: 1000,
    seenInJobs: false,
    updatedAt: 1,
    ...over,
  };
}

async function seed(...products: Product[]): Promise<void> {
  await db.products.bulkAdd(products);
}

async function reset(): Promise<void> {
  signInForTests();
  await Promise.all([db.products.clear(), db.events.clear()]);
}

describe('product settings writes', () => {
  beforeEach(reset);

  it('writes a change, stamps it, and logs what changed', async () => {
    await seed(product('S3'));
    const after = await patchProduct('S3', { enabled: true, route: 'shotblast' });

    expect(after?.enabled).toBe(true);
    expect(after?.route).toBe('shotblast');
    expect(after!.updatedAt).toBeGreaterThan(1);

    const events = await db.events.toArray();
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe('product.update');
    expect(events[0]?.code).toBe('S3');
    expect(events[0]?.detail).toContain('set current');
    // The log line has to name the product it changed — it is read on its own.
    expect(events[0]?.detail).toMatch(/^S3: /);
    expect(events[0]?.detail).toContain('Make + blast');
  });

  it('is silent when nothing actually changed', async () => {
    await seed(product('S3', { enabled: true }));
    await patchProduct('S3', { enabled: true, target: 0 });

    expect(await db.events.count()).toBe(0);
    // The untouched record keeps its original stamp, so a no-op cannot look like
    // an edit in someone else's sync.
    expect((await db.products.get('S3'))?.updatedAt).toBe(1);
  });

  it('keeps both figures when two cells are edited a moment apart', async () => {
    // The bug this guards: each edit read the row, changed one field and wrote
    // the row back. Two edits in quick succession both started from the same
    // original, so whichever finished last overwrote the other — the screen
    // showed the figure you typed, and the next visit did not.
    await seed(product('S3'));
    await Promise.all([
      patchProduct('S3', { target: 500 }),
      patchProduct('S3', { trayYield: 0.75 }),
      patchProduct('S3', { cureDays: 4 }),
      patchProduct('S3', { notes: 'both lines' }),
    ]);

    expect(await db.products.get('S3')).toMatchObject({
      target: 500,
      trayYield: 0.75,
      cureDays: 4,
      notes: 'both lines',
    });
    // Four edits, four audit lines — merging the writes must not merge the trail.
    expect(await db.events.count()).toBe(4);
  });

  it('applies one edit to many products in a single log line', async () => {
    await seed(product('S3'), product('S4'), product('G3', { route: 'shotblast' }));
    const { updated } = await bulkPatchProducts(['S3', 'S4', 'G3'], { cureDays: 3 });

    expect(updated).toBe(3);
    const all = await db.products.toArray();
    expect(all.every((p) => p.cureDays === 3)).toBe(true);

    const events = await db.events.toArray();
    expect(events.filter((e) => e.action === 'product.update')).toHaveLength(1);
    expect(events[0]?.detail).toContain('3 products');
  });

  it('leaves a code it has never seen alone', async () => {
    await seed(product('S3'));
    const after = await patchProduct('NOPE', { enabled: true });
    expect(after).toBeNull();
    expect(await db.products.get('NOPE')).toBeUndefined();
  });
});

describe('manual row order', () => {
  beforeEach(reset);

  const lineup = () => [
    product('A', { rank: 1000 }),
    product('B', { rank: 2000 }),
    product('C', { rank: 3000 }),
  ];

  it('drops a row between two others by taking the midpoint rank', async () => {
    await seed(...lineup());
    const list = await db.products.orderBy('rank').toArray();

    // Drag C (rank 3000) up between A and B.
    await moveProductInList('C', 1, list);

    const ordered = (await db.products.orderBy('rank').toArray()).map((p) => p.code);
    expect(ordered).toEqual(['A', 'C', 'B']);
    // Only the moved row was rewritten.
    expect((await db.products.get('A'))?.rank).toBe(1000);
    expect((await db.products.get('B'))?.rank).toBe(2000);
    const moved = await db.products.get('C');
    expect(moved!.rank).toBeGreaterThan(1000);
    expect(moved!.rank).toBeLessThan(2000);
  });

  it('re-spaces the visible list when the gap runs out', async () => {
    // 1 and 1 + 2^-52: no float fits between them, so a midpoint insert is
    // impossible and the block has to be re-numbered instead.
    await seed(
      product('A', { rank: 1 }),
      product('B', { rank: 1.0000000000000002 }),
      product('C', { rank: 3000 }),
    );
    const list = await db.products.orderBy('rank').toArray();

    await moveProductInList('C', 1, list);

    const ranks = (await db.products.orderBy('rank').toArray()).map((p) => p.rank);
    expect(new Set(ranks).size).toBe(3);
    expect(ranks.at(-1)).toBeGreaterThan(ranks[0]!);
    const events = await db.events.toArray();
    expect(events.some((e) => e.action === 'rank.change' && e.detail?.includes('Re-spaced'))).toBe(true);
  });

  it('does nothing when the row is dropped where it already was', async () => {
    await seed(...lineup());
    const list = await db.products.orderBy('rank').toArray();
    await moveProductInList('B', 1, list);

    expect(await db.events.count()).toBe(0);
    expect((await db.products.get('B'))?.rank).toBe(2000);
  });
});

describe('settings CSV round trip', () => {
  beforeEach(reset);

  it('survives commas, quotes and newlines in the text columns', async () => {
    await seed(
      product('S3', {
        enabled: true,
        route: 'shotblast',
        usesBaseline10000: true,
        trayYield: 0.48,
        target: 4752,
        cureDays: 3,
        notes: 'off the blast line, "always"',
        unit: 'lm',
      }),
    );

    const csv = productsToCsv(await db.products.toArray());
    expect(splitCsv(csv)[0]).toEqual(
      'code,description,enabled,route,unit,baseline10000,trayYield,target,cureDays,notes'.split(','),
    );

    const parsed = parseProductsCsv(csv);
    expect(parsed.issues).toEqual([]);
    expect(parsed.updates[0]?.patch).toMatchObject({
      enabled: true,
      route: 'shotblast',
      unit: 'lm',
      usesBaseline10000: true,
      trayYield: 0.48,
      target: 4752,
      cureDays: 3,
      notes: 'off the blast line, "always"',
    });
  });

  it('leaves blank cells alone so a unit-only sheet is safe to import', async () => {
    await seed(product('S3', { enabled: true, target: 1500, cureDays: 4, route: 'shotblast', notes: 'mine' }));

    // A hand-made sheet carrying only the columns being filled in.
    const parsed = parseProductsCsv('code,unit\r\nS3,lm\r\n');
    expect(parsed.issues).toEqual([]);
    expect(parsed.updates).toEqual([{ code: 'S3', patch: { unit: 'lm' } }]);

    const { updated, unknown } = await applyCsvUpdates(parsed.updates);
    expect({ updated, unknown }).toEqual({ updated: 1, unknown: [] });

    const after = await db.products.get('S3');
    expect({ route: after?.route, target: after?.target, cureDays: after?.cureDays, notes: after?.notes }).toEqual({
      route: 'shotblast',
      target: 1500,
      cureDays: 4,
      notes: 'mine',
    });
  });

  it('treats a notes column as authoritative, so a note can be cleared', async () => {
    await seed(product('S3', { notes: 'no longer true' }));

    const parsed = parseProductsCsv('code,notes\r\nS3,\r\n');
    expect(parsed.updates[0]?.patch.notes).toBe('');
    await applyCsvUpdates(parsed.updates);
    expect((await db.products.get('S3'))?.notes).toBe('');
  });

  it('reports a bad value by line instead of writing nonsense', async () => {
    await seed(product('S3'));
    const parsed = parseProductsCsv(
      'code,route,cureDays\r\nS3,blusted,x\r\nS3,shotblast,3\r\nS9,shotblast,1\r\n',
    );

    expect(parsed.issues.map((i) => i.line)).toEqual([2, 2]);
    expect(parsed.issues[0]?.message).toContain('unknown route');
    // The good line is still applied.
    const { updated, unknown } = await applyCsvUpdates(parsed.updates);
    expect(updated).toBe(1);
    // A code that never came out of MYOB is reported, not invented.
    expect(unknown).toEqual(['S9']);
    expect(await db.products.get('S9')).toBeUndefined();
  });

  it('refuses a sheet with no code column', () => {
    const parsed = parseProductsCsv('item,qty\nS3,10\n');
    expect(parsed.updates).toEqual([]);
    expect(parsed.issues[0]?.message).toContain('code column');
  });
});
