import { parseDate } from '@/core/dates';
import { jobId } from '@/core/ids';
import type { JobRow, ParseDiagnostics } from '@/core/types';
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
 * Parser for the MYOB **`Sales [Item Detail]`** export — the future-jobs file.
 *
 * The report is *nested*, which is the part that breaks naive readers:
 *
 *   row 12  B=`A3`  C=`SPECIMEN SQUARE 400x400x30mm`      <- item header (no Date/Qty)
 *   row 13  B=`BROADSIDE LANDSCAPES` C=`01999001` D=`9/09/2026` E=3.15 F=`17/09/2026` …
 *   ...       (one line per sales order for that item)
 *   row 36  C is blank, D=`SPECIMEN SQUARE 400x400x30mm Total:` E=383.79  <- subtotal
 *
 * So the item code has to be carried DOWN onto every line until the next item
 * header, and subtotals must be excluded — they are per-item rollups, not demand.
 * Verified against the shop's own export: every item header became a group of job
 * lines, the subtotals were left out, and the line count matched the sheet's own.
 *
 * Note the file named `future.xlsx` is this report while `location.xlsx` is the
 * stock list — the names are the opposite way round, so detection is done from
 * the report title, never the filename.
 */
export const SALES_REQUIRED_HEADERS = ['Name', 'ID No.', 'Date', 'Quantity', 'Promised Date'];

export interface SalesParseResult {
  rows: JobRow[];
  reportTitle: string;
  headerRow: number;
  periodFrom: number | null;
  periodTo: number | null;
  itemHeaders: number;
  subtotalRows: number;
  blankRows: number;
  diagnostics: ParseDiagnostics;
}

export function parseSalesItemDetail(grid: Grid): SalesParseResult {
  const title = reportTitle(grid);
  const headerRow = findHeaderRow(grid, SALES_REQUIRED_HEADERS);
  if (headerRow == null) {
    throw new Error(
      `Not a Sales [Item Detail] report: could not find a header row containing ${SALES_REQUIRED_HEADERS.join(', ')}`,
    );
  }

  const col = {
    name: columnIndex(grid, headerRow, 'Name') ?? 1,
    idNo: columnIndex(grid, headerRow, 'ID No.') ?? 2,
    date: columnIndex(grid, headerRow, 'Date') ?? 3,
    qty: columnIndex(grid, headerRow, 'Quantity') ?? 4,
    promised: columnIndex(grid, headerRow, 'Promised Date') ?? 5,
    shipVia: columnIndex(grid, headerRow, 'Ship Via') ?? 6,
    salesperson: columnIndex(grid, headerRow, 'Salesperson') ?? 7,
  };

  const period = readPeriod(grid, headerRow);
  const rows: JobRow[] = [];
  const unparsed: ParseDiagnostics['unparsed'] = [];
  let itemHeaders = 0;
  let subtotalRows = 0;
  let blankRows = 0;
  let current: { code: string; description: string } | null = null;

  for (let r = headerRow + 1; r < grid.length; r++) {
    const name = cell(grid, r, col.name);
    const idNo = cell(grid, r, col.idNo);
    const orderDate = cell(grid, r, col.date);
    const qtyCell = cell(grid, r, col.qty);
    const promisedCell = cell(grid, r, col.promised);

    if (
      isBlank(name) && isBlank(idNo) && isBlank(orderDate) && isBlank(qtyCell) &&
      isBlank(promisedCell) && isBlank(cell(grid, r, col.shipVia)) && isBlank(cell(grid, r, col.salesperson))
    ) {
      blankRows++;
      continue;
    }

    // Per-item subtotal: the label rides in the Date column next to the rollup qty.
    if (isBlank(name) && isBlank(idNo) && typeof orderDate === 'string' && orderDate.includes('Total:')) {
      subtotalRows++;
      continue;
    }

    // Item header: code + description, with the order-line columns empty.
    if (!isBlank(name) && !isBlank(idNo) && typeof idNo === 'string' && isBlank(orderDate) && isBlank(qtyCell)) {
      current = { code: text(name), description: text(idNo) };
      itemHeaders++;
      continue;
    }

    if (!isBlank(name) && !isBlank(idNo) && !isBlank(qtyCell)) {
      const qty = number(qtyCell);
      const promised = parseDate(promisedCell);
      if (current == null) {
        unparsed.push({ row: r + 1, reason: 'order line appeared before any item header', raw: [name, idNo, orderDate, qtyCell, promisedCell] });
        continue;
      }
      if (qty == null) {
        unparsed.push({ row: r + 1, reason: 'quantity is not a number', raw: [name, idNo, orderDate, qtyCell, promisedCell] });
        continue;
      }
      if (promised == null) {
        unparsed.push({ row: r + 1, reason: 'promised date could not be read', raw: [name, idNo, orderDate, qtyCell, promisedCell] });
        continue;
      }
      rows.push({
        id: jobId(current.code, text(idNo), r + 1),
        itemCode: current.code,
        itemDescription: current.description,
        customer: text(name),
        orderNo: text(idNo),
        orderDate: parseDate(orderDate),
        promisedDate: promised,
        // Negative quantities are genuine credits and must survive the parse.
        qty,
        shipVia: text(cell(grid, r, col.shipVia)),
        salesperson: text(cell(grid, r, col.salesperson)),
        rank: rows.length,
      });
      continue;
    }

    unparsed.push({ row: r + 1, reason: 'row did not match any known shape', raw: [name, idNo, orderDate, qtyCell, promisedCell] });
  }

  return {
    rows,
    reportTitle: title,
    headerRow: headerRow + 1,
    periodFrom: period.from,
    periodTo: period.to,
    itemHeaders,
    subtotalRows,
    blankRows,
    diagnostics: {
      sheetName: '',
      reportTitle: title,
      headerRow: headerRow + 1,
      rowsRead: grid.length - headerRow - 1,
      rowsUsed: rows.length,
      totalRowsSkipped: blankRows + subtotalRows,
      groupRowsSkipped: itemHeaders,
      unparsed,
    },
  };
}

/** The banner above the header reads `1/01/2026 To 17/09/2026`. */
function readPeriod(grid: Grid, headerRow: number): { from: number | null; to: number | null } {
  for (let r = 0; r < headerRow; r++) {
    for (const c of grid[r] ?? []) {
      const t = text(c);
      const m = /^(.+?)\s+To\s+(.+)$/i.exec(t);
      if (!m) continue;
      const from = parseDate(m[1]);
      const to = parseDate(m[2]);
      if (from != null || to != null) return { from, to };
    }
  }
  return { from: null, to: null };
}
