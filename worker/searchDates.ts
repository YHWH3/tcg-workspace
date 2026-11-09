import { addDays, dateOnlyStartInZone, resolveDateBound } from '../shared/dates';

export interface SearchDateInput {
  updatedFrom?: unknown;
  updatedTo?: unknown;
  createdFrom?: unknown;
  createdTo?: unknown;
}

export interface SearchDateBounds {
  updatedFrom?: number;
  updatedTo?: number;
  createdFrom?: number;
  createdTo?: number;
}

/** A date-only end bound includes the whole requested calendar day. */
function bound(value: unknown, today: string, timeZone: string, end: boolean): number | null {
  const resolved = resolveDateBound(value, today);
  if (!resolved) return null;
  const start = dateOnlyStartInZone(end ? (addDays(resolved, 1) ?? resolved) : resolved, timeZone);
  return start === null ? null : end ? start - 1 : start;
}

/** Resolve HTTP/MCP date spellings once at the request boundary. The search
 * service receives epoch bounds only, which keeps SQL and cursor fingerprints
 * deterministic and prevents a client from supplying SQL-like date syntax. */
export function parseSearchDateBounds(input: SearchDateInput, today: string, timeZone: string): SearchDateBounds | null {
  const values: SearchDateBounds = {};
  for (const [key, value] of Object.entries(input) as [keyof SearchDateBounds, unknown][]) {
    if (value === undefined || value === null || value === '') continue;
    const isEnd = key.endsWith('To');
    const resolved = bound(value, today, timeZone, isEnd);
    if (resolved === null) return null;
    values[key] = resolved;
  }
  const pairs: [keyof SearchDateBounds, keyof SearchDateBounds][] = [['updatedFrom', 'updatedTo'], ['createdFrom', 'createdTo']];
  for (const [from, to] of pairs) {
    if (values[from] !== undefined && values[to] !== undefined && values[from]! > values[to]!) return null;
  }
  return values;
}

export function hasSearchDateBounds(bounds: SearchDateBounds): boolean {
  return Object.keys(bounds).length > 0;
}
