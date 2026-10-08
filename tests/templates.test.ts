import { describe, expect, it } from 'vitest';
import { planTemplateInstantiation, type RecSnapshot } from '../shared/templates';
import { linkId } from '../shared/linkid';
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

describe('template planner — Phase 1 databases/linking', () => {
  function dbSnap(): RecSnapshot {
    return {
      pages: {
        tpl: { title: 'People & Orgs', parentId: null, order: 'a0', isTemplate: true },
      },
      blocks: {
        pblk: { pageId: 'tpl', order: 'a0', type: 'p', text: 'About @[rec:t-maya] and @[page:tpl]' },
        bdb1: { pageId: 'tpl', order: 'a1', type: 'tasks', boardId: 'db-people' },
        bdb2: { pageId: 'tpl', order: 'a2', type: 'tasks', boardId: 'db-orgs' },
        // record body block: lives on the record, not the page
        tbody: { pageId: 't-maya', parentType: 'record', order: 'a0', type: 'p', text: 'Notes on Mayavadi' },
      },
      boards: {
        'db-people': {
          name: 'People',
          kind: 'records',
          recordNoun: 'Person',
          description: 'Directory',
          showBuiltins: { assignee: false, due: false, priority: false },
          fields: [
            { id: 'f-org', name: 'Organization', type: 'relation', relation: { target: 'db-orgs', pairedFieldId: 'f-people', primary: true } },
            { id: 'f-loc', name: 'Location', type: 'text' },
          ],
        },
        'db-orgs': {
          name: 'Organizations',
          kind: 'records',
          fields: [
            { id: 'f-people', name: 'People', type: 'relation', relation: { target: 'db-people', pairedFieldId: 'f-org' } },
            { id: 'f-site', name: 'Website', type: 'url' },
          ],
        },
      },
      tasks: {
        't-maya': { boardId: 'db-people', title: 'Maya', status: null, order: 'a0', p_f_loc: 'Mayavadi' },
        't-jun': { boardId: 'db-people', title: 'Jun', status: null, order: 'a1', parentId: 't-maya' },
        't-ms': { boardId: 'db-orgs', title: 'Mayavadi Space', order: 'a0' },
      },
      views: {
        'v-all': { databaseId: 'db-people', name: 'All', type: 'table', order: 'a0', config: { sorts: [{ key: 'title', dir: 'asc' }] } },
        'v-gal': { databaseId: 'db-people', name: 'Gallery', type: 'gallery', order: 'a1', config: { cover: 'cover' } },
        'v-other': { databaseId: 'db-elsewhere', name: 'Not copied', type: 'table', order: 'a0' },
        'v-del': { databaseId: 'db-people', name: 'Dead', type: 'table', order: 'a2', deleted: true },
      },
      links: {
        'l-1': { fromType: 'record', fromId: 't-maya', toType: 'record', toId: 't-ms', kind: 'relation', fieldId: 'f-org' },
        'l-2': { fromType: 'page', fromId: 'tpl', toType: 'record', toId: 't-maya', kind: 'related' },
        'l-3': { fromType: 'record', fromId: 't-maya', toType: 'record', toId: 'outside', kind: 'related' }, // toId not copied
        'l-4': { fromType: 'record', fromId: 't-jun', toType: 'record', toId: 't-ms', kind: 'blocks', deleted: true },
      },
    };
  }

  it('copies views of copied databases only, remapped to the new databaseId', () => {
    const plan = planTemplateInstantiation(dbSnap(), { templateId: 'tpl' }, { id, now })!;
    const views = plan.writes.filter((w) => w.collection === 'views');
    expect(views).toHaveLength(2);
    const boards = plan.writes.filter((w) => w.collection === 'boards');
    const peopleId = boards.find((b) => b.patch.name === 'People')!.id;
    for (const v of views) expect(v.patch.databaseId).toBe(peopleId);
    expect(views.map((v) => v.patch.name).sort()).toEqual(['All', 'Gallery']);
    expect(views.find((v) => v.patch.name === 'All')!.patch.config).toEqual({ sorts: [{ key: 'title', dir: 'asc' }] });
  });

  it('copies board kind/recordNoun/showBuiltins/description and remaps relation targets', () => {
    const plan = planTemplateInstantiation(dbSnap(), { templateId: 'tpl' }, { id, now })!;
    const boards = plan.writes.filter((w) => w.collection === 'boards');
    const people = boards.find((b) => b.patch.name === 'People')!;
    const orgs = boards.find((b) => b.patch.name === 'Organizations')!;
    expect(people.patch.kind).toBe('records');
    expect(people.patch.recordNoun).toBe('Person');
    expect(people.patch.description).toBe('Directory');
    expect(people.patch.showBuiltins).toEqual({ assignee: false, due: false, priority: false });
    // relation target between the two copied databases remaps; paired field ids stay
    const fOrg = (people.patch.fields as { id: string; relation?: { target: string; pairedFieldId?: string } }[]).find((f) => f.id === 'f-org')!;
    expect(fOrg.relation?.target).toBe(orgs.id);
    expect(fOrg.relation?.pairedFieldId).toBe('f-people');
    const fPeople = (orgs.patch.fields as { id: string; relation?: { target: string } }[]).find((f) => f.id === 'f-people')!;
    expect(fPeople.relation?.target).toBe(people.id);
  });

  it('copies record parentId remapped and record body blocks with parentType record', () => {
    const plan = planTemplateInstantiation(dbSnap(), { templateId: 'tpl' }, { id, now })!;
    const tasks = plan.writes.filter((w) => w.collection === 'tasks');
    const jun = tasks.find((t) => t.patch.title === 'Jun')!;
    const maya = tasks.find((t) => t.patch.title === 'Maya')!;
    expect(jun.patch.parentId).toBe(maya.id);
    const body = plan.writes.filter((w) => w.collection === 'blocks').find((b) => b.patch.text === 'Notes on Mayavadi')!;
    expect(body.patch.pageId).toBe(maya.id);
    expect(body.patch.parentType).toBe('record');
  });

  it('copies links whose both ends are inside the copy, remapped + deterministic ids', () => {
    const plan = planTemplateInstantiation(dbSnap(), { templateId: 'tpl' }, { id, now })!;
    const links = plan.writes.filter((w) => w.collection === 'links');
    // l-1 (record→record relation) and l-2 (page→record related); l-3 has an outside end, l-4 is deleted.
    expect(links).toHaveLength(2);
    const tasks = plan.writes.filter((w) => w.collection === 'tasks');
    const maya = tasks.find((t) => t.patch.title === 'Maya')!;
    const ms = tasks.find((t) => t.patch.title === 'Mayavadi Space')!;
    const rel = links.find((l) => l.patch.kind === 'relation')!;
    expect(rel.patch.fromId).toBe(maya.id);
    expect(rel.patch.toId).toBe(ms.id);
    expect(rel.patch.fieldId).toBe('f-org');
    expect(rel.id).toBe(linkId('relation', 'f-org', maya.id as string, ms.id as string));
    const related = links.find((l) => l.patch.kind === 'related')!;
    expect(related.patch.fromId).toBe(plan.rootPageId);
    expect(related.patch.toId).toBe(maya.id);
  });

  it('remaps @[rec:] and @[page:] mention tokens in copied block text', () => {
    const plan = planTemplateInstantiation(dbSnap(), { templateId: 'tpl' }, { id, now })!;
    const tasks = plan.writes.filter((w) => w.collection === 'tasks');
    const maya = tasks.find((t) => t.patch.title === 'Maya')!;
    const pblk = plan.writes.find((w) => w.collection === 'blocks' && String(w.patch.text).startsWith('About'))!;
    expect(pblk.patch.text).toBe(`About @[rec:${maya.id}] and @[page:${plan.rootPageId}]`);
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
