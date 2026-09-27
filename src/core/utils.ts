import { generateKeyBetween } from 'fractional-indexing';

export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

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

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  const wrapped = (...args: A) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(t);
  wrapped.flush = (...args: A) => {
    clearTimeout(t);
    fn(...args);
  };
  return wrapped;
}

export function relTime(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: ts < Date.now() - 31536000000 ? 'numeric' : undefined });
}

export function formatDate(iso: string): string {
  return new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
