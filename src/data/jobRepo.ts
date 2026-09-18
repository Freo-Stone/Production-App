import { db, getSettings, latestJobsSnapshot, latestStockSnapshot } from '@/data/db';
import type { Batch, JobRow, Product, Settings, StockRow } from '@/core/types';

/**
 * Everything the order book needs, in one read.
 *
 * The board answers "what has been sold that we still owe, and can we point at it",
 * which needs the job export, the shop's own products, the stock export and the
 * racks on the floor — four tables. Reading them one at a time from the screen means
 * four live queries that each resolve at their own moment, and a board that shows
 * today's jobs against last week's stock while they land is worse than a board that
 * waits. One function, one transaction, one consistent snapshot of this device.
 */
export interface JobBoardSource {
  jobs: JobRow[];
  /** When the job export was read, or null when this device has never had one. */
  capturedAt: number | null;
  /** Where the file came from, as the export said. */
  source: string;
  /** The report period printed on the export, if it could be read. */
  periodFrom: number | null;
  periodTo: number | null;
  /** The shop's own products. A written-off product cannot be "ours" any more. */
  products: Product[];
  stockRows: StockRow[];
  stockCapturedAt: number | null;
  /** Racks on the device. Deleted ones are left out: they are tombstones, not work. */
  batches: Batch[];
  settings: Settings;
}

export async function jobBoardSource(): Promise<JobBoardSource> {
  const [jobs, stock, products, batches, settings] = await Promise.all([
    latestJobsSnapshot(),
    latestStockSnapshot(),
    db.products.toArray(),
    db.batches.toArray(),
    getSettings(),
  ]);

  return {
    jobs: jobs?.rows ?? [],
    capturedAt: jobs?.capturedAt ?? null,
    source: jobs?.source ?? '',
    periodFrom: jobs?.periodFrom ?? null,
    periodTo: jobs?.periodTo ?? null,
    products: products.filter((p) => !p.deleted).sort((a, b) => a.rank - b.rank),
    stockRows: stock?.rows ?? [],
    stockCapturedAt: stock?.capturedAt ?? null,
    batches: batches.filter((b) => !b.deleted),
    settings,
  };
}

/**
 * The one product a job line names, or null when the code is not one of ours.
 *
 * Kept beside the source rather than in the screen because both the board rows and
 * the panel that opens under the table have to agree on which codes are ours, and a
 * product filtered out in one place and not the other is how a screen starts
 * disagreeing with itself.
 */
export function productForCode(products: Product[], code: string): Product | null {
  return products.find((p) => p.code === code) ?? null;
}
