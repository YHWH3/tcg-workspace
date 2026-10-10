import { describe, expect, it } from 'vitest';
import { findReusableBoards, planInstallPreview, toBundled, type AuthorTemplate } from '../shared/bundled';

const pack: AuthorTemplate = {
  name: 'TCG Pack',
  description: 'd',
  icon: '🧭',
  databases: [
    {
      id: 'db_projects',
      key: 'projects',
      name: 'Projects',
      icon: '📁',
      kind: 'records',
      columns: [{ id: 'c_active', name: 'Active', color: '#30a46c' }],
      fields: [
        { id: 'f_budget', name: 'Budget', type: 'number' },
        { id: 'f_org', name: 'Org', type: 'relation', relation: { target: 'db_orgs', pairedFieldId: 'f_projects' } },
      ],
      captureTargets: [
        { kind: 'observation', databaseId: 'db_fieldlog' },
        { kind: 'expense', databaseId: 'db_txn' },
      ],
      fieldActions: ['observation', 'expense', 'task', 'note'],
      views: [{ id: 'v_projects', name: 'All projects', type: 'table', config: { visible: ['title'] } }],
      records: [
        { id: 'r_parambu', title: 'Parambu Habitat', status: 'c_active', props: { p_f_budget: 500 }, body: ['HQ site', 'second line'] },
      ],
    },
    {
      id: 'db_orgs',
      key: 'organizations',
      name: 'Organizations',
      kind: 'records',
      fields: [{ id: 'f_projects', name: 'Projects', type: 'relation', relation: { target: 'db_projects', pairedFieldId: 'f_org' } }],
    },
    { id: 'db_fieldlog', name: 'Field Log', kind: 'records' },
    { id: 'db_txn', name: 'Transactions', kind: 'records' },
  ],
  pages: [
    {
      id: 'pg_home',
      title: 'Home',
      icon: '🏠',
      blocks: [
        '# Welcome',
        'Embed: db_projects',
        { type: 'view', databaseId: 'db_projects', viewId: 'v_projects', inline: { includeArchived: true }, limit: 5, heading: 'Projects' },
        { type: 'metric', databaseId: 'db_txn', agg: 'sum', fieldKey: 'p_f_amount', label: 'Spend', format: 'currency' },
        { type: 'calendar', sources: [{ databaseId: 'db_projects', dateKey: 'dueDate', color: '#00f' }] },
        { type: 'activity', scope: 'all', limit: 10 },
        { type: 'mywork' },
        { type: 'todo', text: 'check me', checked: true },
      ],
    },
    { id: 'pg_review', title: 'Project Review', template: true, parentId: 'pg_home', blocks: [{ type: 'h2', text: 'What was planned?' }] },
  ],
  links: [
    { from: 'pg_home', to: 'r_parambu', kind: 'related' },
    { from: 'r_parambu', to: 'pg_review', kind: 'relation', fieldId: 'f_x' },
  ],
};

describe('toBundled — author format → snapshot', () => {
  const b = toBundled('tcg-pack', pack);

  it('carries key/captureTargets/fieldActions/defaultViewId on snapshot boards', () => {
    const board = b.snapshot.boards.db_projects;
    expect(board.key).toBe('projects'); // snapshot marker the planner stamps as templateDbKey
    expect(board.captureTargets).toEqual([
      { kind: 'observation', databaseId: 'db_fieldlog' },
      { kind: 'expense', databaseId: 'db_txn' },
    ]);
    expect(board.fieldActions).toEqual(['observation', 'expense', 'task', 'note']);
    expect(board.defaultViewId).toBe('v_projects');
  });

  it('authored records become tasks rows; body lines become record blocks', () => {
    const rec = b.snapshot.tasks.r_parambu;
    expect(rec).toMatchObject({ boardId: 'db_projects', title: 'Parambu Habitat', status: 'c_active', p_f_budget: 500 });
    const body = Object.values(b.snapshot.blocks).filter((x) => x.pageId === 'r_parambu');
    expect(body).toHaveLength(2);
    expect(body[0]).toMatchObject({ parentType: 'record', type: 'p', text: 'HQ site' });
  });

  it('string lines → text blocks; Embed: db_x → tasks block', () => {
    const pageBlocks = Object.values(b.snapshot.blocks).filter((x) => x.pageId === 'pg_home' && !x.parentType);
    const tasks = pageBlocks.filter((x) => x.type === 'tasks');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].boardId).toBe('db_projects');
    expect(pageBlocks.some((x) => x.type === 'p' && String(x.text).startsWith('# Welcome'))).toBe(true);
  });

  it('typed object blocks keep their dashboard configs verbatim (authored ids)', () => {
    const pageBlocks = Object.values(b.snapshot.blocks).filter((x) => x.pageId === 'pg_home' && !x.parentType);
    const byType = (t: string) => pageBlocks.find((x) => x.type === t)!;
    expect(byType('view')).toMatchObject({ databaseId: 'db_projects', viewId: 'v_projects', inline: { includeArchived: true }, limit: 5, heading: 'Projects' });
    expect(byType('metric')).toMatchObject({ databaseId: 'db_txn', agg: 'sum', fieldKey: 'p_f_amount', label: 'Spend', format: 'currency' });
    expect(byType('calendar').sources).toEqual([{ databaseId: 'db_projects', dateKey: 'dueDate', color: '#00f' }]);
    expect(byType('activity')).toMatchObject({ scope: 'all', limit: 10 });
    expect(byType('mywork').type).toBe('mywork');
    // 'todo' authored name maps to the stored 'todo' type; 'text' → 'p', 'bulleted' → 'bullet'
    expect(byType('todo')).toMatchObject({ text: 'check me', checked: true });
  });

  it('authored links land with deterministic ids and inferred from/to types', () => {
    const links = Object.values(b.snapshot.links ?? {});
    expect(links).toHaveLength(2);
    const rel = links.find((l) => l.kind === 'relation')!;
    expect(rel).toMatchObject({ fromId: 'r_parambu', toId: 'pg_review', fieldId: 'f_x', fromType: 'record', toType: 'page' });
    const related = links.find((l) => l.kind === 'related')!;
    expect(related).toMatchObject({ fromId: 'pg_home', toId: 'r_parambu', fromType: 'page', toType: 'record' });
  });

  it('authored page fields: parentId/template/order honored', () => {
    expect(b.snapshot.pages.pg_review).toMatchObject({ parentId: 'pg_home', isTemplate: true });
    expect(b.snapshot.pages.pg_home.isTemplate).toBe(false);
    expect(b.root).toBe('pg_home');
  });
});

describe('findReusableBoards', () => {
  it('matches live boards by templateDbKey === authored key', () => {
    const existing = [
      { id: 'live-1', templateDbKey: 'projects', name: 'Projects' },
      { id: 'live-2', templateDbKey: 'organizations', name: 'Organizations' },
    ];
    expect(findReusableBoards(existing, pack)).toEqual({ db_projects: 'live-1', db_orgs: 'live-2' });
  });

  it('falls back to starter-people templateKey + name for people/organizations only', () => {
    const existing = [
      { id: 'live-p', templateKey: 'starter-people', name: 'People' },
      { id: 'live-o', templateKey: 'starter-people', name: 'Organizations' },
      { id: 'live-x', templateKey: 'starter-people', name: 'Projects' }, // not a fallback key
    ];
    const author: AuthorTemplate = {
      name: 'x', description: '', icon: 'x',
      databases: [
        { id: 'db_people', key: 'people', name: 'People' },
        { id: 'db_orgs', key: 'organizations', name: 'Organizations' },
        { id: 'db_projects', key: 'projects', name: 'Projects' },
      ],
      pages: [],
    };
    expect(findReusableBoards(existing, author)).toEqual({ db_people: 'live-p', db_orgs: 'live-o' });
  });

  it('skips deleted boards and dbs without a key', () => {
    const existing = [{ id: 'dead', templateDbKey: 'projects', deleted: true }];
    expect(findReusableBoards(existing, pack)).toEqual({});
    const noKey: AuthorTemplate = { name: 'x', description: '', icon: 'x', databases: [{ id: 'db_a', name: 'A' }], pages: [] };
    expect(findReusableBoards([{ id: 'live', templateDbKey: 'a' }], noKey)).toEqual({});
  });
});

describe('planInstallPreview', () => {
  it('counts reflect the plan: reused dbs excluded from create/records/views, links need both ends inside', () => {
    const fresh = planInstallPreview(toBundled('tcg-pack', pack), []);
    expect(fresh).toEqual({
      databases: { create: ['Projects', 'Organizations', 'Field Log', 'Transactions'], reuse: [] },
      pages: 2,
      views: 1,
      links: 2,
      records: 1,
      blocks: 11, // 8 on pg_home + 1 on pg_review + 2 record-body blocks
      reused: { views: 0, records: 0 },
    });
    const reused = planInstallPreview(toBundled('tcg-pack', pack), [{ id: 'live-1', templateDbKey: 'projects' }]);
    expect(reused.databases).toEqual({ create: ['Organizations', 'Field Log', 'Transactions'], reuse: ['Projects'] });
    expect(reused.records).toBe(0); // r_parambu lives on reused db_projects
    expect(reused.views).toBe(0); // v_projects lives on the reused board
    expect(reused.reused).toEqual({ views: 1, records: 1 }); // the excluded content is accounted for
    expect(reused.links).toBe(0); // both authored links touch r_parambu — outside the copied set
    expect(reused.blocks).toBe(9); // page blocks still copy; r_parambu's body blocks don't
    expect(reused.pages).toBe(2);
  });

  it('views/records on shared databases (people/organizations keys) are reused-side, not creates', () => {
    const author: AuthorTemplate = {
      name: 'x', description: '', icon: 'x',
      databases: [
        { id: 'db_people', key: 'people', name: 'People', views: [{ id: 'v_p1', name: 'All people', type: 'table' }], records: [{ id: 'r_p1', title: 'Ada' }] },
        { id: 'db_orgs', key: 'organizations', name: 'Organizations', views: [{ id: 'v_o1', name: 'All orgs', type: 'table' }] },
        { id: 'db_projects', key: 'projects', name: 'Projects', views: [{ id: 'v_pr', name: 'All projects', type: 'table' }] },
      ],
      pages: [],
    };
    // Even on an empty workspace the shared dbs' views/records are reused-side
    // content — the shared bundle's lifecycle owns them; this pack only
    // bootstraps the board. Apply-side counts then match the preview in the
    // canonical flow (starter-people installed first) and on re-run.
    const p = planInstallPreview(toBundled('x', author), []);
    expect(p.databases.create).toEqual(['People', 'Organizations', 'Projects']); // boards still create when absent
    expect(p.views).toBe(1); // only the pack-owned db's view
    expect(p.records).toBe(0); // r_p1 sits on the shared db
    expect(p.reused).toEqual({ views: 2, records: 1 });
    // With the shared boards already installed (live-matched), same accounting.
    const withShared = planInstallPreview(toBundled('x', author), [
      { id: 'live-p', templateKey: 'starter-people', name: 'People' },
      { id: 'live-o', templateKey: 'starter-people', name: 'Organizations' },
    ]);
    expect(withShared.databases).toEqual({ create: ['Projects'], reuse: ['People', 'Organizations'] });
    expect(withShared.views).toBe(1);
    expect(withShared.records).toBe(0);
    expect(withShared.reused).toEqual({ views: 2, records: 1 });
  });
});
