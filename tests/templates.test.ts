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

  it('stamps templateKey on copied rows and produces independent copies', () => {
    const a = planTemplateInstantiation(dbSnap(), { templateId: 'tpl', templateKey: 'starter-people' }, { id, now })!;
    expect(a.writes.filter((w) => w.collection === 'boards').every((w) => w.patch.templateKey === 'starter-people')).toBe(true);
    expect(a.writes.filter((w) => w.collection === 'pages').every((w) => w.patch.templateKey === 'starter-people')).toBe(true);
    const b = planTemplateInstantiation(dbSnap(), { templateId: 'tpl' }, { id, now })!;
    const idsA = new Set(a.writes.map((w) => w.id));
    for (const w of b.writes) expect(idsA.has(w.id)).toBe(false);
    const mayaA = a.writes.find((w) => w.collection === 'tasks' && w.patch.title === 'Maya')!;
    const linkB = b.writes.find((w) => w.collection === 'links' && w.patch.fieldId === 'f-org');
    expect(linkB && linkB.patch.fromId !== mayaA.id).toBe(true);
  });
});

describe('template planner — Phase 3 reuse/remap', () => {
  function p3Snap(): RecSnapshot {
    return {
      pages: {
        tpl: { title: 'Ops pack', parentId: null, order: 'a0', isTemplate: true },
        'tpl-tmpl': { title: 'Project Review', parentId: 'tpl', order: 'a1', isTemplate: true },
        'tpl-page': { title: 'Normal child', parentId: 'tpl', order: 'a2' },
      },
      blocks: {
        'b-tasks': { pageId: 'tpl', order: 'a0', type: 'tasks', boardId: 'db_a' },
        'b-view': { pageId: 'tpl', order: 'a1', type: 'view', databaseId: 'db_a', viewId: 'v_a', inline: { includeArchived: true }, limit: 10, heading: 'All work' },
        'b-view2': { pageId: 'tpl', order: 'a15', type: 'view', databaseId: 'db_b', heading: 'Log view' }, // pulls db_b (blocks pull boards; relations/captureTargets only remap)
        'b-metric': { pageId: 'tpl', order: 'a2', type: 'metric', databaseId: 'db_c', agg: 'count', label: 'Open orgs', filters: [{ key: 'status', op: 'is', value: 'c1' }] },
        'b-cal': { pageId: 'tpl', order: 'a3', type: 'calendar', sources: [{ databaseId: 'db_a', dateKey: 'dueDate', color: '#111' }, { databaseId: 'db_c', dateKey: 'p_f_when', color: '#222' }] },
        'b-act': { pageId: 'tpl', order: 'a4', type: 'activity', scope: 'all', limit: 20 },
        'b-mine': { pageId: 'tpl', order: 'a5', type: 'mywork' },
      },
      boards: {
        db_a: {
          name: 'Work',
          key: 'work',
          columns: [{ id: 'c1', name: 'Open', color: '#999' }],
          fields: [{ id: 'f_rel', name: 'Side', type: 'relation', relation: { target: 'db_b' } }],
          captureTargets: [{ kind: 'observation', databaseId: 'db_b' }, { kind: 'expense', databaseId: 'db_c' }],
          fieldActions: ['observation', 'expense', 'note'],
          defaultViewId: 'v_a',
        },
        db_b: {
          name: 'Log',
          fields: [{ id: 'f_back', name: 'Work', type: 'relation', relation: { target: 'db_a' } }],
        },
        db_c: { name: 'Orgs', fields: [] },
      },
      tasks: {
        't-1': { boardId: 'db_a', title: 'Row one', status: 'c1', order: 'a0' },
        't-c': { boardId: 'db_c', title: 'Existing org record', order: 'a0' },
      },
      views: {
        v_a: { databaseId: 'db_a', name: 'Main', type: 'table', order: 'a0', config: { visible: ['title'] } },
        v_c: { databaseId: 'db_c', name: 'Reused view', type: 'table', order: 'a0' },
      },
      links: {
        l1: { fromType: 'page', fromId: 'tpl', toType: 'record', toId: 't-1', kind: 'related', fieldId: null },
        l2: { fromType: 'record', fromId: 't-1', toType: 'record', toId: 't-c', kind: 'related', fieldId: null },
      },
    };
  }

  const findBlock = (plan: ReturnType<typeof planTemplateInstantiation>, type: string) =>
    plan!.writes.filter((w) => w.collection === 'blocks').find((w) => w.patch.type === type)!;

  it('reuseBoards: no board/record/view writes for reused db but every reference remaps to the live id', () => {
    const plan = planTemplateInstantiation(p3Snap(), { templateId: 'tpl', reuseBoards: { db_c: 'live-c' }, templateKey: 'tcg-pack' }, { id, now })!;
    const boards = plan.writes.filter((w) => w.collection === 'boards');
    const tasks = plan.writes.filter((w) => w.collection === 'tasks');
    const views = plan.writes.filter((w) => w.collection === 'views');

    // db_a + db_b copied; db_c NOT written
    expect(boards).toHaveLength(2);
    expect(boards.map((b) => b.patch.name).sort()).toEqual(['Log', 'Work']);
    // reused board's records are not copied; db_a's are
    expect(tasks).toHaveLength(1);
    expect(tasks[0].patch.title).toBe('Row one');
    // views only for copied boards — v_c on reused db_c is not written
    expect(views).toHaveLength(1);
    const workBoard = boards.find((b) => b.patch.name === 'Work')!;
    expect(views[0].patch.databaseId).toBe(workBoard.id);

    // tasks block → copied db_a; metric → live id; calendar sources → copied + live
    expect(findBlock(plan, 'tasks').patch.boardId).toBe(workBoard.id);
    expect(findBlock(plan, 'metric').patch.databaseId).toBe('live-c');
    const cal = findBlock(plan, 'calendar');
    expect((cal.patch.sources as { databaseId: string }[])[0].databaseId).toBe(workBoard.id);
    expect((cal.patch.sources as { databaseId: string }[])[1].databaseId).toBe('live-c');

    // relation target remap: db_a.f_rel → copied db_b; db_b.f_back → copied db_a
    const logBoard = boards.find((b) => b.patch.name === 'Log')!;
    const fRel = (workBoard.patch.fields as { id: string; relation?: { target: string } }[]).find((f) => f.id === 'f_rel')!;
    expect(fRel.relation?.target).toBe(logBoard.id);
    const fBack = (logBoard.patch.fields as { id: string; relation?: { target: string } }[]).find((f) => f.id === 'f_back')!;
    expect(fBack.relation?.target).toBe(workBoard.id);

    // captureTargets remapped: db_b → copied, db_c → live
    const cts = workBoard.patch.captureTargets as { kind: string; databaseId: string }[];
    expect(cts[0]).toEqual({ kind: 'observation', databaseId: logBoard.id });
    expect(cts[1]).toEqual({ kind: 'expense', databaseId: 'live-c' });

    // link to a reused board's (uncopied) record is skipped
    expect(plan.writes.filter((w) => w.collection === 'links')).toHaveLength(1);
  });

  it('stamps templateDbKey from snapshot key and passes fieldActions through', () => {
    const plan = planTemplateInstantiation(p3Snap(), { templateId: 'tpl' }, { id, now })!;
    const work = plan.writes.filter((w) => w.collection === 'boards').find((w) => w.patch.name === 'Work')!;
    expect(work.patch.templateDbKey).toBe('work');
    expect(work.patch.fieldActions).toEqual(['observation', 'expense', 'note']);
    // boards without key get no templateDbKey
    const log = plan.writes.filter((w) => w.collection === 'boards').find((w) => w.patch.name === 'Log')!;
    expect(log.patch.templateDbKey).toBeUndefined();
  });

  it('preserveTemplates keeps isTemplate on authored template pages only', () => {
    const keep = planTemplateInstantiation(p3Snap(), { templateId: 'tpl', preserveTemplates: true }, { id, now })!;
    const pages = keep.writes.filter((w) => w.collection === 'pages');
    expect(pages.find((w) => w.patch.title === 'Project Review')!.patch.isTemplate).toBe(true);
    expect(pages.find((w) => w.patch.title === 'Normal child')!.patch.isTemplate).toBe(false);
    const drop = planTemplateInstantiation(p3Snap(), { templateId: 'tpl' }, { id, now })!;
    expect(drop.writes.filter((w) => w.collection === 'pages').every((w) => w.patch.isTemplate === false)).toBe(true);
  });

  it('view blocks remap viewId and databaseId via viewMap/boardMap; board defaultViewId remaps too', () => {
    const plan = planTemplateInstantiation(p3Snap(), { templateId: 'tpl' }, { id, now })!;
    const work = plan.writes.filter((w) => w.collection === 'boards').find((w) => w.patch.name === 'Work')!;
    const view = plan.writes.filter((w) => w.collection === 'views').find((w) => w.patch.name === 'Main')!;
    const vb = plan.writes.filter((w) => w.collection === 'blocks').find((w) => w.patch.type === 'view' && w.patch.heading === 'All work')!;
    expect(vb.patch.databaseId).toBe(work.id);
    expect(vb.patch.viewId).toBe(view.id);
    expect(vb.patch.inline).toEqual({ includeArchived: true });
    expect(vb.patch.limit).toBe(10);
    expect(vb.patch.heading).toBe('All work');
    expect(work.patch.defaultViewId).toBe(view.id);
    // activity/mywork pass their config through
    expect(findBlock(plan, 'activity').patch.scope).toBe('all');
    expect(findBlock(plan, 'activity').patch.limit).toBe(20);
    expect(findBlock(plan, 'mywork').patch.type).toBe('mywork');
    // metric config whitelist: agg/label/filters copied
    const metric = findBlock(plan, 'metric');
    expect(metric.patch.agg).toBe('count');
    expect(metric.patch.label).toBe('Open orgs');
    expect(metric.patch.filters).toEqual([{ key: 'status', op: 'is', value: 'c1' }]);
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
