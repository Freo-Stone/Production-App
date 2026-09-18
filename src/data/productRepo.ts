import { needsResequence, rankBetween, resequence } from '@/core/calc';
import { parseNumberInput } from '@/core/format';
import type { Product, ProductRoute } from '@/core/types';
import { db } from '@/data/db';
import { logEvent } from '@/data/events';
import { assertCan } from '@/data/principal';

/**
 * Product settings writes.
 *
 * Which codes are "ours", how they are made and what they are measured in is
 * human knowledge — the MYOB exports carry none of it. So these fields are only
 * ever written from here, and every write is stamped and logged, because a
 * mystery target level two weeks later is not something the shop can debug.
 */

export type ProductPatch = Partial<
  Pick<
    Product,
    | 'enabled'
    | 'route'
    | 'unit'
    | 'usesBaseline10000'
    | 'trayYield'
    | 'target'
    | 'cureDays'
    | 'description'
    | 'notes'
  >
>;

export const ROUTE_LABELS: Record<ProductRoute, string> = {
  unset: 'Not set',
  manufacture: 'Make only',
  shotblast: 'Make + blast',
};

export const UNIT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'm2', label: 'm²' },
  { value: 'lm', label: 'lm' },
  { value: 'pieces', label: 'Pieces' },
];

/** One field edit. Returns the fields that actually changed, for the audit line. */
export async function patchProduct(code: string, patch: ProductPatch): Promise<Product | null> {
  // Gated here, not only in the screen: a disabled input stops the person who forgot,
  // not the person who did not.
  assertCan('products.edit');
  // Read and write inside one transaction. Two edits a moment apart — target then
  // tray yield, say — otherwise both read the same original row and the one that
  // commits second quietly undoes the first.
  return db.transaction('rw', db.products, db.events, async () => {
    const current = await db.products.get(code);
    if (!current) return null;
    const changed = changedFields(current, patch);
    if (Object.keys(changed).length === 0) return current;

    const next: Product = { ...current, ...changed, updatedAt: Date.now() };
    await db.products.put(next);
    await logEvent('product.update', {
      code,
      detail: describeChange(changed),
    });
    return next;
  });
}

/**
 * Same edit on many products. One transaction so a half-applied bulk edit cannot
 * leave some products on the shotblast route and some not.
 */
export async function bulkPatchProducts(
  codes: string[],
  patch: ProductPatch,
): Promise<{ updated: number }> {
  assertCan('products.edit');
  const now = Date.now();
  let updated = 0;
  await db.transaction('rw', db.products, db.events, async () => {
    for (const code of codes) {
      const current = await db.products.get(code);
      if (!current) continue;
      const changed = changedFields(current, patch);
      if (Object.keys(changed).length === 0) continue;
      await db.products.put({ ...current, ...changed, updatedAt: now });
      updated++;
    }
    if (updated > 0) {
      await logEvent('product.update', {
        detail: `${describeChange(patch)} on ${updated} product${updated === 1 ? '' : 's'}`,
        qty: updated,
      });
    }
  });
  return { updated };
}

/* ── Manual row order ──────────────────────────────────────────────────────── */

/**
 * Move a row inside the *current list*, which may be filtered and sorted.
 *
 * Neighbour ranks are read from the neighbours in that list, not from the whole
 * product table: dropping a paver between two others in a filtered view should
 * put it between those two, whatever the hidden rows are doing. Midpoint insert
 * writes one record; when the midpoints run out the visible block is rebalanced.
 *
 * A filtered drop is relative (before/after the row dropped on), so an unrelated
 * rank elsewhere in the table can still land it differently once the filter is
 * cleared. That is the honest trade for not rewriting every rank the list
 * excludes; clearing the filter first gives an absolute position.
 */
export async function moveProductInList(
  draggedCode: string,
  targetIndex: number,
  list: Product[],
): Promise<void> {
  // The order of this list is how the shop reads the board, so it is a maker's edit.
  assertCan('products.edit');
  const from = list.findIndex((p) => p.code === draggedCode);
  if (from < 0 || from === targetIndex) return;

  const order = [...list];
  const [moved] = order.splice(from, 1);
  if (!moved) return;
  order.splice(targetIndex, 0, moved);

  const before = order[targetIndex - 1]?.rank ?? null;
  const after = order[targetIndex + 1]?.rank ?? null;
  let rank = rankBetween(before, after);
  if (before != null && after != null && !(rank > before && rank < after)) {
    // Floats are exhausted in this gap: re-space the whole visible block.
    const ranks = resequence(order.length);
    await db.transaction('rw', db.products, db.events, async () => {
      const stamp = Date.now();
      for (let i = 0; i < order.length; i++) {
        const code = order[i]?.code;
        if (!code) continue;
        const row = await db.products.get(code);
        if (row) await db.products.put({ ...row, rank: ranks[i] ?? 0, updatedAt: stamp });
      }
      await logEvent('rank.change', { detail: `Re-spaced ${order.length} products after a reorder` });
    });
    return;
  }

  // Same reason as patchProduct: the row is read and written together, so a drag
  // landing on top of a typed figure cannot lose either of them.
  await db.transaction('rw', db.products, db.events, async () => {
    const dragged = await db.products.get(draggedCode);
    if (!dragged) return;
    await db.products.put({ ...dragged, rank, updatedAt: Date.now() });
    await logEvent('rank.change', {
      code: draggedCode,
      detail: `Moved to position ${targetIndex + 1}${needsResequence(order.map((p) => p.rank)) ? ' (gap closing)' : ''}`,
    });
  });
}

/* ── Settings round-trip (CSV) ─────────────────────────────────────────────── */

export const CSV_HEADER = 'code,description,enabled,route,unit,baseline10000,trayYield,target,cureDays,notes';

export function productsToCsv(products: Product[]): string {
  const lines = [CSV_HEADER];
  for (const p of products) {
    lines.push(
      [
        p.code,
        p.description,
        p.enabled ? 'yes' : 'no',
        p.route,
        p.unit,
        p.usesBaseline10000 ? 'yes' : 'no',
        String(p.trayYield),
        String(p.target),
        String(p.cureDays),
        p.notes,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}

export interface CsvIssue {
  line: number;
  message: string;
}

export interface CsvProductUpdate {
  code: string;
  patch: ProductPatch;
}

export interface CsvParseResult {
  updates: CsvProductUpdate[];
  issues: CsvIssue[];
}

/**
 * Parse a settings CSV back in.
 *
 * Only columns that are present in the sheet are applied, and for numbers and
 * tick-boxes a blank cell means "leave it alone" — the point of the round trip
 * is that someone can fill in a unit column in a spreadsheet and hand it back.
 * `notes` is the exception: a notes *column* means the text is authoritative, so
 * an empty cell clears the note, which is the only way to clear one from a
 * spreadsheet.
 */
export function parseProductsCsv(text: string): CsvParseResult {
  const rows = splitCsv(text);
  const updates: CsvProductUpdate[] = [];
  const issues: CsvIssue[] = [];
  if (rows.length < 2) {
    return { updates, issues: [{ line: 1, message: 'No rows found below the header' }] };
  }

  const header = rows[0] ?? [];
  const at = new Map(header.map((h, i) => [h.trim().toLowerCase(), i] as const));
  if (!at.has('code')) return { updates, issues: [{ line: 1, message: 'A code column is required' }] };

  const cell = (row: string[], key: string): string => {
    const i = at.get(key);
    return i == null ? '' : (row[i] ?? '').trim();
  };

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const code = cell(row, 'code');
    if (!code) continue;
    const patch: ProductPatch = {};
    const problems: string[] = [];

    const yesNo = (raw: string): boolean | undefined =>
      raw === '' ? undefined : /^(yes|y|true|1|x)$/i.test(raw) ? true : /^(no|n|false|0|-)$/i.test(raw) ? false : undefined;

    const enabled = yesNo(cell(row, 'enabled'));
    if (enabled !== undefined) patch.enabled = enabled;

    const baseline = yesNo(cell(row, 'baseline10000'));
    if (baseline !== undefined) patch.usesBaseline10000 = baseline;

    const route = cell(row, 'route').toLowerCase();
    if (route !== '') {
      const alias: Record<string, ProductRoute> = {
        unset: 'unset',
        '': 'unset',
        'not set': 'unset',
        make: 'manufacture',
        manufacture: 'manufacture',
        'make only': 'manufacture',
        blast: 'shotblast',
        shotblast: 'shotblast',
        'make + blast': 'shotblast',
      };
      const mapped = alias[route];
      if (mapped) patch.route = mapped;
      else problems.push(`unknown route "${route}"`);
    }

    const unit = cell(row, 'unit').toLowerCase();
    if (unit !== '') patch.unit = unit;

    const numberFrom = (key: string, field: 'trayYield' | 'target' | 'cureDays'): void => {
      const raw = cell(row, key);
      if (raw === '') return;
      const n = parseNumberInput(raw);
      if (n == null || n < 0) problems.push(`${key} "${raw}" is not a number at or above zero`);
      else patch[field] = n;
    };
    numberFrom('trayyield', 'trayYield');
    numberFrom('target', 'target');
    numberFrom('curedays', 'cureDays');

    const description = cell(row, 'description');
    if (description !== '') patch.description = description;
    const notesIndex = at.get('notes');
    if (notesIndex != null) patch.notes = cell(row, 'notes');

    if (problems.length > 0) {
      for (const message of problems) issues.push({ line: i + 1, message: `${code}: ${message}` });
    }
    if (Object.keys(patch).length > 0) updates.push({ code, patch });
  }

  return { updates, issues };
}

/**
 * Apply parsed CSV updates to codes that already exist.
 * Codes from the file that this install has never seen are reported and skipped:
 * the product list comes from the MYOB exports, not from a hand-typed CSV.
 */
export async function applyCsvUpdates(
  updates: CsvProductUpdate[],
): Promise<{ updated: number; unknown: string[] }> {
  assertCan('products.edit');
  // Codes are the primary key; reading them keeps the check off the row bodies.
  const known = new Set((await db.products.toArray()).map((p) => p.code));
  const unknown: string[] = [];
  let updated = 0;
  for (const { code, patch } of updates) {
    if (!known.has(code)) {
      unknown.push(code);
      continue;
    }
    const after = await patchProduct(code, patch);
    if (after) updated++;
  }
  return { updated, unknown };
}

/* ── Details ───────────────────────────────────────────────────────────────── */

function changedFields(current: Product, patch: ProductPatch): ProductPatch {
  const out: ProductPatch = {};
  for (const [key, value] of Object.entries(patch) as Array<[keyof ProductPatch, unknown]>) {
    if (value === undefined) continue;
    if (current[key] === value) continue;
    (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

function describeChange(patch: ProductPatch): string {
  const parts: string[] = [];
  if (patch.enabled !== undefined) parts.push(patch.enabled ? 'set current' : 'set not current');
  if (patch.route !== undefined) parts.push(`route → ${ROUTE_LABELS[patch.route]}`);
  if (patch.unit !== undefined) parts.push(`unit → ${patch.unit}`);
  if (patch.usesBaseline10000 !== undefined)
    parts.push(patch.usesBaseline10000 ? 'MYOB baseline on' : 'MYOB baseline off');
  if (patch.trayYield !== undefined) parts.push(`tray yield → ${patch.trayYield}`);
  if (patch.target !== undefined) parts.push(`target → ${patch.target}`);
  if (patch.cureDays !== undefined) parts.push(`cure → ${patch.cureDays}d`);
  if (patch.description !== undefined) parts.push('description');
  if (patch.notes !== undefined) parts.push('notes');
  return parts.join(', ') || 'product updated';
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Quote-aware split: a description containing a comma comes straight back. */
export function splitCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\r') {
      // Swallowed; \n ends the row.
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
