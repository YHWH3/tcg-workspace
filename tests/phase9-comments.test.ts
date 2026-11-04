import { describe, expect, it } from 'vitest';
import { deriveEvents } from '../shared/events';

describe('Phase 9 resolved comment events', () => {
  it('derives a resolution event from the actual resolved fields and ignores reopen as a notification event', () => {
    const resolved = deriveEvents([{ id: 'comment', collection: 'comments', created: false, fields: ['resolvedAt', 'resolvedBy'], before: { targetType: 'task', targetId: 'task', resolvedAt: null, resolvedBy: null }, after: { targetType: 'task', targetId: 'task', resolvedAt: 123, resolvedBy: 'alice' } }]);
    expect(resolved.map((event) => event.kind)).toEqual(['comment.resolved']);
    const reopened = deriveEvents([{ id: 'comment', collection: 'comments', created: false, fields: ['resolvedAt', 'resolvedBy'], before: { resolvedAt: 123, resolvedBy: 'alice' }, after: { resolvedAt: null, resolvedBy: null } }]);
    expect(reopened).toEqual([]);
  });
});
