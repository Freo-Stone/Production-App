import * as XLSX from 'xlsx';

/** A sheet as a plain 2-D grid. MYOB reports are positional, so grid access is
 *  what the row classifiers need — not typed objects. */
export type Cell = string | number | boolean | null;
export type Grid = Cell[][];

export interface Sheet {
  name: string;
  grid: Grid;
}

/**
 * Read a workbook's bytes into grids.
 *
 * `cellDates: false` matters: the exports store dates as `d/mm/yyyy` *text*, and
 * letting SheetJS coerce them risks US-style m/d/y reinterpretation. Text is
 * parsed explicitly by core/dates instead.
 */
export function readWorkbook(data: ArrayBuffer | Uint8Array): Sheet[] {
  const wb = XLSX.read(data, { type: data instanceof Uint8Array ? 'array' : 'array', cellDates: false });
  return wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    const grid = ws
      ? (XLSX.utils.sheet_to_json<Cell[]>(ws, {
          header: 1,
          raw: true,
          defval: null,
          blankrows: true,
        }) as Grid)
      : [];
    return { name, grid: grid.map((r) => (Array.isArray(r) ? r : [])) };
  });
}

/** Cell getter that tolerates the ragged rows `sheet_to_json` produces. */
export function cell(grid: Grid, row: number, col: number): Cell {
  return grid[row]?.[col] ?? null;
}

export function text(v: Cell | undefined): string {
  if (v == null) return '';
  return typeof v === 'string' ? v.trim() : String(v).trim();
}

export function number(v: Cell): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const cleaned = v.replace(/[, $]/g, '').trim();
    if (!cleaned) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function isBlank(v: Cell): boolean {
  return v == null || (typeof v === 'string' && v.trim() === '');
}

/**
 * Locate the header row instead of trusting a fixed row number: the reports
 * carry a company/period banner above it, and a re-export that adds one line
 * would otherwise shift every rule below it.
 */
export function findHeaderRow(grid: Grid, requiredLabels: string[], maxRow = 25): number | null {
  const wanted = requiredLabels.map((l) => l.toLowerCase());
  for (let r = 0; r < Math.min(grid.length, maxRow); r++) {
    const row = (grid[r] ?? []).map((c) => text(c).toLowerCase());
    if (wanted.every((label) => row.includes(label))) return r;
  }
  return null;
}

/** Header label -> column index (first match, case-insensitive). */
export function columnIndex(grid: Grid, headerRow: number, label: string): number | null {
  const wanted = label.toLowerCase();
  const row = grid[headerRow] ?? [];
  for (let c = 0; c < row.length; c++) {
    if (text(row[c]).toLowerCase() === wanted) return c;
  }
  return null;
}

/** Report banner text, e.g. `Sales [Item Detail]` / `Item List [Summary]`. */
export function reportTitle(grid: Grid, maxRow = 14): string {
  for (let r = 0; r < Math.min(grid.length, maxRow); r++) {
    for (const c of grid[r] ?? []) {
      const t = text(c);
      if (/\[[^\]]+\]/.test(t) && /[A-Za-z]/.test(t)) return t;
    }
  }
  return '';
}
