import { describe, expect, it } from 'vitest';
import { addDays, isDone, nextDate, todayUtc } from '../shared/recurrence';

describe('nextDate daily', () => {
  it('advances interval days', () => {
    expect(nextDate({ freq: 'daily', interval: 1 }, '2026-10-10')).toBe('2026-10-11');
    expect(nextDate({ freq: 'daily', interval: 3 }, '2026-10-30')).toBe('2026-11-02');
    expect(nextDate({ freq: 'daily', interval: 1 }, '2026-12-31')).toBe('2027-01-01');
  });

  it('rejects invalid input', () => {
    expect(nextDate({ freq: 'daily', interval: 0 }, '2026-10-10')).toBeNull();
    expect(nextDate({ freq: 'daily', interval: -2 }, '2026-10-10')).toBeNull();
    // @ts-expect-error bad freq
    expect(nextDate({ freq: 'hourly', interval: 1 }, '2026-10-10')).toBeNull();
    expect(nextDate({ freq: 'daily', interval: 1 }, '10/10/2026')).toBeNull();
    expect(nextDate({ freq: 'daily', interval: 1 }, '')).toBeNull();
  });
});

describe('nextDate weekly', () => {
  it('same weekday without byWeekday', () => {
    // 2026-10-10 is a Saturday.
    expect(nextDate({ freq: 'weekly', interval: 1 }, '2026-10-10')).toBe('2026-10-17');
    expect(nextDate({ freq: 'weekly', interval: 2 }, '2026-10-10')).toBe('2026-10-24');
  });

  it('byWeekday picks earliest allowed weekday in the target week', () => {
    // Saturday base, next week wants Mon+Wed → Monday of the next week.
    expect(nextDate({ freq: 'weekly', interval: 1, byWeekday: [1, 3] }, '2026-10-10')).toBe('2026-10-12');
    // Every-2-weeks cadence: two weeks out, earliest wanted day.
    expect(nextDate({ freq: 'weekly', interval: 2, byWeekday: [1, 3] }, '2026-10-10')).toBe('2026-10-19');
    // Single weekday = same-weekday-n-weeks behavior but pinned to that day.
    expect(nextDate({ freq: 'weekly', interval: 1, byWeekday: [6] }, '2026-10-10')).toBe('2026-10-17');
  });

  it('drops out-of-range weekdays', () => {
    expect(nextDate({ freq: 'weekly', interval: 1, byWeekday: [9] }, '2026-10-10')).toBeNull();
  });
});

describe('nextDate monthly', () => {
  it('advances interval months, clamping to month end', () => {
    expect(nextDate({ freq: 'monthly', interval: 1 }, '2026-01-15')).toBe('2026-02-15');
    // Jan 31 → Feb clamps to 28 (2026 not leap).
    expect(nextDate({ freq: 'monthly', interval: 1 }, '2026-01-31')).toBe('2026-02-28');
    // Clamped day becomes the new schedule day.
    expect(nextDate({ freq: 'monthly', interval: 1 }, '2026-02-28')).toBe('2026-03-28');
    expect(nextDate({ freq: 'monthly', interval: 12 }, '2026-10-10')).toBe('2027-10-10');
    expect(nextDate({ freq: 'monthly', interval: 3 }, '2026-11-30')).toBe('2027-02-28');
  });
});

describe('nextDate until', () => {
  it('returns null past until', () => {
    expect(nextDate({ freq: 'daily', interval: 1, until: '2026-10-15' }, '2026-10-14')).toBe('2026-10-15');
    expect(nextDate({ freq: 'daily', interval: 1, until: '2026-10-15' }, '2026-10-15')).toBeNull();
  });
});

describe('isDone', () => {
  const cols = [{ id: 'todo' }, { id: 'doing' }, { id: 'done' }];
  it('matches only the last column', () => {
    expect(isDone(cols, 'done')).toBe(true);
    expect(isDone(cols, 'doing')).toBe(false);
    expect(isDone(cols, 'nope')).toBe(false);
    expect(isDone([], 'done')).toBe(false);
    expect(isDone(undefined, 'done')).toBe(false);
    expect(isDone(cols, 3)).toBe(false);
  });
});

describe('date helpers', () => {
  it('todayUtc is yyyy-mm-dd', () => {
    expect(todayUtc(Date.UTC(2026, 9, 10))).toBe('2026-10-10');
  });
  it('addDays crosses month/year boundaries', () => {
    expect(addDays('2026-10-10', 5)).toBe('2026-10-15');
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-10-10', -14)).toBe('2026-09-26');
  });
});
