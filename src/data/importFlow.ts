import { compareNatural } from '@/core/format';
import type { JobsSnapshot, Product, StockSnapshot } from '@/core/types';
import { blankProduct, collectProductCodes, type ImportResult } from '@/lib/myob/importFile';
import {
  db,
  latestJobsSnapshot,
  latestStockSnapshot,
  replaceJobsSnapshot,
  replaceStockSnapshot,
} from '@/data/db';
import { logEvent } from '@/data/events';
import { assertCan } from '@/data/principal';

export interface ImportCommit {
  kind: 'stock' | 'jobs';
  /** Rows written to the mirrored snapshot tables. */
  rows: number;
  capturedAt: number;
  source: string;
  /** Product codes that did not exist before this import. */
  newCodes: string[];
  /** Existing products whose description followed the export. */
  refreshedDescriptions: number;
  /** Location groups discovered in the stock export. */
  locations: string[];
}

/**
 * Commit one parsed MYOB export, then bring the product list in line with it.
 *
 * Two rules protect the work someone has already done:
 *
 * 1. An import never enables, disables or re-ranks a product. The stock export
 *    carries 2,342 codes while the current range is a few dozen, so which codes
 *    are "ours" is a human decision made in Products — an import that flipped it
 *    on would wreck the matrix every time the export is refreshed.
 * 2. Descriptions follow the export, because that field belongs to MYOB. Nothing
 *    else on an existing product is touched: no unit, no yield, no target.
 */
export async function commitImport(result: ImportResult): Promise<ImportCommit> {
  // An import rewrites the stock mirror and the open job lines, so it is a maker's
  // action — whatever screen the file happened to be dropped onto.
  assertCan('sources.import');
  const now = Date.now();

  if (result.stock) {
    await replaceStockSnapshot({ ...result.stock, capturedAt: now, source: result.fileName });
  } else if (result.jobs) {
    await replaceJobsSnapshot({ ...result.jobs, capturedAt: now, source: result.fileName });
  } else {
    throw new Error('Parsed export carried neither a stock nor a jobs payload');
  }

  // Product identity comes from BOTH mirrors: a code can carry demand with no
  // stock row at all, so the freshly-imported file alone is not enough.
  const [stock, jobs] = await Promise.all([
    result.stock ?? latestStockSnapshot(),
    result.jobs ?? latestJobsSnapshot(),
  ]);

  const commit = await syncProducts(stock, jobs, result, now);
  await logEvent('import.commit', {
    detail: `${commit.kind} import from ${result.fileName}: ${commit.rows} rows, ${commit.newCodes.length} new codes`,
    qty: commit.rows,
  });
  return commit;
}

async function syncProducts(
  stock: StockSnapshot | null,
  jobs: JobsSnapshot | null,
  result: ImportResult,
  now: number,
): Promise<ImportCommit> {
  const codes = collectProductCodes(stock, jobs);

  // Descriptions only exist on the sales export; the stock report has no name column.
  const descriptions = new Map<string, string>();
  const jobCodes = new Set<string>();
  for (const job of jobs?.rows ?? []) {
    jobCodes.add(job.itemCode);
    if (job.itemDescription && !descriptions.has(job.itemCode)) {
      descriptions.set(job.itemCode, job.itemDescription);
    }
  }

  const existing = await db.products.toArray();
  const byCode = new Map(existing.map((p) => [p.code, p]));

  const missing = [...codes].filter((c) => !byCode.has(c)).sort(compareNatural);
  let rank = existing.reduce((max, p) => (p.rank > max ? p.rank : max), 0);
  const added: Product[] = missing.map((code) => {
    rank += 100;
    return {
      ...blankProduct(code, descriptions.get(code) ?? '', rank, now),
      seenInJobs: jobCodes.has(code),
    };
  });
  if (added.length > 0) await db.products.bulkAdd(added);

  let refreshedDescriptions = 0;
  const updates: Product[] = [];
  for (const product of existing) {
    const description = descriptions.get(product.code);
    const seenInJobs = jobCodes.has(product.code);
    const nextDescription = description && description !== product.description ? description : product.description;
    if (nextDescription !== product.description) refreshedDescriptions++;
    if (nextDescription === product.description && seenInJobs === product.seenInJobs) continue;
    updates.push({ ...product, description: nextDescription, seenInJobs, updatedAt: now });
  }
  if (updates.length > 0) await db.products.bulkPut(updates);

  return {
    kind: result.stock ? 'stock' : 'jobs',
    rows: (result.stock?.rows ?? result.jobs?.rows ?? []).length,
    capturedAt: now,
    source: result.fileName,
    newCodes: missing,
    refreshedDescriptions,
    locations: result.locations,
  };
}

/** Every location group the newest stock export mentions, in sheet order. */
export async function discoveredLocations(): Promise<string[]> {
  const snapshot = await latestStockSnapshot();
  if (!snapshot) return [];
  const seen: string[] = [];
  for (const row of snapshot.rows) if (!seen.includes(row.location)) seen.push(row.location);
  return seen.sort(compareNatural);
}
