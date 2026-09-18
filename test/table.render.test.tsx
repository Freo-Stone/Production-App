// @vitest-environment jsdom
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { defaultView } from '@/core/defaults';
import type { ViewDef } from '@/core/types';
import { DataTable, type ColumnDef } from '@/ui/DataTable';
import { withColumnWidth, withSortToggled } from '@/ui/DataTable/viewPrefs';
import { cellTexts, click, headerNamed, render, rows } from './support/render';

interface Row {
  code: string;
  description: string;
  stock: number;
  promised: number | null;
}

const COLUMNS: ColumnDef<Row>[] = [
  { key: 'code', header: 'Item No.', value: (r) => r.code, format: 'code', sticky: true, width: 90 },
  { key: 'description', header: 'Description', value: (r) => r.description, width: 200 },
  { key: 'stock', header: 'Stock', value: (r) => r.stock, format: 'number', decimals: 2, totals: 'sum', width: 110 },
  { key: 'promised', header: 'Promised', value: (r) => r.promised, format: 'date', width: 110 },
];

const ROWS: Row[] = [
  { code: 'AL3', description: 'Alpha 3 course', stock: 165.01, promised: Date.parse('2026-09-24') },
  { code: 'A6', description: 'Split face', stock: 81.43, promised: null },
  { code: 'A3', description: 'Standard paver', stock: 12345.5, promised: Date.parse('2026-09-18') },
  { code: 'M6', description: 'Oversold item', stock: -209.77, promised: Date.parse('2026-09-20') },
];

function view(overrides: Partial<ViewDef> = {}): ViewDef {
  return { ...defaultView('test.table', COLUMNS.map((c) => c.key)), ...overrides };
}

/**
 * The table is fully controlled, so a test drives it by holding the view in a
 * variable and repainting with whatever the table asked for.
 */
function harness(starting: ViewDef = view()) {
  let v = starting;
  const patches: Array<Partial<ViewDef>> = [];
  const painted = render(
    <DataTable
      rows={ROWS}
      columns={COLUMNS}
      view={v}
      getRowId={(r) => r.code}
      onViewChange={(patch) => {
        patches.push(patch);
        v = { ...v, ...patch };
        paint();
      }}
    />,
  );

  function paint(): void {
    painted.rerender(
      <DataTable
        rows={ROWS}
        columns={COLUMNS}
        view={v}
        getRowId={(r) => r.code}
        onViewChange={(patch) => {
          patches.push(patch);
          v = { ...v, ...patch };
          paint();
        }}
      />,
    );
  }

  return {
    ...painted,
    patches,
    get view(): ViewDef {
      return v;
    },
  };
}

describe('DataTable', () => {
  it('renders headers and one row per record', () => {
    const t = harness();
    expect(t.headerLabels().slice(0, 4)).toEqual(['Item No.', 'Description', 'Stock', 'Promised']);
    expect(rows(t.host)).toHaveLength(ROWS.length);
    // No sort chosen: rows stay exactly as the screen supplied them.
    expect(cellTexts(t.host, 0)).toEqual(['AL3', 'A6', 'A3', 'M6']);
    t.unmount();
  });

  it('sorts item codes naturally, so A6 lands between A3 and AL3', () => {
    const t = harness();

    // First click is descending: the biggest/last thing first is the useful default.
    click(headerNamed(t.host, 'Item No.'));
    expect(cellTexts(t.host, 0)).toEqual(['M6', 'AL3', 'A6', 'A3']);

    click(headerNamed(t.host, 'Item No.'));
    expect(cellTexts(t.host, 0)).toEqual(['A3', 'A6', 'AL3', 'M6']);

    // Third click drops the sort again, back to the supplied order.
    click(headerNamed(t.host, 'Item No.'));
    expect(t.view.sort).toEqual([]);
    expect(t.view.sortMode).toBe('manual');
    t.unmount();
  });

  it('formats numbers and dates, and keeps a negative visible', () => {
    const t = harness();
    const stock = cellTexts(t.host, 2);
    expect(stock).toContain('12,345.50');
    expect(stock).toContain('-209.77');
    expect(cellTexts(t.host, 3)).toContain('18/09/2026');
    // A missing date is blank, never 01/01/1970.
    expect(cellTexts(t.host, 3)[1]).toBe('');
    t.unmount();
  });

  it('keeps blanks at the bottom whichever way the sort runs', () => {
    // An empty promised date at the top would read as "due soonest".
    for (const dir of ['asc', 'desc'] as const) {
      const t = harness({ ...view(), sort: [{ key: 'promised', dir }] });
      expect(cellTexts(t.host, 3).at(-1)).toBe('');
      t.unmount();
    }
  });

  it('totals the columns that ask for it', () => {
    const t = harness();
    const totals = t.host.querySelector('.dt-totals');
    expect(totals?.textContent).toContain('12,382.17');
    t.unmount();
  });

  it('applies a saved column width and the saved density', () => {
    const t = harness(withColumnWidth(view({ density: 'compact' }), 'description', 321));
    expect((t.host.querySelector('.dt-head') as HTMLElement).style.gridTemplateColumns).toContain('321px');
    expect(t.host.querySelector('[data-density="compact"]')).not.toBeNull();
    t.unmount();
  });

  it('pins the leading column so it survives sideways scroll', () => {
    const t = harness();
    const pinned = t.host.querySelector('[role="row"] .dt-cell[data-pinned="true"]') as HTMLElement;
    expect(pinned).not.toBeNull();
    expect(pinned.style.left).toBe('0px');
    t.unmount();
  });

  it('emits a patch on header click instead of mutating the caller’s view', () => {
    const onViewChange = vi.fn();
    const v = view();
    const t = render(
      <DataTable rows={ROWS} columns={COLUMNS} view={v} getRowId={(r) => r.code} onViewChange={onViewChange} />,
    );
    click(headerNamed(t.host, 'Stock'));
    expect(onViewChange).toHaveBeenCalledWith({ sort: [{ key: 'stock', dir: 'desc' }], sortMode: 'column' });
    expect(v.sort).toEqual([]);
    t.unmount();
  });

  it('shows drag handles only in manual order mode, and reserves a column for them', () => {
    const manual = render(
      <DataTable
        rows={ROWS}
        columns={COLUMNS}
        view={view({ sortMode: 'manual' })}
        getRowId={(r) => r.code}
        onViewChange={() => {}}
        onReorder={() => {}}
      />,
    );
    expect(manual.host.querySelectorAll('[aria-label^="Reorder"]').length).toBe(ROWS.length);
    // Handle column is prepended to the grid.
    expect((manual.host.querySelector('.dt-head') as HTMLElement).style.gridTemplateColumns).toMatch(/^28px/);
    manual.unmount();

    const sorted = render(
      <DataTable
        rows={ROWS}
        columns={COLUMNS}
        view={withSortToggled(view(), 'code')}
        getRowId={(r) => r.code}
        onViewChange={() => {}}
        onReorder={() => {}}
      />,
    );
    expect(sorted.host.querySelectorAll('[aria-label^="Reorder"]').length).toBe(0);
    sorted.unmount();
  });

  it('paints a cell from a user format rule', () => {
    const t = harness({
      ...view(),
      formatRules: [
        { id: 'r1', column: 'stock', when: 'isNegative', value: null, value2: null, tone: 'short' },
      ],
    });
    const negative = rows(t.host).find((r) => (r.textContent ?? '').includes('-209.77'));
    expect(negative?.querySelector('.text-short')).toBeDefined();
    t.unmount();
  });

  it('carries a resize drag on window listeners when capture is unavailable', () => {
    // jsdom has no setPointerCapture, so this is exactly the path a lost capture
    // becomes on a real touchscreen: the header re-renders on every width change,
    // and a drag that only listened on the 9px handle would die mid-move.
    const t = harness();
    const handle = headerNamed(t.host, 'Description').querySelector<HTMLElement>('[role="separator"]');
    expect(handle).not.toBeNull();
    const pointer = (type: string, target: EventTarget, x: number) =>
      act(() => {
        target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, button: 0 }));
      });
    const template = () =>
      (t.host.querySelector('.dt-head') as HTMLElement).style.gridTemplateColumns;

    pointer('pointerdown', handle!, 100);
    pointer('pointermove', window, 170);
    // Description starts at 200px, so 70px of travel is a 270px column.
    expect(template()).toContain('270px');

    pointer('pointerup', window, 170);
    // The live width is dropped and the saved view carries the new one, so the
    // grid does not snap back on release.
    expect(template()).toContain('270px');
    expect(t.patches.at(-1)?.columns?.find((c) => c.key === 'description')?.width).toBe(270);
    t.unmount();
  });

  it('renders the empty state instead of a blank grid', () => {
    const t = render(
      <DataTable
        rows={[]}
        columns={COLUMNS}
        view={view()}
        getRowId={(r) => r.code}
        onViewChange={() => {}}
        empty={<p>No stock imported yet</p>}
      />,
    );
    expect(t.host.textContent).toContain('No stock imported yet');
    t.unmount();
  });
});
