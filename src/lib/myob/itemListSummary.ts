import type { ParseDiagnostics, StockRow } from '@/core/types';
import {
  cell,
  columnIndex,
  findHeaderRow,
  isBlank,
  number,
  reportTitle,
  text,
  type Grid,
} from './workbook';

/**
 * Parser for the MYOB **`Item List [Summary]`** export — the stock file (named
 * `location.xlsx` in the shop, which says nothing about its contents).
 *
 * It is grouped by inventory location, and the group rows are what make a naive
 * read wrong:
 *
 *   row 12  B=`NORTH`  C=`NORTH`          <- group header, label repeated
 *   row 2671 B=`TBN`   C=`DO NOT USE`     <- group header, label is a description
 *   row 14  B=blank    C=3.05  D=`Total:` <- location subtotal
 *   row 16  B=`A3`     C=165.01 D=`PAVERS`
 *
 * A group header is recognised as "text in the quantity column"; a subtotal is
 * "blank item with a numeric quantity". Verified on the real export: 2,691 stock
 * rows, 23 locations, 23 subtotals, nothing left unclassified.
 *
 * `qtyOnHandRaw` is stored exactly as exported. The phantom `+10000` baseline is
 * a per-product decision and is applied in core/calc, never here — auto-detecting
 * it as `>= 10000` would read short item M6 (9790.23) as 9790 m² of stock.
 */
export const ITEM_REQUIRED_HEADERS = ['Item No.', 'Units On Hand'];

export interface ItemParseResult {
  rows: StockRow[];
  /** Location groups in the order the report lists them. */
  locations: string[];
  /** Groups whose label column did not repeat the code — worth a glance. */
  ambiguousGroups: string[];
  reportTitle: string;
  headerRow: number;
  totalRows: number;
  blankRows: number;
  diagnostics: ParseDiagnostics;
}

export function parseItemListSummary(grid: Grid): ItemParseResult {
  const title = reportTitle(grid);
  const headerRow = findHeaderRow(grid, ITEM_REQUIRED_HEADERS);
  if (headerRow == null) {
    throw new Error(
      `Not an Item List [Summary] report: could not find a header row containing ${ITEM_REQUIRED_HEADERS.join(', ')}`,
    );
  }

  const itemCol = columnIndex(grid, headerRow, 'Item No.') ?? 1;
  const qtyCol = columnIndex(grid, headerRow, 'Units On Hand') ?? 2;
  // The category column is a MYOB custom list whose label can be renamed, so
  // fall back to the column right of the quantity rather than failing.
  const catCol = columnIndex(grid, headerRow, 'Custom List #3') ?? qtyCol + 1;

  const rows: StockRow[] = [];
  const locations: string[] = [];
  const ambiguousGroups: string[] = [];
  const unparsed: ParseDiagnostics['unparsed'] = [];
  let currentLocation: string | null = null;
  let totalRows = 0;
  let blankRows = 0;

  for (let r = headerRow + 1; r < grid.length; r++) {
    const item = cell(grid, r, itemCol);
    const qty = cell(grid, r, qtyCol);
    const cat = cell(grid, r, catCol);

    if (isBlank(item) && isBlank(qty) && isBlank(cat)) {
      blankRows++;
      continue;
    }

    // Group header: the quantity column holds a label, not a number, and the
    // category column is empty. The category test matters — without it an item
    // row whose quantity failed to export as a number would be silently reborn
    // as a brand-new inventory location.
    const qtyIsLabel = !isBlank(qty) && typeof qty === 'string' && number(qty) == null;
    if (!isBlank(item) && qtyIsLabel && isBlank(cat)) {
      currentLocation = text(item);
      locations.push(currentLocation);
      // 21 of 23 real groups repeat the code (`NORTH`/`NORTH`); the rest carry a
      // description (`TBN`/`DO NOT USE`). Flag the second kind so a mis-parse is
      // visible instead of quietly widening the location list.
      if (text(item) !== text(qty)) ambiguousGroups.push(`${text(item)} = ${text(qty)}`);
      continue;
    }

    if (isBlank(item) && !isBlank(qty)) {
      totalRows++;
      continue;
    }

    if (!isBlank(item)) {
      const value = number(qty);
      if (value == null) {
        unparsed.push({ row: r + 1, reason: 'units on hand is not a number', raw: [item, qty, cat] });
        continue;
      }
      if (currentLocation == null) {
        unparsed.push({ row: r + 1, reason: 'item appeared before any location group', raw: [item, qty, cat] });
        continue;
      }
      rows.push({
        code: text(item),
        location: currentLocation,
        qtyOnHandRaw: value,
        category: text(cat),
      });
      continue;
    }

    unparsed.push({ row: r + 1, reason: 'row did not match any known shape', raw: [item, qty, cat] });
  }

  return {
    rows,
    locations,
    ambiguousGroups,
    reportTitle: title,
    headerRow: headerRow + 1,
    totalRows,
    blankRows,
    diagnostics: {
      sheetName: '',
      reportTitle: title,
      headerRow: headerRow + 1,
      rowsRead: grid.length - headerRow - 1,
      rowsUsed: rows.length,
      totalRowsSkipped: blankRows + totalRows,
      groupRowsSkipped: locations.length,
      unparsed,
    },
  };
}
