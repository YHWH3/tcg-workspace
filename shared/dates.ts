/* Date-only helpers (Phase 2 §1.2, §8): calendar/timeline views bucket and
 * compare 'yyyy-mm-dd' strings. Every computation happens at UTC midnight —
 * never `new Date(str)` (local-midnight parsing shifts the day for users west
 * of UTC) — so a stored date means the same calendar day in every timezone. */

export interface DateOnly {
  y: number;
  m: number; // 1–12
  d: number; // 1–31
}

/** 0 = Sunday … 6 = Saturday, matching Date#getUTCDay. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** Days in a 1-based month. `setUTCFullYear` avoids the Date.UTC year 0–99 → 1900s quirk. */
export function daysInMonth(y: number, m: number): number {
  const t = new Date(0);
  t.setUTCFullYear(y, m, 0);
  return t.getUTCDate();
}

/** Strict 'yyyy-mm-dd' parse — every other shape (incl. real-looking ISO variants) is rejected. */
export function parseDateOnly(str: unknown): DateOnly | null {
  if (typeof str !== 'string') return null;
  const m = DATE_ONLY_RE.exec(str);
  if (!m || m[0] !== str) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  return { y, m: mo, d };
}

export function toDateOnly(d: DateOnly): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.y, 4)}-${p(d.m)}-${p(d.d)}`;
}

function toMs(d: DateOnly): number {
  const t = new Date(0);
  t.setUTCFullYear(d.y, d.m - 1, d.d);
  t.setUTCHours(0, 0, 0, 0);
  return t.getTime();
}

function fromMs(ms: number): DateOnly {
  const t = new Date(ms);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** Add n days to a date-only value. Returns null when the input isn't a valid 'yyyy-mm-dd'. */
export function addDays(date: string | DateOnly, n: number): string | null {
  const d = typeof date === 'string' ? parseDateOnly(date) : date;
  if (!d || !Number.isFinite(n)) return null;
  return toDateOnly(fromMs(toMs(d) + Math.round(n) * DAY_MS));
}

/** Resolve a bounded relative day using the caller's explicit calendar context. */
export function resolveRelativeDate(value: unknown, today: string | undefined): unknown {
  if (!parseDateOnly(today) || typeof value !== 'string') return value;
  if (value === 'today') return today;
  const match = /^today([+-])(\d+)$/.exec(value);
  if (!match || match[0] !== value || Number(match[2]) > 3650) return value;
  const result = addDays(today!, Number(match[2]) * (match[1] === '-' ? -1 : 1));
  return parseDateOnly(result) ? result : value;
}

/** A date-like spelling, used only in date filter/condition validation. */
export function relativeDateError(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\s*today(?:$|[^a-z])/i.test(value)) return null;
  if (value === 'today') return null;
  const match = /^today[+-](\d+)$/.exec(value);
  return match && match[0] === value && Number(match[1]) <= 3650 ? null : 'Use today, today+N or today-N, with N from 0 to 3650 and no spaces.';
}

/** A stored date bound is an absolute calendar date or a bounded relative day. */
export function isDateBound(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (parseDateOnly(value) || value === 'today') return true;
  const match = /^today[+-](\d+)$/.exec(value);
  return !!match && match[0] === value && Number(match[1]) <= 3650;
}

export function resolveDateBound(value: unknown, today?: string): string | null {
  if (!isDateBound(value)) return null;
  const resolved = resolveRelativeDate(value, today);
  return parseDateOnly(resolved) ? resolved as string : null;
}

/** Convert an instant only where a date filter needs it; stored/sorted ms stay numeric. */
export function toDateOnlyInZone(ms: number, timeZone = 'UTC'): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {timeZone, calendar:'gregory', numberingSystem:'latn', era:'short', year:'numeric', month:'2-digit', day:'2-digit'}).formatToParts(ms);
    const part = (type: string) => parts.find(p => p.type === type)?.value ?? '';
    const year = part('era') === 'BC' ? 1 - Number(part('year')) : Number(part('year'));
    if (year < 0 || year > 9999) return null;
    const date = `${String(year).padStart(4,'0')}-${part('month')}-${part('day')}`;
    return parseDateOnly(date) ? date : null;
  } catch { return null; }
}

/** Whole days from a to b (b − a). Null when either input is invalid. */
export function daysBetween(a: string, b: string): number | null {
  const pa = parseDateOnly(a);
  const pb = parseDateOnly(b);
  if (!pa || !pb) return null;
  return Math.round((toMs(pb) - toMs(pa)) / DAY_MS);
}

/** <0 a<b, 0 equal, >0 a>b. Invalid/missing values sort after valid ones. */
export function cmpDateOnly(a: string | DateOnly | null | undefined, b: string | DateOnly | null | undefined): number {
  const da = typeof a === 'string' ? parseDateOnly(a) : a ?? null;
  const db = typeof b === 'string' ? parseDateOnly(b) : b ?? null;
  if (!da && !db) return 0;
  if (!da) return 1;
  if (!db) return -1;
  const diff = toMs(da) - toMs(db);
  return diff < 0 ? -1 : diff > 0 ? 1 : 0;
}

/** First day of the week containing `date` (weekStart defaults to Monday). */
export function startOfWeek(date: string | DateOnly, weekStart: Weekday = 1): string | null {
  const d = typeof date === 'string' ? parseDateOnly(date) : date;
  if (!d) return null;
  const dow = new Date(toMs(d)).getUTCDay();
  const back = (dow - weekStart + 7) % 7;
  return addDays(toDateOnly(d), -back);
}

export interface DateCell {
  date: string;   // 'yyyy-mm-dd'
  inMonth: boolean;
}

/**
 * Cells of the month grid, weekStart-based (default Monday): runs from the
 * week containing the 1st through the week containing the last day.
 */
export function monthGrid(year: number, month: number, weekStart: Weekday = 1): DateCell[] {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return [];
  const first = startOfWeek({ y: year, m: month, d: 1 }, weekStart);
  const lastWeekStart = startOfWeek({ y: year, m: month, d: daysInMonth(year, month) }, weekStart);
  if (!first || !lastWeekStart) return [];
  const end = addDays(lastWeekStart, 6);
  if (!end) return [];
  const cells: DateCell[] = [];
  for (let d = first; cmpDateOnly(d, end) <= 0; d = addDays(d, 1)!) {
    const p = parseDateOnly(d)!;
    cells.push({ date: d, inMonth: p.y === year && p.m === month });
  }
  return cells;
}

export interface ScaleRange {
  start: string;          // 'yyyy-mm-dd', inclusive
  end: string;            // 'yyyy-mm-dd', inclusive
  ticks: string[];        // week → each day, month → week starts, quarter → month starts
}

/**
 * Tick range for a timeline scale anchored on a date. Week ticks are days,
 * month ticks are the Monday-aligned week starts covering the month, quarter
 * ticks are the first of each of its three months.
 */
export function scaleRange(scale: 'week' | 'month' | 'quarter', anchor: string | DateOnly, weekStart: Weekday = 1): ScaleRange | null {
  const a = typeof anchor === 'string' ? parseDateOnly(anchor) : anchor;
  if (!a) return null;
  if (scale === 'week') {
    const start = startOfWeek(a, weekStart)!;
    const end = addDays(start, 6)!;
    const ticks = Array.from({ length: 7 }, (_, i) => addDays(start, i)!);
    return { start, end, ticks };
  }
  if (scale === 'month') {
    const start = toDateOnly({ y: a.y, m: a.m, d: 1 });
    const end = toDateOnly({ y: a.y, m: a.m, d: daysInMonth(a.y, a.m) });
    const ticks: string[] = [];
    for (let t = startOfWeek(start, weekStart)!; cmpDateOnly(t, end) <= 0; t = addDays(t, 7)!) ticks.push(t);
    return { start, end, ticks };
  }
  const q0 = Math.floor((a.m - 1) / 3) * 3 + 1;
  const start = toDateOnly({ y: a.y, m: q0, d: 1 });
  const end = toDateOnly({ y: a.y, m: q0 + 2, d: daysInMonth(a.y, q0 + 2) });
  const ticks = [0, 1, 2].map((i) => toDateOnly({ y: a.y, m: q0 + i, d: 1 }));
  return { start, end, ticks };
}

/** ISO-8601 week-numbering year and week (week 1 contains the year's first Thursday). */
export function isoWeek(date: string | DateOnly): { year: number; week: number } | null {
  const d = typeof date === 'string' ? parseDateOnly(date) : date;
  if (!d) return null;
  const dow = new Date(toMs(d)).getUTCDay() || 7; // Sunday → 7
  const thursday = fromMs(toMs(d) + (4 - dow) * DAY_MS);
  const yearStart: DateOnly = { y: thursday.y, m: 1, d: 1 };
  const week = Math.floor((toMs(thursday) - toMs(yearStart)) / (7 * DAY_MS)) + 1;
  return { year: thursday.y, week };
}

/** The workspace's civil date; throws instead of inventing a date for bad input. */
export function workspaceToday(now:number,timeZone:string):string {
 const result=toDateOnlyInZone(now,timeZone);
 if(!result)throw new RangeError('Invalid workspace date or timezone');
 return result;
}
