import { compareNatural, formatCellValue } from '@/core/format';
import type { ColumnAlign, ColumnFormat, ColumnPref, FormatRule, SortPref, ViewDef } from '@/core/types';
import type { ReactNode } from 'react';

/**
 * Column contract for every table in the app.
 *
 * `value` returns the RAW value; formatting lives in `format` so a column can be
 * re-formatted from the saved view without touching component code. That is what
 * lets a user change alignment or decimals and have it stick for their account.
 */
export interface ColumnDef<T> {
  key: string;
  header: string;
  value: (row: T) => unknown;
  render?: (row: T, ctx: { text: string; value: unknown }) => ReactNode;
  format?: ColumnFormat;
  align?: ColumnAlign;
  decimals?: number;
  /** Unit for `qty` cells (m² / lm / pieces). */
  unit?: (row: T) => string | undefined;
  /** Default width in px; a saved view width wins over this. */
  width?: number;
  minWidth?: number;
  /** Leading columns may be pinned while the table scrolls sideways. */
  sticky?: boolean;
  sortable?: boolean;
  /** Header accepts a row dropped on it (drag-to-stage in the production log). */
  dropStage?: string;
  totals?: 'sum' | 'count' | 'none' | ((rows: T[]) => string);
  /** Cell colour from data, e.g. short stock. */
  tone?: (row: T) => 'short' | 'curing' | 'warn' | 'info' | null;
  headerHint?: string;
  /** Default wrap for long text cells. */
  wrap?: boolean;
}

export const MIN_COL_WIDTH = 56;
export const DEFAULT_COL_WIDTH = 140;

const WIDTH_BY_FORMAT: Record<ColumnFormat, number> = {
  text: 220,
  number: 96,
  qty: 118,
  date: 104,
  status: 128,
  code: 84,
};

/* ── Resolved columns ──────────────────────────────────────────────────────── */

/**
 * A declared column with everything the renderer needs decided: width, order,
 * pinning, and the format/alignment the user may have overridden.
 *
 * Saved prefs win over the component's defaults, which is the whole point of
 * storing a view: the screen suggests a layout, the person using it owns it.
 */
export interface OrderedColumn<T> {
  column: ColumnDef<T>;
  key: string;
  width: number;
  visible: boolean;
  /** px offset from the left edge for pinned columns, else null. */
  stickyLeft: number | null;
  align: ColumnAlign;
  format: ColumnFormat;
  decimals: number | undefined;
  wrap: boolean;
  pinnedByUser: boolean;
}

function widthFor<T>(col: ColumnDef<T>, pref: ColumnPref | undefined): number {
  if (pref?.width != null && pref.width > 0) {
    return Math.max(col.minWidth ?? MIN_COL_WIDTH, pref.width);
  }
  return col.width ?? WIDTH_BY_FORMAT[col.format ?? 'text'];
}

/**
 * Merge saved column prefs over the columns a screen declares: saved order and
 * visibility first, then anything new (a column added in a later build) appended
 * in declaration order, and saved keys that no longer exist dropped.
 *
 * Hidden columns are returned too, flagged as invisible: a saved sort on a column
 * someone hid must keep working, otherwise hiding a column quietly changes the
 * order of the table.
 */
export function resolveColumns<T>(
  columns: ColumnDef<T>[],
  view: ViewDef,
  opts: { compact?: boolean } = {},
): OrderedColumn<T>[] {
  const prefs = new Map(view.columns.map((c) => [c.key, c]));
  const byKey = new Map(columns.map((c) => [c.key, c]));

  const ordered: ColumnDef<T>[] = [];
  for (const pref of [...view.columns].sort((a, b) => a.order - b.order)) {
    const col = byKey.get(pref.key);
    if (col) {
      ordered.push(col);
      byKey.delete(pref.key);
    }
  }
  for (const leftover of byKey.values()) ordered.push(leftover);

  // On a phone the user picks the short list; on desktop the visible checkboxes.
  const mobileSet = opts.compact && view.mobileColumns ? new Set(view.mobileColumns) : null;
  const isVisible = (key: string): boolean => {
    const pref = prefs.get(key);
    const desktopVisible = pref ? pref.visible : true;
    return mobileSet ? mobileSet.has(key) : desktopVisible;
  };

  let left = 0;
  const out: OrderedColumn<T>[] = [];
  ordered.forEach((column, index) => {
    const pref = prefs.get(column.key);
    const format = pref?.format ?? column.format ?? 'text';
    const align =
      pref?.align ??
      column.align ??
      (format === 'number' || format === 'qty' ? 'right' : 'left');

    // Only an unbroken run from the left can be pinned: a pinned column with a
    // scrolling column in front of it would float over the wrong data.
    const canStick = (column.sticky ?? false) && view.stickyFirstColumn && index === out.length;
    const stickyLeft = canStick ? left : null;
    if (canStick) left += widthFor(column, pref);

    out.push({
      column,
      key: column.key,
      width: widthFor(column, pref),
      visible: isVisible(column.key),
      stickyLeft,
      align,
      format,
      decimals: pref?.decimals ?? column.decimals,
      wrap: pref?.wrap ?? column.wrap ?? false,
      pinnedByUser: canStick,
    });
  });

  // Widths of hidden columns must still be counted for the pin offsets of the
  // visible ones, so pinning is recomputed over the visible run only.
  let visibleLeft = 0;
  for (const entry of out) {
    if (!entry.visible) {
      entry.stickyLeft = null;
      continue;
    }
    if (entry.pinnedByUser) {
      entry.stickyLeft = visibleLeft;
      visibleLeft += entry.width;
    } else {
      entry.stickyLeft = null;
    }
  }
  return out;
}

/** CSS grid template for the row grid. */
export function gridTemplate(cols: Array<{ width: number }>): string {
  return cols.map((c) => `${c.width}px`).join(' ');
}

/* ── Ordering ──────────────────────────────────────────────────────────────── */

/**
 * Type-aware compare. Two cases matter more than any other here: quantities must
 * not sort as text (so 10 does not land before 9), and item codes must sort
 * naturally, because `A3`, `A6`, `AL3` is how the shop already reads its lists.
 */
export function compareByFormat(a: unknown, b: unknown, format: ColumnFormat): number {
  const aMissing = a == null || a === '';
  const bMissing = b == null || b === '';
  // Blanks always fall to the bottom, whichever way the sort runs.
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;

  switch (format) {
    case 'number':
    case 'qty':
    case 'date':
      return Number(a) - Number(b);
    case 'code':
      return compareNatural(String(a), String(b));
    case 'status':
      return String(a).localeCompare(String(b), 'en-AU');
    default:
      if (typeof a === 'number' && typeof b === 'number') return a - b;
      return String(a).localeCompare(String(b), 'en-AU', { numeric: true });
  }
}

function presenceRank(value: unknown): number {
  return value == null || value === '' ? 1 : 0;
}

export interface SortOptions<T> {
  /** Tie-break, so a sort never reshuffles rows the user parked by hand. */
  rank?: (row: T) => number;
  idOf: (row: T) => string;
}

/**
 * Multi-column sort in view order with a stable tie-break. Returns a new array:
 * Dexie live-query results are shared objects and must never be mutated.
 */
export function sortRows<T>(
  rows: T[],
  resolved: OrderedColumn<T>[],
  sort: SortPref[],
  opts: SortOptions<T>,
): T[] {
  if (sort.length === 0) return rows;
  const byKey = new Map(resolved.map((c) => [c.key, c]));
  const active = sort
    .map((s) => ({ pref: s, col: byKey.get(s.key) }))
    .filter((x): x is { pref: SortPref; col: OrderedColumn<T> } => x.col != null);
  if (active.length === 0) return rows;

  return [...rows].sort((a, b) => {
    for (const { pref, col } of active) {
      const dir = pref.dir === 'asc' ? 1 : -1;
      const av = col.column.value(a);
      const bv = col.column.value(b);
      // Blank first, and NOT multiplied by direction: an empty promised date at
      // the top of the list would read as "due soonest", which is the opposite
      // of what it means.
      const byPresence = presenceRank(av) - presenceRank(bv);
      if (byPresence !== 0) return byPresence;
      const cmp = compareByFormat(av, bv, col.format) * dir;
      if (cmp !== 0) return cmp;
    }
    if (opts.rank) {
      const byRank = opts.rank(a) - opts.rank(b);
      if (byRank !== 0) return byRank;
    }
    return opts.idOf(a) < opts.idOf(b) ? -1 : 1;
  });
}

/* ── Cells and totals ──────────────────────────────────────────────────────── */

export function cellText<T>(row: T, entry: OrderedColumn<T>): string {
  return formatCellValue(entry.column.value(row), entry.format, {
    decimals: entry.decimals,
    unit: entry.column.unit?.(row),
  });
}

const TONE_CLASS = {
  short: 'text-short',
  curing: 'text-curing',
  warn: 'text-warn',
  info: 'text-info',
} as const;

/**
 * Spelled out as literals on purpose: Tailwind only generates utilities it can
 * see in the source, so building `text-${tone}` at runtime would compile to
 * nothing and the cell would silently lose its colour.
 */
export function toneClass(tone: 'short' | 'curing' | 'warn' | 'info' | null | undefined): string {
  return tone == null ? '' : TONE_CLASS[tone];
}

/** First matching rule paints the cell; rules are user-defined. */
export function ruleTone(rules: FormatRule[], columnKey: string, value: unknown): string {
  const n = typeof value === 'number' ? value : null;
  for (const r of rules) {
    if (r.column !== columnKey || r.tone === 'none') continue;
    let hit = false;
    switch (r.when) {
      case 'above':
        hit = n != null && r.value != null && n > r.value;
        break;
      case 'below':
        hit = n != null && r.value != null && n < r.value;
        break;
      case 'between':
        hit = n != null && r.value != null && r.value2 != null && n >= r.value && n <= r.value2;
        break;
      case 'equals':
        hit = r.value != null && (n === r.value || String(value) === String(r.value));
        break;
      case 'isNegative':
        hit = n != null && n < 0;
        break;
      case 'isBlank':
        hit = value == null || value === '';
        break;
    }
    if (!hit) continue;
    return TONE_CLASS[r.tone];
  }
  return '';
}

export function totalsText<T>(entry: OrderedColumn<T>, rows: T[]): string {
  const col = entry.column;
  if (col.totals === 'none' || col.totals == null) return '';
  if (typeof col.totals === 'function') return col.totals(rows);
  if (col.totals === 'count') return String(rows.length);
  let sum = 0;
  for (const row of rows) {
    const v = col.value(row);
    if (typeof v === 'number' && Number.isFinite(v)) sum += v;
  }
  return formatCellValue(sum, entry.format, {
    decimals: entry.decimals,
    unit: rows[0] != null ? col.unit?.(rows[0]) : undefined,
  });
}
