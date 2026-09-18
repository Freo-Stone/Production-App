import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

export interface Rendered {
  host: HTMLElement;
  root: Root;
  rerender: (node: ReactNode) => void;
  unmount: () => void;
  /** Cells of a row, in visual order. */
  rowCells: (rowIndex: number) => string[];
  headerLabels: () => string[];
}

/**
 * Minimal render harness.
 *
 * No testing-library: the app's UI is a grid of divs with roles, and asserting
 * on `role="row"`/`role="columnheader"` directly keeps the dependency surface
 * small and the assertions honest about what a screen reader would see.
 */
export function render(node: ReactNode): Rendered {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(node));

  return {
    host,
    root,
    rerender: (next) =>
      act(() => {
        root.render(next);
      }),
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
    rowCells: (rowIndex) => {
      const rows = host.querySelectorAll<HTMLElement>('[role="row"]');
      const row = rows[rowIndex];
      if (!row) return [];
      return [...row.querySelectorAll('.dt-cell')].map((c) => (c.textContent ?? '').trim());
    },
    headerLabels: () =>
      [...host.querySelectorAll('[role="columnheader"]')].map((h) => (h.textContent ?? '').trim()),
  };
}

export function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

export function headerNamed(host: HTMLElement, label: string): HTMLElement {
  const found = [...host.querySelectorAll('[role="columnheader"]')].find((h) =>
    (h.textContent ?? '').startsWith(label),
  );
  if (!found) throw new Error(`no column header matching "${label}"`);
  return found as HTMLElement;
}

export function rows(host: HTMLElement): HTMLElement[] {
  // role="row" includes the totals row, which is marked with .dt-totals.
  return [...host.querySelectorAll<HTMLElement>('[role="row"]:not(.dt-totals)')];
}

export function cellTexts(host: HTMLElement, columnIndex: number): string[] {
  return rows(host).map((r) => (r.querySelectorAll('.dt-cell')[columnIndex]?.textContent ?? '').trim());
}
