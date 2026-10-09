/* Calendar/timeline planners (Phase 2 §8): bucket records by their configured
 * date field and build sorted timeline bars. Pure; every date is a 'yyyy-mm-dd'
 * string handled via shared/dates (UTC-midnight rules — never local time). */

import { cmpDateOnly, parseDateOnly, toDateOnly } from './dates';
import {
  applyView,
  fieldValue,
  resolveDateKey,
  type FieldKey,
  type ViewConfig,
  type ViewCtx,
  type ViewRecord,
} from './views';

export interface TimelineBar {
  id: string;
  /** 'yyyy-mm-dd' inclusive start. */
  start: string;
  /** 'yyyy-mm-dd' inclusive end — never before start; a record with no endDateKey spans one day. */
  end: string;
  record: ViewRecord;
}

/** Normalized 'yyyy-mm-dd' stored in the record's configured date field, else null. */
function dateAt(row: ViewRecord, key: FieldKey, ctx: ViewCtx): string | null {
  const v = fieldValue(row, key, ctx);
  if (typeof v !== 'string') return null;
  const p = parseDateOnly(v);
  return p ? toDateOnly(p) : null;
}

/**
 * Day → records map for the month-grid/agenda calendar. `cfg` is a full
 * ViewConfig: its filters/sorts apply before bucketing. Records without a
 * valid date in `dateKey` are omitted — they're `unscheduled()`.
 */
export function recordsForCalendar(
  rows: readonly ViewRecord[],
  cfg: ViewConfig = {},
  ctx: ViewCtx = {},
): Map<string, ViewRecord[]> {
  const { rows: filtered } = applyView(rows, cfg, ctx);
  const key = resolveDateKey(cfg);
  const out = new Map<string, ViewRecord[]>();
  for (const r of filtered) {
    const d = dateAt(r, key, ctx);
    if (!d) continue;
    const list = out.get(d) ?? [];
    list.push(r);
    out.set(d, list);
  }
  return out;
}

/** Records with no valid date in `dateKey` — the calendar's unscheduled tray. */
export function unscheduled(
  rows: readonly ViewRecord[],
  cfg: ViewConfig = {},
  ctx: ViewCtx = {},
): ViewRecord[] {
  const { rows: filtered } = applyView(rows, cfg, ctx);
  const key = resolveDateKey(cfg);
  return filtered.filter((r) => dateAt(r, key, ctx) === null);
}

/**
 * Sorted timeline bars: start = dateKey, end = endDateKey (default: same day —
 * a 1-day bar). An end before start clamps to the start day. Sort order is
 * start, then end, then id — deterministic.
 */
export function timelineBars(
  rows: readonly ViewRecord[],
  cfg: ViewConfig = {},
  ctx: ViewCtx = {},
): TimelineBar[] {
  const { rows: filtered } = applyView(rows, cfg, ctx);
  const startKey = resolveDateKey(cfg);
  const endKey = cfg.endDateKey ?? null;
  const bars: TimelineBar[] = [];
  for (const r of filtered) {
    const start = dateAt(r, startKey, ctx);
    if (!start) continue;
    const end = endKey ? dateAt(r, endKey, ctx) : null;
    const clamped = end !== null && cmpDateOnly(end, start) >= 0 ? end : start;
    bars.push({ id: typeof r.id === 'string' ? r.id : String(r.id ?? ''), start, end: clamped, record: r });
  }
  bars.sort(
    (a, b) =>
      cmpDateOnly(a.start, b.start) ||
      cmpDateOnly(a.end, b.end) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return bars;
}

/**
 * Dependency conflicts: `links(kind='blocks')` edges from→to — returns the ids
 * of bars (the `to` side) whose start is before their blocker's end.
 */
export function timelineConflicts(
  bars: readonly TimelineBar[],
  edges: readonly { from: string; to: string }[],
): Set<string> {
  const byId = new Map(bars.map((b) => [b.id, b] as const));
  const out = new Set<string>();
  for (const e of edges) {
    const blocker = byId.get(e.from);
    const blocked = byId.get(e.to);
    if (blocker && blocked && cmpDateOnly(blocked.start, blocker.end) < 0) out.add(blocked.id);
  }
  return out;
}
