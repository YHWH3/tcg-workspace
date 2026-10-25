import { describe, expect, it } from 'vitest';
import { resolveRelativeDate, relativeDateError } from '../shared/dates';

describe('R1 relative date contract', () => {
  it.each([
    ['today', '2026-10-24', '2026-10-24'],
    ['today+0', '2026-10-24', '2026-10-24'],
    ['today-0', '2026-10-24', '2026-10-24'],
    ['today+30', '2026-10-24', '2026-11-23'],
    ['today-7', '2026-10-24', '2026-10-17'],
    ['today+1', '2026-12-31', '2027-01-01'],
    ['today-1', '2026-01-01', '2025-12-31'],
    ['today+1', '2024-02-28', '2024-02-29'],
    ['today+1', '2024-02-29', '2024-03-01'],
    ['today+3650', '2026-10-24', '2036-10-21'],
    ['today-3650', '2026-10-24', '2016-10-26'],
  ])('resolves %s against %s', (value, today, expected) => {
    expect(resolveRelativeDate(value, today)).toBe(expected);
    expect(relativeDateError(value)).toBeNull();
  });
  it.each(['today+3651', 'today-3651', 'today + 3', 'Today+3', 'today+1.5', 'today++1', 'today+', 'today-NaN', 'today+Infinity', 'today+99999999999999999999', 'today+30\n'])('preserves but rejects malformed/out-of-range %s', value => {
    expect(resolveRelativeDate(value, '2026-10-24')).toBe(value);
    expect(relativeDateError(value)).toBeTypeOf('string');
  });
  it.each([undefined, 'invalid', '2026-02-30', '2026-1-1'])('does not guess when today is %s', today => {
    for (const value of ['today', 'today+30', 'today-7']) expect(resolveRelativeDate(value, today)).toBe(value);
  });
  it('preserves literals and non-strings, and refuses date overflow', () => {
    for (const value of ['a title', 'todayish', '2026-11-23', 30, null, undefined]) {
      expect(resolveRelativeDate(value, '2026-10-24')).toBe(value);
      expect(relativeDateError(value)).toBeNull();
    }
    expect(resolveRelativeDate('today+1', '9999-12-31')).toBe('today+1');
  });
});
import {
  addDays,
  cmpDateOnly,
  daysBetween,
  isoWeek,
  monthGrid,
  parseDateOnly,
  scaleRange,
  startOfWeek,
  toDateOnly,
} from '../shared/dates';

describe('parseDateOnly', () => {
  it('accepts strict yyyy-mm-dd', () => {
    expect(parseDateOnly('2026-10-09')).toEqual({ y: 2026, m: 10, d: 9 });
    expect(parseDateOnly('2024-02-29')).toEqual({ y: 2024, m: 2, d: 29 }); // leap
    expect(parseDateOnly('0001-01-01')).toEqual({ y: 1, m: 1, d: 1 });
  });

  it('rejects everything else', () => {
    for (const bad of [
      '2026-1-9', '2026-10-9', '26-10-09', '2026/10/09', '10-09-2026',
      '2026-10-09T00:00:00Z', ' 2026-10-09', '2026-10-09 ', 'Oct 9 2026',
      '2026-13-01', '2026-00-10', '2026-10-00', '2026-02-30', '2025-02-29',
      '2026-04-31', '99999-01-01', '', 'abcd-ef-gh',
    ]) {
      expect(parseDateOnly(bad), bad).toBeNull();
    }
    expect(parseDateOnly(123)).toBeNull();
    expect(parseDateOnly(null)).toBeNull();
    expect(parseDateOnly(undefined)).toBeNull();
    expect(parseDateOnly({})).toBeNull();
  });
});

describe('toDateOnly / addDays / daysBetween', () => {
  it('round-trips', () => {
    expect(toDateOnly({ y: 2026, m: 3, d: 5 })).toBe('2026-03-05');
    expect(toDateOnly({ y: 7, m: 1, d: 2 })).toBe('0007-01-02');
  });

  it('adds across month/year/leap boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2025-02-28', 1)).toBe('2025-03-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2026-10-09', 0)).toBe('2026-10-09');
    expect(addDays('not-a-date', 1)).toBeNull();
  });

  it('daysBetween', () => {
    expect(daysBetween('2026-01-01', '2026-01-10')).toBe(9);
    expect(daysBetween('2026-01-10', '2026-01-01')).toBe(-9);
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
    expect(daysBetween('2026-01-01', 'bogus')).toBeNull();
  });
});

describe('cmpDateOnly', () => {
  it('orders and sorts invalid last', () => {
    expect(cmpDateOnly('2026-01-01', '2026-01-02')).toBeLessThan(0);
    expect(cmpDateOnly('2026-01-02', '2026-01-01')).toBeGreaterThan(0);
    expect(cmpDateOnly('2026-01-01', '2026-01-01')).toBe(0);
    expect(cmpDateOnly('bogus', '2026-01-01')).toBeGreaterThan(0);
    expect(cmpDateOnly(null, '2026-01-01')).toBeGreaterThan(0);
    expect(cmpDateOnly(undefined, undefined)).toBe(0);
  });
});

describe('startOfWeek', () => {
  it('defaults to Monday', () => {
    expect(startOfWeek('2026-10-09')).toBe('2026-10-05'); // Friday → back to Mon
    expect(startOfWeek('2026-10-05')).toBe('2026-10-05'); // already Monday
    expect(startOfWeek('2026-10-11')).toBe('2026-10-05'); // Sunday → same week
  });
  it('honors other week starts', () => {
    expect(startOfWeek('2026-10-09', 0)).toBe('2026-10-04'); // Sunday start
    expect(startOfWeek('2026-10-11', 0)).toBe('2026-10-11');
  });
});

describe('monthGrid', () => {
  it('June 2026 starts on the 1st (Monday) → 35 cells', () => {
    const cells = monthGrid(2026, 6);
    expect(cells).toHaveLength(35);
    expect(cells[0]).toEqual({ date: '2026-06-01', inMonth: true });
    expect(cells[cells.length - 1]).toEqual({ date: '2026-07-05', inMonth: false });
    expect(cells.filter((c) => c.inMonth)).toHaveLength(30);
  });

  it('May 2026 leads with April days', () => {
    const cells = monthGrid(2026, 5); // May 1 is a Friday
    expect(cells[0]).toEqual({ date: '2026-04-27', inMonth: false });
    expect(cells[4]).toEqual({ date: '2026-05-01', inMonth: true });
    expect(cells[cells.length - 1]).toEqual({ date: '2026-05-31', inMonth: true }); // Sunday
  });

  it('leap February spans into March', () => {
    const cells = monthGrid(2024, 2); // Feb 1 2024 Thursday
    const feb = cells.filter((c) => c.inMonth);
    expect(feb).toHaveLength(29);
    expect(feb[28].date).toBe('2024-02-29');
    expect(cells[cells.length - 1].date).toBe('2024-03-03');
  });

  it('cells are consecutive days', () => {
    const cells = monthGrid(2026, 10);
    for (let i = 1; i < cells.length; i++) {
      expect(addDays(cells[i - 1].date, 1)).toBe(cells[i].date);
    }
  });

  it('rejects bad input', () => {
    expect(monthGrid(2026, 0)).toEqual([]);
    expect(monthGrid(2026, 13)).toEqual([]);
  });
});

describe('scaleRange', () => {
  it('week', () => {
    expect(scaleRange('week', '2026-10-09')).toEqual({
      start: '2026-10-05',
      end: '2026-10-11',
      ticks: [
        '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08',
        '2026-10-09', '2026-10-10', '2026-10-11',
      ],
    });
  });

  it('month ticks at week starts covering the month', () => {
    const r = scaleRange('month', '2026-10-09')!;
    expect(r.start).toBe('2026-10-01');
    expect(r.end).toBe('2026-10-31');
    expect(r.ticks).toEqual(['2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26']);
  });

  it('quarter covers three months with month ticks', () => {
    expect(scaleRange('quarter', '2026-10-09')).toEqual({
      start: '2026-10-01',
      end: '2026-12-31',
      ticks: ['2026-10-01', '2026-11-01', '2026-12-01'],
    });
    expect(scaleRange('quarter', '2026-02-15')).toEqual({
      start: '2026-01-01',
      end: '2026-03-31',
      ticks: ['2026-01-01', '2026-02-01', '2026-03-01'],
    });
  });

  it('rejects bad anchor', () => {
    expect(scaleRange('week', 'nope')).toBeNull();
  });
});

describe('isoWeek', () => {
  it('follows the Thursday rule', () => {
    expect(isoWeek('2026-01-01')).toEqual({ year: 2026, week: 1 }); // Thursday
    expect(isoWeek('2024-12-30')).toEqual({ year: 2025, week: 1 }); // Monday of ISO 2025-W01
    expect(isoWeek('2025-12-29')).toEqual({ year: 2026, week: 1 });
    expect(isoWeek('2026-10-09')).toEqual({ year: 2026, week: 41 });
    expect(isoWeek('bogus')).toBeNull();
  });
});

describe('timezone safety', () => {
  it('all arithmetic is identical in any TZ (UTC-midnight only)', () => {
    const snapshot = {
      add: addDays('2026-01-31', 1),
      between: daysBetween('2026-06-30', '2026-07-01'),
      week: startOfWeek('2026-10-09'),
      grid: monthGrid(2026, 2).map((c) => c.date),
      scale: scaleRange('month', '2026-10-09'),
      iso: isoWeek('2026-01-01'),
    };
    const orig = process.env.TZ;
    try {
      for (const tz of ['Pacific/Kiritimati', 'America/Los_Angeles', 'Pacific/Auckland', 'UTC']) {
        process.env.TZ = tz;
        expect(addDays('2026-01-31', 1), tz).toBe(snapshot.add);
        expect(daysBetween('2026-06-30', '2026-07-01'), tz).toBe(snapshot.between);
        expect(startOfWeek('2026-10-09'), tz).toBe(snapshot.week);
        expect(monthGrid(2026, 2).map((c) => c.date), tz).toEqual(snapshot.grid);
        expect(scaleRange('month', '2026-10-09'), tz).toEqual(snapshot.scale);
        expect(isoWeek('2026-01-01'), tz).toEqual(snapshot.iso);
      }
    } finally {
      if (orig === undefined) delete process.env.TZ;
      else process.env.TZ = orig;
    }
  });
});
