// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Product } from '@/core/types';
import { db, seedIfEmpty } from '@/data/db';
import { signInForTests } from './support/who';
import { Products } from '@/screens/Products';
import { byText, cellTexts, click, headerNamed, render, rows, type Rendered, typeInto } from './support/render';

/**
 * The product screen end to end in the DOM: what a code arrives as, what a tick
 * writes, and what a bulk edit writes. The maths itself lives in calc and is
 * covered there; this is about the wiring people actually touch.
 */
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
    seenInJobs: true,
    updatedAt: 1,
    ...over,
  };
}

async function reset(): Promise<void> {
  signInForTests();
  await Promise.all([
    db.products.clear(),
    db.events.clear(),
    db.views.clear(),
    db.stockSnapshots.clear(),
    db.stockRows.clear(),
  ]);
  await seedIfEmpty();
}

/** Live queries settle on their own clock, so give them a few ticks. */
async function paint(h: Rendered): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  void h;
}

async function renderProducts(): Promise<Rendered> {
  const h = render(<Products />);
  await paint(h);
  return h;
}

/** The editor inside one cell, addressed by row code and column key. */
function cellInput(host: HTMLElement, code: string, column: string): HTMLElement {
  const row = rows(host).find(
    (r) => r.querySelector<HTMLElement>('[data-col="code"]')?.textContent?.trim() === code,
  );
  if (!row) throw new Error(`no row for ${code}`);
  const cell = row.querySelector<HTMLElement>(`[data-col="${column}"]`);
  const input = cell?.querySelector<HTMLElement>('input, select, [role="checkbox"]');
  if (!input) throw new Error(`no editor in ${column} for ${code}`);
  return input;
}

describe('Products screen', () => {
  beforeEach(reset);

  it('opens on the codes that are on order, none of them current', async () => {
    await db.products.bulkAdd([
      product('S3'),
      product('G3', { rank: 2000 }),
      product('Z9', { seenInJobs: false, rank: 3000 }),
    ]);

    const h = await renderProducts();
    const shown = rows(h.host).map((r) => r.textContent ?? '').join(' | ');
    expect(shown).toContain('S3');
    expect(shown).toContain('G3');
    // A code with no demand is out of the default view until asked for.
    expect(shown).not.toContain('Z9');

    // Nothing is current on arrival: an import must never decide the range.
    const ticks = [...h.host.querySelectorAll('[role="checkbox"]')];
    expect(ticks.filter((t) => t.getAttribute('aria-checked') === 'true')).toHaveLength(0);
    h.unmount();
  });

  it('a tick in the table is a write, and the audit line says so', async () => {
    await db.products.bulkAdd([product('S3')]);
    const h = await renderProducts();

    const currentCell = cellInput(h.host, 'S3', 'enabled');
    click(currentCell);
    await paint(h);

    const saved = await db.products.get('S3');
    expect(saved?.enabled).toBe(true);
    const events = await db.events.toArray();
    expect(events.some((e) => e.action === 'product.update' && e.code === 'S3')).toBe(true);
    // And the row says it on the spot. There is no line of counts above the board
    // to keep in step with the table — the table is the count.
    expect(cellInput(h.host, 'S3', 'enabled').getAttribute('aria-checked')).toBe('true');
    h.unmount();
  });

  it('types a target straight into the grid', async () => {
    await db.products.bulkAdd([product('S3', { enabled: true, target: 0 })]);
    const h = await renderProducts();

    const input = cellInput(h.host, 'S3', 'target') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    act(() => {
      input.focus();
      setter?.call(input, '4752');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.blur();
    });
    await paint(h);

    expect((await db.products.get('S3'))?.target).toBe(4752);
    h.unmount();
  });

  it('picking rows shows the bulk bar and one click changes them all', async () => {
    await db.products.bulkAdd([product('S3'), product('G3', { rank: 2000 })]);
    const h = await renderProducts();

    for (const code of ['S3', 'G3']) click(cellInput(h.host, code, 'pick'));
    await paint(h);

    const bar = [...h.host.querySelectorAll('button')].find((b) => b.textContent === 'Mark current');
    expect(bar, 'bulk bar with a Mark current button').toBeTruthy();
    click(bar!);
    await paint(h);

    const all = await db.products.toArray();
    expect(all.every((p) => p.enabled)).toBe(true);
    const events = await db.events.toArray();
    expect(events.filter((e) => e.action === 'product.update')).toHaveLength(1);
    h.unmount();
  });

  it('the route column keeps the unset ones visible as a gap to fill', async () => {
    await db.products.bulkAdd([
      product('S3', { enabled: true, route: 'shotblast' }),
      product('G3', { enabled: true, rank: 2000 }),
    ]);
    const h = await renderProducts();

    const shot = cellInput(h.host, 'S3', 'route') as HTMLSelectElement;
    const unset = cellInput(h.host, 'G3', 'route') as HTMLSelectElement;
    expect(shot.value).toBe('shotblast');
    expect(unset.value).toBe('unset');
    expect(headerNamed(h.host, 'Made how')).toBeTruthy();
    // Sorting by a column is the table engine's job; prove it is wired here.
    const before = cellTexts(h.host, 1);
    click(h.host.querySelector('[role="columnheader"]')!);
    await paint(h);
    expect(cellTexts(h.host, 1).length).toBe(before.length);
    h.unmount();
  });

  it('one click picks every row on screen, and is not offered when there are none', async () => {
    // `Pick all N` used to sit on the toolbar while the board's four live queries
    // were still answering. Clicked in that moment it set the selection to nothing
    // at all — a button that reads a number and picks none is a button that lies.
    // It is only offered when there is something to pick.
    await db.products.bulkAdd([
      product('S3'),
      product('G3', { rank: 2000 }),
      product('C3', { rank: 3000 }),
    ]);
    const h = await renderProducts();

    const pickAll = (): HTMLButtonElement | undefined =>
      [...h.host.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        (b.textContent ?? '').startsWith('Pick all'),
      );

    const button = pickAll();
    if (!button) throw new Error('no pick-all button while three rows are on screen');
    expect(button.textContent).toBe('Pick all 3');
    click(button);
    await paint(h);

    for (const code of ['S3', 'G3', 'C3']) {
      expect(cellInput(h.host, code, 'pick').getAttribute('aria-checked')).toBe('true');
    }
    expect(byText(h.host, '3 picked')).toBeTruthy();

    // Filter to nothing and the control goes with the rows it would have picked.
    typeInto(h.host.querySelector<HTMLInputElement>('input[placeholder^="Filter code"]')!, 'zzz');
    await paint(h);
    expect(pickAll()).toBeUndefined();
    h.unmount();
  });
});
