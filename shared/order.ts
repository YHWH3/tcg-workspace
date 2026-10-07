import { generateKeyBetween } from 'fractional-indexing';

export function uuid(): string {
  return crypto.randomUUID();
}

/** Fractional-index order keys sort by ordinal char order (0-9 A-Z a-z), which
 *  localeCompare does NOT reproduce (ICU ranks a < Z). Always sort `order`
 *  fields with this comparator so display order matches generateKeyBetween. */
export function cmpOrder(a: unknown, b: unknown): number {
  const x = String(a ?? '');
  const y = String(b ?? '');
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * generateKeyBetween that survives a malformed key in the data (e.g. an order
 * field written by a buggy client): falls back to a fresh key rather than
 * crashing the render/insert path.
 */
export function orderBetween(a: string | null | undefined, b: string | null | undefined): string {
  try {
    return generateKeyBetween(a ?? null, b ?? null);
  } catch {
    return generateKeyBetween(null, null);
  }
}
