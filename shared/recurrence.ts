// Phase 4 — recurrence + deadline helpers. Pure, unit-tested.
// Dates are yyyy-mm-dd strings; all math is on calendar days in UTC fields,
// never on client-locale midnight (a client timezone must not shift a stored
// due date).

export interface Recurrence {
  freq: 'daily' | 'weekly' | 'monthly';
  interval: number;
  /** 0=Sun..6=Sat; weekly only. Empty/undefined = same weekday as `after`. */
  byWeekday?: number[];
  /** yyyy-mm-dd; no occurrences after this date. */
  until?: string;
}

function parse(d: string): { y: number; m: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return null;
  return { y: +m[1], m: +m[2], day: +m[3] };
}

function fmt(y: number, m: number, d: number): string {
  return `${y.toString().padStart(4, '0')}-${m.toString().padStart(2, '0')}-${d.toString().padStart(2, '0')}`;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function toUtc(d: string): number {
  const p = parse(d);
  return p ? Date.UTC(p.y, p.m - 1, p.day) : NaN;
}

function fromUtc(t: number): string {
  const d = new Date(t);
  return fmt(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** Next occurrence date strictly after `after` (yyyy-mm-dd), or null when the
 * recurrence is exhausted (past `until`) or inputs are invalid. Monthly clamps
 * to the last day of the landing month (Jan 31 → Feb 28 → Mar 28 stays 28 —
 * clamped day becomes the new schedule day). */
export function nextDate(r: Recurrence, after: string): string | null {
  if (!r || !r.freq || !Number.isFinite(r.interval) || r.interval < 1) return null;
  const base = parse(after);
  if (!base) return null;
  let next: string | null = null;
  const step = Math.max(1, Math.floor(r.interval));
  if (r.freq === 'daily') {
    next = fromUtc(toUtc(after) + step * 86400000);
  } else if (r.freq === 'weekly') {
    if (r.byWeekday && r.byWeekday.length) {
      const wanted = [...new Set(r.byWeekday.filter((d) => d >= 0 && d <= 6))].sort();
      if (!wanted.length) return null;
      // Next allowed week = `step` weeks after the Sunday-start week
      // containing `after`; earliest wanted weekday in that week.
      const baseUtc = toUtc(after);
      const weekStart = baseUtc - new Date(baseUtc).getUTCDay() * 86400000;
      const targetWeek = weekStart + step * 7 * 86400000;
      const cands = wanted.map((wd) => targetWeek + wd * 86400000).sort((a, b) => a - b);
      next = fromUtc(cands[0]);
    } else {
      next = fromUtc(toUtc(after) + step * 7 * 86400000);
    }
  } else if (r.freq === 'monthly') {
    let y = base.y;
    let m = base.m + step;
    while (m > 12) {
      m -= 12;
      y++;
    }
    next = fmt(y, m, Math.min(base.day, daysInMonth(y, m)));
  }
  if (!next) return null;
  if (r.until && next > r.until) return null;
  return next;
}

/** Board-semantic "done": the last column id of the record's board. */
export function isDone(columns: { id: string }[] | undefined, status: unknown): boolean {
  if (!columns || !columns.length || typeof status !== 'string') return false;
  return columns[columns.length - 1].id === status;
}

/** Today in UTC as yyyy-mm-dd — the canonical reminder boundary. */
export function todayUtc(now = Date.now()): string {
  return fromUtc(now);
}

export function addDays(date: string, days: number): string {
  return fromUtc(toUtc(date) + days * 86400000);
}
