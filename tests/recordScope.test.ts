import { describe, expect, it } from 'vitest';
import { MAX_SCOPE_DEPTH, scopeResolver, type ScopeRecord } from '../shared/recordScope';

const row = (id: string, collection: string, data: Record<string, unknown> = {}, rootSpaceId = 'space-core'): ScopeRecord => ({ id, collection, data, rootSpaceId });
function graph(...rows: ScopeRecord[]) { return scopeResolver(new Map(rows.map(r => [r.id, r]))); }

describe('Phase 5 authoritative inheritance planner', () => {
  it('ignores client space claims on children and resolves body blocks through pages or records', () => {
    const resolve = graph(
      row('page', 'pages', {}, 'private'), row('child', 'pages', { parentId: 'page', spaceId: 'forged' }),
      row('board', 'boards', {}, 'private'), row('record', 'tasks', { boardId: 'board', spaceId: 'forged' }),
      row('page-body', 'blocks', { pageId: 'child', spaceId: 'forged' }), row('record-body', 'blocks', { pageId: 'record' }),
      row('comment', 'comments', { targetType: 'block', targetId: 'record-body' }),
      row('attachment', 'files', { parentType: 'block', parentId: 'page-body' }),
    );
    for (const id of ['page', 'child', 'board', 'record', 'page-body', 'record-body', 'comment', 'attachment']) {
      expect(resolve(id)).toEqual({ spaceId: 'private', readSpaceIds: ['private'], serviceOnly: false, ancestorDeleted: false });
    }
  });

  it('covers database views, mooditems actual boardId field, forms, trigger override and activity', () => {
    const resolve = graph(
      row('database', 'boards', {}, 'core'), row('other', 'boards', {}, 'private'),
      row('canvas', 'moodboards', {}, 'private'), row('card', 'mooditems', { boardId: 'canvas' }),
      row('view', 'views', { databaseId: 'database' }), row('form', 'forms', { databaseId: 'other' }),
      row('auto', 'automations', { databaseId: 'database', trigger: { databaseId: 'other' } }),
      row('activity', 'activity', { targetType: 'mooditem', targetId: 'card' }),
    );
    expect(resolve('view').spaceId).toBe('core');
    for (const id of ['card', 'form', 'auto', 'activity']) expect(resolve(id).spaceId).toBe('private');
  });

  it('requires both relation endpoint spaces without changing the origin ownership', () => {
    const resolve = graph(
      row('public', 'pages', {}, 'core'), row('secret', 'pages', {}, 'private'),
      row('relation', 'links', { fromType: 'page', fromId: 'public', toType: 'page', toId: 'secret', spaceId: 'forged' }),
    );
    expect(resolve('relation')).toMatchObject({ spaceId: 'core', readSpaceIds: ['core', 'private'] });
  });

  it('separates public form pending uploads from ordinary authenticated record grants', () => {
    const resolve = graph(
      row('board', 'boards', {}, 'private'), row('form', 'forms', { databaseId: 'board' }),
      row('pending', 'files', { parentType: 'form-pending', parentId: 'form' }),
      row('page', 'pages'), row('link', 'links', { fromType: 'page', fromId: 'page', toType: 'file', toId: 'pending' }),
    );
    expect(resolve('pending')).toMatchObject({ spaceId: 'private', serviceOnly: true });
    expect(resolve('link').serviceOnly).toBe(true);
  });

  it('preserves legacy default-board and unscoped configuration contracts without ignoring a real moved default board', () => {
    expect(graph(row('r', 'tasks'))('r').spaceId).toBe('space-core');
    expect(graph(row('r', 'tasks', { boardId: 'board-default' }))('r').spaceId).toBe('space-core');
    expect(graph(row('r', 'tasks'), row('board-default', 'boards', {}, 'private'))('r').spaceId).toBe('private');
    expect(graph(row('auto', 'automations'))('auto').spaceId).toBe('space-core');
    expect(graph(row('legacy', 'activity'))('legacy').spaceId).toBe('space-core');
  });

  it('fails closed for missing/mistyped parents instead of falling back to Core', () => {
    for (const child of [
      row('r', 'tasks', { boardId: 'missing' }), row('r', 'blocks', { pageId: 'missing' }),
      row('r', 'comments', { targetType: 'task', targetId: 'missing' }),
      row('r', 'views', { databaseId: 'missing' }), row('r', 'forms', { databaseId: 'missing' }),
      row('r', 'mooditems', { moodboardId: 'missing' }),
    ]) expect(() => graph(child)('r')).toThrow(/parent_unavailable|invalid_parent/);
    expect(() => graph(row('r', 'tasks', { boardId: 'page' }), row('page', 'pages'))('r')).toThrow('invalid_parent');
    expect(() => graph(row('r', 'files', { parentType: 'page', parentId: 'page' }), row('page', 'pages'))('r')).toThrow('invalid_parent');
    expect(() => graph(row('r', 'comments', { targetType: '__proto__', targetId: 'page' }), row('page', 'pages'))('r')).toThrow('invalid_parent');
  });

  it('rejects cycles and cross-database subrecords and bounds hostile deep ancestry', () => {
    expect(() => graph(row('a', 'pages', { parentId: 'b' }), row('b', 'pages', { parentId: 'a' }))('a')).toThrow('scope_cycle');
    expect(() => graph(row('a', 'tasks', { parentId: 'b' }), row('b', 'tasks', { parentId: 'a' }))('a')).toThrow('scope_cycle');
    expect(() => graph(row('a', 'tasks', { parentId: 'b' }), row('b', 'tasks', { boardId: 'other' }), row('other', 'boards'))('a')).toThrow('invalid_parent');
    const deep = Array.from({ length: MAX_SCOPE_DEPTH + 2 }, (_, i) => row(String(i), 'pages', i ? { parentId: String(i - 1) } : {}));
    expect(() => graph(...deep)(String(MAX_SCOPE_DEPTH + 1))).toThrow('scope_depth');
  });

  it('tracks a deleted ancestor without dropping tombstones or inventing a new owner', () => {
    const resolve = graph(row('board', 'boards', { deleted: true }, 'private'), row('task', 'tasks', { boardId: 'board' }), row('body', 'blocks', { pageId: 'task' }));
    expect(resolve('board').ancestorDeleted).toBe(false);
    expect(resolve('task')).toMatchObject({ spaceId: 'private', ancestorDeleted: true });
    expect(resolve('body').ancestorDeleted).toBe(true);
  });

  it('never consumes data.spaceId even on a root and rejects invalid server scope', () => {
    expect(graph(row('r', 'pages', { spaceId: 'private' }))('r').spaceId).toBe('space-core');
    expect(() => graph(row('r', 'boards', {}, ''))('r')).toThrow('invalid_scope');
    expect(() => graph(row('r', 'unknown'))('r')).toThrow('invalid_scope');
    expect(() => scopeResolver(new Map([['wrong-id', row('r', 'pages')]]))('wrong-id')).toThrow('invalid_scope');
  });
});
