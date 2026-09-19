/**
 * The current range — the one rule that answers "does the shop make this code?".
 *
 * The stock export arrives with a couple of thousand codes (2,367 at the time of
 * writing) and the vast majority of them are freight, pallets, bought-in pavers and
 * things last pressed in the previous decade. Which of them the shop actually makes
 * is not in MYOB anywhere: it is the tick on the Products screen, stored on the
 * product record as `enabled`. So `enabled` is the tick, and the shop's word for it
 * is "current" — the two spellings are why this file exists. Reading `p.enabled`
 * directly works, and that is exactly the problem: five screens each writing their
 * own version of the question is how five screens end up with five different
 * numbers for the same shop.
 *
 * **The rule, and its boundary.** A code is in the current range when it exists on
 * this device, has not been written off, and the tick is on. Everything that answers
 * *what we plan to make* asks this question — the Matrix, the making plan, the Daily
 * entry picker. Everything that answers *what has already been sold or already been
 * made* must not: an order line is money the shop owes somebody whether or not the
 * code is ticked today, and a rack that came off the press is a fact about last
 * Tuesday. Those screens stay whole and mark the exception instead of hiding it —
 * see `core/jobsBoard.ts`, where the order book's existing "not one of ours" rule was
 * extended rather than a second one added beside it.
 *
 * The deleted check is part of the predicate and not an extra courtesy: a tombstone
 * is not a product, and a screen that filtered on `enabled` alone would plan a make
 * for a code somebody wrote off.
 */
import type { Product } from '@/core/types';

/**
 * Is this code a product the shop makes? The single source of the answer.
 *
 * Accepts `null`/`undefined` so a lookup that missed can be asked directly: a code
 * this device has never seen is not in the range either, and callers should not have
 * to remember which of the two ways it can fail they are holding.
 */
export function isCurrentProduct(product: Product | null | undefined): boolean {
  return product != null && product.deleted !== true && product.enabled === true;
}

/**
 * The current range, in the order it was handed over.
 *
 * The order is kept rather than re-sorted: a screen whose rows are the Products
 * screen's rank order must keep matching it, and a filter that reordered the list
 * would make a drag on Products move rows somewhere other than the neighbour it was
 * dropped beside.
 */
export function currentProducts<T extends Product>(products: readonly T[]): T[] {
  return products.filter((p) => isCurrentProduct(p));
}

/**
 * The codes in the current range, for a screen that only holds code strings.
 *
 * The order book and the plan work off export rows that name an item by code, so they
 * ask the question a few hundred times per pass. A `Set` built once says no to all of
 * them in the same lookup, and keeps 414 order lines times 2,367 products from turning
 * into a pause on a tablet.
 */
export function currentCodeSet(products: readonly Product[]): Set<string> {
  const out = new Set<string>();
  for (const p of products) if (isCurrentProduct(p)) out.add(p.code);
  return out;
}
