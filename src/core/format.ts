import type { ColumnFormat, ProductUnit } from './types';

const UNITS: Record<string, string> = {
  m2: 'm²',
  lm: 'lm',
  pieces: 'pieces',
};

export function unitLabel(unit: ProductUnit): string {
  return UNITS[unit] ?? unit;
}

/** Thousands separators, fixed decimals. Reads correctly at a glance on a rack label. */
export function formatNumber(value: number | null | undefined, decimals = 2): string {
  if (value == null || !Number.isFinite(value)) return '';
  return value.toLocaleString('en-AU', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function formatQty(value: number | null | undefined, unit?: ProductUnit, decimals = 2): string {
  if (value == null || !Number.isFinite(value)) return '';
  const n = formatNumber(value, decimals);
  // A negative quantity is meaningful here (oversold stock), so keep the sign
  // in front of the number rather than in parentheses.
  return unit ? `${n} ${unitLabel(unit)}` : n;
}

export function formatSigned(value: number, decimals = 2): string {
  if (!Number.isFinite(value)) return '';
  return (value > 0 ? '+' : '') + formatNumber(value, decimals);
}

export function formatPercent(value: number, decimals = 0): string {
  return `${formatNumber(value * 100, decimals)}%`;
}

export function formatCellValue(
  value: unknown,
  format: ColumnFormat = 'text',
  opts: { decimals?: number; unit?: ProductUnit } = {},
): string {
  switch (format) {
    case 'number':
      return formatNumber(typeof value === 'number' ? value : null, opts.decimals ?? 2);
    case 'qty':
      return formatQty(
        typeof value === 'number' ? value : null,
        opts.unit,
        opts.decimals ?? 2,
      );
    case 'date':
      return typeof value === 'number' ? toDateText(value) : String(value ?? '');
    case 'code':
      return String(value ?? '').toUpperCase();
    default:
      return value == null ? '' : String(value);
  }
}

function toDateText(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/**
 * Natural ordering for MYOB codes: `A3 < A6 < AL3 < AL6 < M6`, not the
 * `A3 < AL3 < A6` you get from a plain string compare. Day-to-day this is what
 * makes sorting the product list feel obvious instead of arbitrary.
 */
export function compareNatural(a: string, b: string): number {
  const re = /(\d+|\D+)/g;
  const ax = a.match(re) ?? [];
  const bx = b.match(re) ?? [];
  for (let i = 0; i < Math.max(ax.length, bx.length); i++) {
    const av = ax[i];
    const bv = bx[i];
    if (av === undefined) return -1;
    if (bv === undefined) return 1;
    const an = Number(av);
    const bn = Number(bv);
    const bothNumeric = !Number.isNaN(an) && !Number.isNaN(bn) && /^\d/.test(av) && /^\d/.test(bv);
    if (bothNumeric) {
      if (an !== bn) return an - bn;
    } else if (av !== bv) {
      return av < bv ? -1 : 1;
    }
  }
  return a.length - b.length;
}

/** Tidy float for display and for writing back: never 44.999999996. */
export function round(value: number, decimals = 2): number {
  const f = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * f) / f;
}

/** Trays are whole objects; a part-tray is not something you can cast. */
export function ceilTrays(value: number): number {
  return Math.ceil(round(value, 6));
}

export function parseNumberInput(text: string): number | null {
  const cleaned = text.replace(/[, \s]/g, '').replace(/m²$/i, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}
