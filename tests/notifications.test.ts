import { describe, expect, it } from 'vitest';
import { appendGroupItem, reminderKind, URGENT_KINDS } from '../worker/notifications';
import { kindAllowed, mergePrefs, parsePrefs, sanitizePrefs } from '../worker/auth';

describe('appendGroupItem (30-min grouping, items cap)', () => {
  it('creates a single-item array for a fresh group', () => {
    const json = appendGroupItem(null, { actorId: 'u1', at: 100, summary: 'first' });
    expect(JSON.parse(json)).toEqual([{ actorId: 'u1', at: 100, summary: 'first' }]);
  });

  it('appends to an existing group preserving order', () => {
    const one = appendGroupItem(null, { actorId: 'u1', at: 100, summary: 'a' });
    const two = appendGroupItem(one, { actorId: 'u2', at: 200, summary: 'b' });
    expect(JSON.parse(two)).toHaveLength(2);
    expect(JSON.parse(two)[1]).toMatchObject({ actorId: 'u2', summary: 'b' });
  });

  it('caps the items array, keeping the most recent entries', () => {
    let json = appendGroupItem(null, { at: 0, summary: 's0' });
    for (let i = 1; i <= 25; i++) json = appendGroupItem(json, { at: i, summary: `s${i}` });
    const items = JSON.parse(json) as { at: number }[];
    expect(items).toHaveLength(20);
    expect(items[0].at).toBe(6); // oldest entries dropped
    expect(items[19].at).toBe(25);
  });

  it('honors a custom cap', () => {
    let json = appendGroupItem(null, { at: 1, summary: 'a' }, 2);
    json = appendGroupItem(json, { at: 2, summary: 'b' }, 2);
    json = appendGroupItem(json, { at: 3, summary: 'c' }, 2);
    expect(JSON.parse(json)).toHaveLength(2);
    expect(JSON.parse(json)[0].at).toBe(2);
  });

  it('recovers from malformed stored JSON', () => {
    const json = appendGroupItem('{not json', { at: 1, summary: 'x' });
    expect(JSON.parse(json)).toEqual([{ at: 1, summary: 'x' }]);
    const notArray = appendGroupItem('{"a":1}', { at: 1, summary: 'x' });
    expect(JSON.parse(notArray)).toHaveLength(1);
  });
});

describe('reminderKind', () => {
  const today = '2026-10-10';
  it('classifies overdue / due soon / out of window', () => {
    expect(reminderKind('2026-10-09', today, 1)).toBe('overdue');
    expect(reminderKind('2026-10-10', today, 1)).toBe('due_soon'); // due today
    expect(reminderKind('2026-10-11', today, 1)).toBe('due_soon'); // within lead
    expect(reminderKind('2026-10-12', today, 1)).toBeNull(); // beyond lead
    expect(reminderKind('2026-10-12', today, 3)).toBe('due_soon'); // longer lead
    expect(reminderKind('2026-10-11', today, 0)).toBeNull(); // lead 0 = today only
  });
});

describe('URGENT_KINDS (quiet digest)', () => {
  it('keeps the human-directed kinds loud', () => {
    for (const k of ['mention', 'assigned', 'approval_requested', 'approval_decided']) {
      expect(URGENT_KINDS).toContain(k);
    }
    for (const k of ['due_soon', 'overdue', 'comment_on_mine', 'form_submission', 'automation']) {
      expect(URGENT_KINDS).not.toContain(k);
    }
  });
});

describe('sanitizePrefs', () => {
  it('keeps only known kinds with inbox|off values', () => {
    expect(
      sanitizePrefs({
        notifications: { mention: 'off', due_soon: 'inbox', bogus_kind: 'off', overdue: 'loud' },
        quietDigest: true,
        junk: 1,
      }),
    ).toEqual({ notifications: { mention: 'off', due_soon: 'inbox' }, quietDigest: true });
  });

  it('rejects non-object / malformed input', () => {
    for (const bad of [null, undefined, 42, 'x', [1], { notifications: 'off' }]) {
      expect(sanitizePrefs(bad)).toEqual({});
    }
  });
});

describe('mergePrefs', () => {
  it('merges per-kind values; explicit inbox returns to default (unstored)', () => {
    const stored = { notifications: { mention: 'off' as const }, quietDigest: false };
    const merged = mergePrefs(stored, { notifications: { mention: 'inbox', due_soon: 'off' } });
    expect(merged.notifications).toEqual({ due_soon: 'off' });
  });

  it('drops the notifications key when everything is back to default', () => {
    const merged = mergePrefs({ notifications: { mention: 'off' } }, { notifications: { mention: 'inbox' } });
    expect(merged).toEqual({});
  });

  it('flips quietDigest only when present', () => {
    expect(mergePrefs({ quietDigest: true }, {}).quietDigest).toBe(true);
    expect(mergePrefs({}, { quietDigest: true }).quietDigest).toBe(true);
    expect(mergePrefs({ quietDigest: true }, { quietDigest: false }).quietDigest).toBe(false);
  });
});

describe('kindAllowed + parsePrefs', () => {
  it('blocks only explicit off', () => {
    expect(kindAllowed({}, 'mention')).toBe(true);
    expect(kindAllowed({ notifications: { mention: 'off' } }, 'mention')).toBe(false);
    expect(kindAllowed({ notifications: { mention: 'inbox' } }, 'mention')).toBe(true);
    expect(kindAllowed(undefined, 'automation')).toBe(true);
  });

  it('parses stored JSON defensively', () => {
    expect(parsePrefs(null)).toEqual({});
    expect(parsePrefs('not json')).toEqual({});
    expect(parsePrefs('{"quietDigest":true,"notifications":{"overdue":"off"}}')).toEqual({
      quietDigest: true,
      notifications: { overdue: 'off' },
    });
  });
});
