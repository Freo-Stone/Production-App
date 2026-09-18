import * as XLSX from 'xlsx';
import type { Cell, Grid } from '@/lib/myob/workbook';

/**
 * Build real .xlsx bytes from a grid so the classifier can be tested against
 * actual workbook parsing (ragged rows, blank cells, typed numbers) rather than
 * against the grid shape it hopes the reader produced.
 */
export function workbookBytes(sheets: Array<{ name: string; grid: Grid }>): Uint8Array {
  const wb = XLSX.utils.book_new();
  for (const { name, grid } of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(grid as Cell[][]);
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
}

/** The banner MYOB stamps on every report, rows 1-9. */
export function banner(title: string, period = '1/01/2026 To 17/09/2026'): Grid {
  return [
    [null, null],
    [null, 'Kestrel Imports Pty Ltd'],
    [null, 'as T/F The Placeholder Stone Trust'],
    [null, 'Trading as Placeholder Pavers'],
    [null, '1 Example Street'],
    [null, 'Placeholder WA 6000'],
    [null, title],
    [null, period],
    [null, null],
  ];
}
