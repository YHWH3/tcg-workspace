import { describe, it, expect } from 'vitest';
import { planDeleteImpact, type ImpactRow } from '../shared/impact';

const row = (id: string, collection: string, data: Record<string, unknown>): ImpactRow => ({ id, collection, data });

describe('planDeleteImpact', () => {
  it('page delete counts descendants, blocks, embedded tasks', () => {
    const snap = {
      pages: [row('p1', 'pages', { title: 'A' }), row('p2', 'pages', { parentId: 'p1' }), row('p3', 'pages', { parentId: 'p2' })],
      blocks: [row('b1', 'blocks', { pageId: 'p1', type: 'tasks' }), row('b2', 'blocks', { pageId: 'p3', type: 'p' })],
      tasks: [row('t1', 'tasks', { blockId: 'b1' })],
      comments: [], files: [], mooditems: [],
      shares: 2, backlinks: 3,
    };
    const i = planDeleteImpact(snap, 'page', 'p1');
    expect(i.counts.pages).toBe(3);
    expect(i.counts.blocks).toBe(2);
    expect(i.counts.tasks).toBe(1);
    expect(i.warnings.join(' ')).toContain('share');
  });

  it('board delete warns about live tasks', () => {
    const i = planDeleteImpact({ pages: [], blocks: [], tasks: [row('t1', 'tasks', { boardId: 'b1' }), row('t2', 'tasks', { boardId: 'b1', deleted: true })], comments: [], files: [], mooditems: [], shares: 0, backlinks: 0 }, 'board', 'b1');
    expect(i.counts.tasks).toBe(1);
  });

  it('task delete counts mood refs/comments/attachments', () => {
    const i = planDeleteImpact(
      { pages: [], blocks: [], tasks: [], comments: [row('c1', 'comments', { targetId: 't1' })], files: [row('f1', 'files', { parentId: 't1' })], mooditems: [row('m1', 'mooditems', { taskId: 't1' })], shares: 0, backlinks: 0 },
      'task',
      't1',
    );
    expect(i.counts.comments).toBe(1);
    expect(i.counts.files).toBe(1);
    expect(i.counts.mooditems).toBe(1);
    // The preview must describe what execution does: attachments are kept,
    // so they are reported as hidden and are not in the soft-delete id set.
    expect(i.ids.files).toBeUndefined();
    expect(i.warnings.join(' ')).toMatch(/attachment\(s\) are hidden .* kept/);
    expect(i.summary).toContain('hidden and kept');
  });
});
