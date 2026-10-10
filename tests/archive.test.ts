import { describe, expect, it } from 'vitest';
import { ARCHIVED_LABEL, archivePatch, isArchived } from '../shared/archive';

describe('archive helpers', () => {
  it('isArchived is strict-true on flat rows and {data} wrappers', () => {
    expect(isArchived({ archived: true })).toBe(true);
    expect(isArchived({ archived: false })).toBe(false);
    expect(isArchived({})).toBe(false);
    expect(isArchived(null)).toBe(false);
    expect(isArchived(undefined)).toBe(false);
    // worker Rec / StoredRecord shape
    expect(isArchived({ id: 'r1', data: { archived: true } })).toBe(true);
    expect(isArchived({ id: 'r1', data: { archived: false } })).toBe(false);
    // truthy-but-not-true values don't count
    expect(isArchived({ archived: 1 })).toBe(false);
    expect(isArchived({ archived: 'true' })).toBe(false);
  });

  it('archivePatch always emits a strict boolean', () => {
    expect(archivePatch(true)).toEqual({ archived: true });
    expect(archivePatch(false)).toEqual({ archived: false });
  });

  it('label is exactly "Archived"', () => {
    expect(ARCHIVED_LABEL).toBe('Archived');
  });
});
