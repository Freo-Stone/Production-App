import type { SortPref, ViewDef } from '@/core/types';

/**
 * Pure view-preference edits.
 *
 * Kept free of React and Dexie so the ordering/visibility rules can be tested
 * directly, and so a screen can compute a preview before it commits a write.
 */

export function withColumnWidth(view: ViewDef, key: string, width: number | null): ViewDef {
  return {
    ...view,
    columns: view.columns.map((c) => (c.key === key ? { ...c, width } : c)),
  };
}

export function withColumnVisible(view: ViewDef, key: string, visible: boolean): ViewDef {
  return {
    ...view,
    columns: view.columns.map((c) => (c.key === key ? { ...c, visible } : c)),
  };
}

/** Header drag-to-reorder. `to` is an index in the currently visible order. */
export function withColumnMoved(view: ViewDef, key: string, to: number): ViewDef {
  const ordered = [...view.columns].sort((a, b) => a.order - b.order);
  const from = ordered.findIndex((c) => c.key === key);
  if (from < 0 || from === to) return view;
  const [moved] = ordered.splice(from, 1);
  if (moved) ordered.splice(to, 0, moved);
  return { ...view, columns: ordered.map((c, i) => ({ ...c, order: i })) };
}

/**
 * Click cycles asc → desc → unsorted, so a single tap is always "most
 * interesting first" (biggest shortfall, newest date) rather than ascending.
 * Shift-click adds the column to a multi-column sort.
 */
export function withSortToggled(view: ViewDef, key: string, additive = false): ViewDef {
  const existing = view.sort.find((s) => s.key === key);
  if (additive) {
    const next: SortPref[] = existing
      ? view.sort.map((s) => (s.key === key ? { ...s, dir: s.dir === 'asc' ? 'desc' : 'asc' } : s))
      : [...view.sort, { key, dir: 'desc' }];
    return { ...view, sort: next, sortMode: 'column' };
  }
  if (!existing) return { ...view, sort: [{ key, dir: 'desc' }], sortMode: 'column' };
  if (existing.dir === 'desc') return { ...view, sort: [{ key, dir: 'asc' }], sortMode: 'column' };
  // Third click clears the sort, which in manual mode means the manual order.
  return { ...view, sort: [], sortMode: 'manual' };
}

export function withSortMode(view: ViewDef, sortMode: ViewDef['sortMode']): ViewDef {
  return { ...view, sortMode, sort: sortMode === 'manual' ? [] : view.sort };
}

export function withDensity(view: ViewDef, density: ViewDef['density']): ViewDef {
  return { ...view, density };
}

/** Mobile column subset; `null` means "same columns as desktop". */
export function withMobileColumns(view: ViewDef, keys: string[] | null): ViewDef {
  return { ...view, mobileColumns: keys };
}

/**
 * Column prefs must cover every column a screen declares, including ones added
 * after the view was saved; otherwise a new column would be invisible forever.
 */
export function reconcileColumns(view: ViewDef, declaredKeys: string[]): ViewDef {
  const known = new Set(view.columns.map((c) => c.key));
  const extra = declaredKeys.filter((k) => !known.has(k)).map((key, i) => ({
    key,
    visible: true,
    width: null,
    order: view.columns.length + i,
  }));
  const kept = view.columns.filter((c) => declaredKeys.includes(c.key));
  if (extra.length === 0 && kept.length === view.columns.length) return view;
  return { ...view, columns: [...kept, ...extra] };
}

export function sortLabel(view: ViewDef, key: string): 'asc' | 'desc' | null {
  return view.sort.find((s) => s.key === key)?.dir ?? null;
}

export function sortOrdinal(view: ViewDef, key: string): number {
  return view.sort.findIndex((s) => s.key === key);
}
