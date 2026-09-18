import { describe, expect, it } from 'vitest';
import { parseDate } from '@/core/dates';
import { detectKind, parseExport } from '@/lib/myob/importFile';
import { parseItemListSummary } from '@/lib/myob/itemListSummary';
import { parseSalesItemDetail } from '@/lib/myob/salesItemDetail';
import { banner, workbookBytes } from './support/buildWorkbook';

describe('report detection is by title, never filename', () => {
  it('maps the two known titles', () => {
    expect(detectKind('Sales [Item Detail]')).toBe('salesItemDetail');
    expect(detectKind('Item List [Summary]')).toBe('itemListSummary');
    expect(detectKind('Item Lot Summary')).toBeNull();
    expect(detectKind('')).toBeNull();
  });

  it('reads either report from bytes regardless of file name', () => {
    const jobsBytes = workbookBytes([
      {
        name: 'Sheet1',
        grid: [
          ...banner('Sales [Item Detail]'),
          [null, 'Name', 'ID No.', 'Date', 'Quantity', 'Promised Date', 'Ship Via', 'Salesperson'],
          [null, null],
          [null, 'A3', 'SPECIMEN SQUARE 400x400x30mm', null, null, null, null, null],
          [null, 'BROADSIDE LANDSCAPES', '01999001', '9/09/2026', 3.15, '17/09/2026', 'TAKEN', 'SAMPLE, SAM'],
        ],
      },
    ]);
    // Deliberately mis-named the way the shop's files are.
    expect(parseExport(jobsBytes, 'location.xlsx').kind).toBe('salesItemDetail');

    const stockBytes = workbookBytes([
      {
        name: 'Sheet1',
        grid: [
          ...banner('Item List [Summary]'),
          [null, 'Item No.', 'Units On Hand', 'Custom List #3'],
          [null, null],
          [null, 'HQ', 'HQ', null],
          [null, 'A3', 11861.57, 'PAVERS'],
        ],
      },
    ]);
    expect(parseExport(stockBytes, 'future.xlsx').kind).toBe('itemListSummary');
  });

  it('rejects a workbook that is neither report', () => {
    const bytes = workbookBytes([{ name: 'Sheet1', grid: [[null, 'Some other report'], [1, 2]] }]);
    expect(() => parseExport(bytes, 'mystery.xlsx')).toThrow(/expected a MYOB/);
    expect(() => parseExport(bytes, 'mystery.xlsx')).toThrow(/Item Detail/);
  });
});

describe('sales report classifier', () => {
  const grid = [
    ...banner('Sales [Item Detail]'),
    [null, 'Name', 'ID No.', 'Date', 'Quantity', 'Promised Date', 'Ship Via', 'Salesperson'],
    [null, null],
    // item header
    [null, 'A3', 'SPECIMEN SQUARE 400x400x30mm', null, null, null, null, null],
    [null, 'CUSTOMER ONE', '01999001', '9/09/2026', 10, '17/09/2026', 'COLLECT', 'SAM'],
    [null, 'CUSTOMER TWO', '01999002', '10/09/2026', -4, '18/09/2026', 'COLLECT', 'SAM'],
    // Subtotal label rides in the Date column, rollup qty in Quantity — exactly
    // as the real export does it.
    [null, null, null, 'SPECIMEN SQUARE 400x400x30mm Total:', 6, null, null, null],
    [null, 'B6', 'ANOTHER ITEM 60', null, null, null, null, null],
    [null, 'CUSTOMER ONE', '01356150', '11/09/2026', 7.5, '20/09/2026', 'SHIPPING', 'DARYL'],
  ];

  it('splits headers, lines and subtotals', () => {
    const parsed = parseSalesItemDetail(grid);
    expect(parsed.itemHeaders).toBe(2);
    expect(parsed.subtotalRows).toBe(1);
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.diagnostics.unparsed).toEqual([]);
  });

  it('carries the code and description down to later lines', () => {
    const parsed = parseSalesItemDetail(grid);
    expect(parsed.rows.map((r) => r.itemCode)).toEqual(['A3', 'A3', 'B6']);
    expect(parsed.rows[2]!.itemDescription).toBe('ANOTHER ITEM 60');
  });

  it('keeps credit lines as negative demand', () => {
    const parsed = parseSalesItemDetail(grid);
    expect(parsed.rows[1]!.qty).toBe(-4);
  });

  it('records a line before any item header as unparsed rather than inventing a code', () => {
    const parsed = parseSalesItemDetail([
      ...banner('Sales [Item Detail]'),
      [null, 'Name', 'ID No.', 'Date', 'Quantity', 'Promised Date'],
      [null, 'ORPHAN', '01999001', '9/09/2026', 5, '17/09/2026'],
    ]);
    expect(parsed.rows).toHaveLength(0);
    expect(parsed.diagnostics.unparsed[0]?.reason).toMatch(/before any item header/);
  });

  it('survives ragged rows and unpadded dates', () => {
    const parsed = parseSalesItemDetail([
      ...banner('Sales [Item Detail]'),
      [null, 'Name', 'ID No.', 'Date', 'Quantity', 'Promised Date'],
      [null, 'A3', 'SPECIMEN SQUARE 400x400x30mm'],
      [null, 'X', '01', '5/1/2026', 1, '9/1/2026'],
    ]);
    expect(parsed.rows[0]?.customer).toBe('X');
    // Trailing columns simply absent from a short row.
    expect(parsed.rows[0]?.shipVia).toBe('');
    expect(new Date(parsed.rows[0]!.promisedDate).getMonth()).toBe(0);
    expect(new Date(parsed.rows[0]!.promisedDate).getDate()).toBe(9);
  });

  it('reads the report period from the banner', () => {
    const parsed = parseSalesItemDetail(grid);
    expect(parsed.periodFrom).toBe(parseDate('1/01/2026'));
    expect(parsed.periodTo).toBe(parseDate('17/09/2026'));
  });
});

describe('item list classifier', () => {
  const grid = [
    ...banner('Item List [Summary]'),
    [null, 'Item No.', 'Units On Hand', 'Custom List #3'],
    [null, null],
    [null, 'NORTH', 'NORTH', null],
    [null, 'ROL', 3.05, ''],
    [null, null, 3.05, 'Total:'],
    [null, 'TBN', 'DO NOT USE', null],
    [null, 'XYZ', 12, ''],
    [null, 'HQ', 'HQ', null],
    [null, 'A3', 11861.57, 'PAVERS'],
    // An item whose quantity failed to export, still carrying its category.
    [null, 'BAD', 'n/a', 'PAVERS'],
  ];

  it('detects location groups including description-labelled ones', () => {
    const parsed = parseItemListSummary(grid);
    expect(parsed.locations).toEqual(['NORTH', 'TBN', 'HQ']);
    expect(parsed.rows.map((r) => [r.code, r.location])).toEqual([
      ['ROL', 'NORTH'],
      ['XYZ', 'TBN'],
      ['A3', 'HQ'],
    ]);
  });

  it('flags group headers whose label does not repeat the code', () => {
    const parsed = parseItemListSummary(grid);
    expect(parsed.ambiguousGroups).toEqual(['TBN = DO NOT USE']);
  });

  it('never reborn an unreadable item row as a location', () => {
    const parsed = parseItemListSummary(grid);
    expect(parsed.locations).not.toContain('BAD');
    expect(parsed.diagnostics.unparsed[0]?.raw[0]).toBe('BAD');
  });

  it('skips location subtotals', () => {
    const parsed = parseItemListSummary(grid);
    expect(parsed.totalRows).toBe(1);
  });

  it('stores the raw units on hand without touching the baseline', () => {
    const parsed = parseItemListSummary(grid);
    expect(parsed.rows.find((r) => r.code === 'A3')?.qtyOnHandRaw).toBe(11861.57);
  });
});
