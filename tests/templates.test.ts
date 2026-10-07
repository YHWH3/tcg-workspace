import { describe, expect, it } from 'vitest';
import { planTemplateInstantiation, type RecSnapshot } from '../shared/templates';
import { restampForServer } from '../worker/sync';
import { mergeRecord } from '../worker/merge';

let seq = 0;
const id = () => `id${++seq}`;
const now = 1_800_000_000_000;

function snap(): RecSnapshot {
  return {
    pages: {
      tpl: { title: 'Onboard {{client}}', parentId: null, order: 'a0', isTemplate: true, icon: '🧭' },
      child: { title: 'Checklist', parentId: 'tpl', order: 'a0' },
      other: { title: 'Unrelated', parentId: null, order: 'a1' },
    },
    blocks: {
      b1: { pageId: 'tpl', order: 'a0', type: 'p', text: 'Welcome {{client}} — hi {{unknown}}' },
      b2: { pageId: 'tpl', order: 'a1', type: 'tasks', boardId: 'src-board' },
      b3: { pageId: 'child', order: 'a0', type: 'todo', text: 'Do it', checked: false },
    },
    boards: {
      'src-board': { name: 'Launch {{client}}', icon: '🚀', columns: [{ id: 'c1', name: 'Todo', color: '#999' }], fields: [{ id: 'f1', name: 'Phase', type: 'select', options: [{ id: 'o1', name: 'A', color: '#111' }] }] },
    },
    tasks: {
      t1: { boardId: 'src-board', title: 'Task one', status: 'c1', p_f1: 'o1', assigneeId: 'u1', dueDate: '2026-01-01' },
      t2: { boardId: 'src-board', title: 'Gone', deleted: true },
      t3: { boardId: 'other', title: 'Other board' },
    },
  };
}

describe('template planner', () => {
  it('copies the subtree, substitutes variables, copies boards + live tasks', () => {
    const plan = planTemplateInstantiation(snap(), { templateId: 'tpl', title: 'Onboard Acme', variables: { client: 'Acme' }, actorId: 'u-me' }, { id, now });
    expect(plan).not.toBeNull();
    const { writes, rootPageId } = plan!;
    const pages = writes.filter((w) => w.collection === 'pages');
    const blocks = writes.filter((w) => w.collection === 'blocks');
    const boards = writes.filter((w) => w.collection === 'boards');
    const tasks = writes.filter((w) => w.collection === 'tasks');

    expect(pages).toHaveLength(2);
    expect(blocks).toHaveLength(3);
    expect(boards).toHaveLength(1);
    expect(tasks).toHaveLength(1);

    const root = pages.find((w) => w.id === rootPageId)!;
    expect(root.patch.title).toBe('Onboard Acme');
    expect(root.patch.isTemplate).toBe(false);
    expect(root.patch.parentId).toBeNull();

    const child = pages.find((w) => w.id !== rootPageId)!;
    expect(child.patch.parentId).toBe(rootPageId);

    // placeholders: known replaced, unknown left
    const p1 = blocks.find((w) => w.patch.type === 'p')!;
    expect(p1.patch.text).toBe('Welcome Acme — hi {{unknown}}');

    // tasks block repointed at the copied board
    const tb = blocks.find((w) => w.patch.type === 'tasks')!;
    expect(tb.patch.boardId).toBe(boards[0].id);
    expect(boards[0].patch.name).toBe('Launch Acme');
    expect((boards[0].patch.fields as unknown[]).length).toBe(1);

    // task copied with props, assignee/due dropped
    const t = tasks[0];
    expect(t.patch.title).toBe('Task one');
    expect(t.patch.boardId).toBe(boards[0].id);
    expect(t.patch.p_f1).toBe('o1');
    expect(t.patch.assigneeId).toBeUndefined();
    expect(t.patch.dueDate).toBeUndefined();
  });

  it('keeps the template untouched and returns null for a missing template', () => {
    const s = snap();
    planTemplateInstantiation(s, { templateId: 'tpl' }, { id, now });
    expect(s.pages.tpl.isTemplate).toBe(true);
    expect(planTemplateInstantiation(s, { templateId: 'nope' }, { id, now })).toBeNull();
  });
});

describe('restampForServer (server-side timestamps)', () => {
  it('stamps ts above existing field_ts so server writes win', () => {
    const floors = new Map([['r1', 250]]);
    const [stamped] = restampForServer([{ id: 'r1', collection: 'pages', patch: { title: 'new' }, ts: 0 }], floors, now);
    expect(stamped.ts).toBe(Math.max(now, 251));
  });

  it('fresh record gets ts = now; consecutive patches tick forward', () => {
    const floors = new Map<string, number>();
    const [a, b] = restampForServer(
      [
        { id: 'r1', collection: 'pages', patch: { a: 1 }, ts: 0 },
        { id: 'r1', collection: 'pages', patch: { b: 2 }, ts: 0 },
      ],
      floors,
      now,
    );
    expect(a.ts).toBe(now);
    expect(b.ts).toBe(now + 1);
  });

  it('stale client ts loses; server ts wins', () => {
    const cur = { data: { title: 'server' }, field_ts: { title: 200 } };
    expect(mergeRecord(cur, { patch: { title: 'old-edit' }, ts: 150 }).changed).toBe(false);
    const [stamped] = restampForServer([{ id: 'r1', collection: 'pages', patch: { title: 'new' }, ts: 0 }], new Map([['r1', 200]]), now);
    expect(mergeRecord(cur, { patch: stamped.patch, ts: stamped.ts }).data.title).toBe('new');
  });
});
