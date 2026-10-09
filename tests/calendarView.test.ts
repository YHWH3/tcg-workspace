import { describe, expect, it } from 'vitest';
import {
  recordsForCalendar,
  timelineBars,
  timelineConflicts,
  unscheduled,
  type TimelineBar,
} from '../shared/calendarView';
import type { ViewRecord } from '../shared/views';

const rec = (id: string, data: Record<string, unknown> = {}): ViewRecord => ({ id, ...data });

const rows = [
  rec('a', { dueDate: '2026-10-05', title: 'A' }),
  rec('b', { dueDate: '2026-10-05', title: 'B' }),
  rec('c', { dueDate: '2026-10-20', title: 'C' }),
  rec('d', { title: 'no date' }),
  rec('e', { dueDate: 'garbage', title: 'bad date' }),
  rec('gone', { dueDate: '2026-10-05', deleted: true }),
];

describe('recordsForCalendar', () => {
  it('buckets records by dueDate', () => {
    const m = recordsForCalendar(rows);
    expect(m.get('2026-10-05')?.map((r) => r.id)).toEqual(['a', 'b']);
    expect(m.get('2026-10-20')?.map((r) => r.id)).toEqual(['c']);
    expect(m.size).toBe(2); // deleted + missing + invalid all skipped
  });

  it('honors a p_ dateKey', () => {
    const rs = [
      rec('x', { p_deadline: '2026-11-02', dueDate: '2026-10-01' }),
      rec('y', { dueDate: '2026-10-03' }),
    ];
    const m = recordsForCalendar(rs, { dateKey: 'p_deadline' });
    expect([...m.keys()]).toEqual(['2026-11-02']);
  });

  it('applies view filters before bucketing', () => {
    const m = recordsForCalendar(rows, { filters: [{ key: 'title', op: 'is', value: 'A' }] });
    expect(m.get('2026-10-05')?.map((r) => r.id)).toEqual(['a']);
  });
});

describe('unscheduled', () => {
  it('returns rows without a valid date', () => {
    expect(unscheduled(rows).map((r) => r.id)).toEqual(['d', 'e']);
  });
  it('respects filters too', () => {
    expect(unscheduled(rows, { filters: [{ key: 'title', op: 'is', value: 'no date' }] }).map((r) => r.id)).toEqual(['d']);
  });
});

describe('timelineBars', () => {
  it('builds sorted 1-day bars by default', () => {
    const bars = timelineBars(rows);
    expect(bars.map((b) => b.id)).toEqual(['a', 'b', 'c']);
    expect(bars[0]).toMatchObject({ start: '2026-10-05', end: '2026-10-05' }); // missing end = 1 day
    expect(bars[0].record.id).toBe('a');
  });

  it('uses endDateKey and clamps end < start to the start day', () => {
    const rs = [
      rec('s', { p_start: '2026-10-10', p_end: '2026-10-15' }),
      rec('clamp', { p_start: '2026-10-10', p_end: '2026-10-01' }),
      rec('open', { p_start: '2026-10-12' }),
      rec('skip', { p_end: '2026-10-20' }),
    ];
    const bars = timelineBars(rs, { dateKey: 'p_start', endDateKey: 'p_end' });
    expect(bars.map((b) => `${b.id}:${b.start}→${b.end}`)).toEqual([
      'clamp:2026-10-10→2026-10-10',
      's:2026-10-10→2026-10-15',
      'open:2026-10-12→2026-10-12',
    ]);
  });

  it('sorts by start then end then id', () => {
    const rs = [
      rec('z', { dueDate: '2026-10-05', p_e: '2026-10-09' }),
      rec('y', { dueDate: '2026-10-05', p_e: '2026-10-06' }),
      rec('x', { dueDate: '2026-10-01' }),
    ];
    const bars = timelineBars(rs, { endDateKey: 'p_e' });
    expect(bars.map((b) => b.id)).toEqual(['x', 'y', 'z']);
  });
});

describe('timelineConflicts', () => {
  const bar = (id: string, start: string, end: string): TimelineBar => ({
    id,
    start,
    end,
    record: rec(id),
  });
  const bars = [
    bar('blocker', '2026-10-01', '2026-10-10'),
    bar('victim', '2026-10-05', '2026-10-06'),
    bar('ok-after', '2026-10-10', '2026-10-11'),
    bar('unrelated', '2026-09-01', '2026-09-02'),
  ];

  it('flags bars that start before their blocker ends', () => {
    const edges = [
      { from: 'blocker', to: 'victim' },
      { from: 'blocker', to: 'ok-after' },
      { from: 'blocker', to: 'unrelated' },
    ];
    const conflicts = timelineConflicts(bars, edges);
    expect(conflicts.has('victim')).toBe(true);      // 10-05 < 10-10
    expect(conflicts.has('ok-after')).toBe(false);   // 10-10 !< 10-10 — strict
    expect(conflicts.has('unrelated')).toBe(true);   // 09-01 < 10-10 — start < blocker end is the rule
  });

  it('ignores edges to bars that do not exist', () => {
    expect(timelineConflicts(bars, [{ from: 'blocker', to: 'ghost' }]).size).toBe(0);
    expect(timelineConflicts(bars, [{ from: 'ghost', to: 'victim' }]).size).toBe(0);
  });
});
