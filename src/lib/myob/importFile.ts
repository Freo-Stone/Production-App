import { uid } from '@/core/ids';
import type { JobsSnapshot, Product, StockSnapshot } from '@/core/types';
import { type ItemParseResult, parseItemListSummary } from './itemListSummary';
import { parseSalesItemDetail, type SalesParseResult } from './salesItemDetail';
import { readWorkbook, reportTitle, type Sheet } from './workbook';

export type ReportKind = 'salesItemDetail' | 'itemListSummary';

/**
 * Detection is by report title, never by filename: the shop's `future.xlsx` is
 * the *stock-shaped* name on the jobs report and vice versa, so a filename rule
 * would silently import the wrong data.
 */
export function detectKind(title: string): ReportKind | null {
  const t = title.toLowerCase();
  if (t.includes('[item detail]') && t.includes('sales')) return 'salesItemDetail';
  if (t.includes('item list') && t.includes('[summary]')) return 'itemListSummary';
  return null;
}

export interface ImportResult {
  kind: ReportKind;
  sheetName: string;
  reportTitle: string;
  fileName: string;
  capturedAt: number;
  stock?: StockSnapshot;
  jobs?: JobsSnapshot;
  /** Location groups discovered in the stock export. */
  locations: string[];
  sales?: SalesParseResult;
  items?: ItemParseResult;
}

/** Parse either MYOB export from raw bytes. */
export function parseExport(bytes: ArrayBuffer | Uint8Array, fileName: string): ImportResult {
  const sheets = readWorkbook(bytes);
  if (sheets.length === 0) throw new Error(`${fileName}: workbook contains no sheets`);

  // A report can live on a sheet other than the first after a manual re-save.
  for (const sheet of sheets) {
    const kind = detectKind(reportTitle(sheet.grid));
    if (kind == null) continue;
    return kind === 'salesItemDetail'
      ? fromSales(sheet, fileName)
      : fromItems(sheet, fileName);
  }

  throw new Error(
    `${fileName}: expected a MYOB "Sales [Item Detail]" or "Item List [Summary]" report. ` +
      `Open the file and confirm which report was exported.`,
  );
}

function fromSales(sheet: Sheet, fileName: string): ImportResult {
  const parsed = parseSalesItemDetail(sheet.grid);
  const capturedAt = Date.now();
  return {
    kind: 'salesItemDetail',
    sheetName: sheet.name,
    reportTitle: parsed.reportTitle,
    fileName,
    capturedAt,
    locations: [],
    sales: parsed,
    jobs: {
      id: uid('jobs'),
      capturedAt,
      source: fileName,
      periodFrom: parsed.periodFrom,
      periodTo: parsed.periodTo,
      rows: parsed.rows,
      diagnostics: { ...parsed.diagnostics, sheetName: sheet.name },
    },
  };
}

function fromItems(sheet: Sheet, fileName: string): ImportResult {
  const parsed = parseItemListSummary(sheet.grid);
  const capturedAt = Date.now();
  return {
    kind: 'itemListSummary',
    sheetName: sheet.name,
    reportTitle: parsed.reportTitle,
    fileName,
    capturedAt,
    locations: parsed.locations,
    items: parsed,
    stock: {
      id: uid('stock'),
      capturedAt,
      source: fileName,
      rows: parsed.rows,
      diagnostics: { ...parsed.diagnostics, sheetName: sheet.name },
    },
  };
}

/**
 * Codes worth offering as products. The union matters: a code can carry real
 * demand while having no stock row at all, and the reverse is also true — the
 * stock list holds 2,342 codes of which only ~83 have live demand, which is
 * exactly why the product list is opt-in.
 */
export function collectProductCodes(stock: StockSnapshot | null, jobs: JobsSnapshot | null): Set<string> {
  const codes = new Set<string>();
  for (const r of stock?.rows ?? []) codes.add(r.code);
  for (const j of jobs?.rows ?? []) codes.add(j.itemCode);
  return codes;
}

/** Description and category are taken from whichever export has them. */
export function describeCode(
  code: string,
  stock: StockSnapshot | null,
  jobs: JobsSnapshot | null,
): { description: string; category: string } {
  const job = jobs?.rows.find((j) => j.itemCode === code);
  if (job?.itemDescription) return { description: job.itemDescription, category: '' };
  const row = stock?.rows.find((r) => r.code === code);
  return { description: '', category: row?.category ?? '' };
}

/** Blank product with safe defaults: nothing enabled, no route, no baseline. */
export function blankProduct(code: string, description: string, rank: number, now = Date.now()): Product {
  return {
    code,
    description,
    enabled: false,
    route: 'unset',
    usesBaseline10000: false,
    unit: 'm2',
    trayYield: 1,
    target: 0,
    cureDays: 2,
    notes: '',
    rank,
    seenInJobs: false,
    updatedAt: now,
  };
}
