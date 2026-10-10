/* Agent F (Verification) — Phase 3 unit coverage per the phase-3-implementation §8
 * test plan. Independent verification of the shared engine: archive visibility,
 * aggregate, calendar-source merge (pure layer), My-Work grouping (pure layer),
 * planner reuse/remap/packInstall, install preview, reusable-board matching,
 * conversion planner, archive patch, and dashboard-block config pass-through. */

import { describe, expect, it } from 'vitest';
import { aggregate, applyView, type Filter, type ViewCtx, type ViewRecord } from '../shared/views';
import { archivePatch, isArchived, ARCHIVED_LABEL } from '../shared/archive';
import { planConversion } from '../shared/conversion';
import { planTemplateInstantiation } from '../shared/templates';
import { findReusableBoards, planInstallPreview, toBundled, type AuthorTemplate } from '../shared/bundled';
import { linkId } from '../shared/linkid';
import rawPack from '../templates/tcg-pack.json';

const ctx: ViewCtx = { meId: 'u-me', today: '2026-10-10' };
const rec = (id: string, data: Record<string, unknown>): ViewRecord => ({ id, ...data });

let seq = 0;
const nid = () => `n${(++seq).toString(36)}`;
const NOW = 1_800_000_000_000;

/* ---------------- archive visibility in applyView ---------------- */
describe('applyView — archived vs deleted visibility', () => {
  const rows = [
    rec('a', { title: 'Active' }),
    rec('b', { title: 'Shelved', archived: true }),
    rec('c', { title: 'Unarchived', archived: false }),
    rec('d', { title: 'ArchivedAndDeleted', archived: true, deleted: true }),
    rec('e', { title: 'DeletedOnly', deleted: true }),
  ];

  it('archived === true rows drop by default; archived:false and absent stay', () => {
    expect(applyView(rows, {}, ctx).rows.map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('includeArchived:true keeps archived rows but still drops deleted ones', () => {
    expect(applyView(rows, { includeArchived: true }, ctx).rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('archived and deleted are independent flags — both filter separately', () => {
    // b is archived-only (hidden by archive rule), e is deleted-only (hidden by delete rule),
    // d carries both and is excluded under either rule.
    const inc = applyView(rows, { includeArchived: true }, ctx).rows.map((r) => r.id);
    expect(inc).not.toContain('d');
    expect(inc).not.toContain('e');
  });
});

/* ---------------- aggregate ---------------- */
describe('aggregate — count/sum/avg edge cases', () => {
  const rows = [
    rec('a', { title: 'A', status: 'c-todo', p_amount: 10 }),
    rec('b', { title: 'B', status: 'c-todo', p_amount: '30' }), // numeric string coerces
    rec('c', { title: 'C', status: 'c-done', p_amount: 'abc' }), // non-numeric string skipped
    rec('d', { title: 'D', status: 'c-done', p_amount: null }),
    rec('e', { title: 'E', status: 'c-done' }), // missing field
    rec('f', { title: 'F', status: 'c-done', p_amount: '' }),
    rec('g', { title: 'G', status: 'c-done', deleted: true, p_amount: 100 }),
    rec('h', { title: 'H', status: 'c-done', archived: true, p_amount: 1000 }),
  ];

  it('ids is exactly the filtered row set (length == count)', () => {
    const res = aggregate(rows, { agg: 'count' }, ctx);
    expect(res.ids).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(res.ids).toHaveLength(res.count);
    expect(res.value).toBe(res.count);
  });

  it('sum coerces numeric strings, skips null/empty/non-numeric/missing', () => {
    const res = aggregate(rows, { agg: 'sum', fieldKey: 'p_amount' }, ctx);
    expect(res.value).toBe(40); // 10 + '30'
    expect(res.numericCount).toBe(2);
    expect(res.count).toBe(6);
  });

  it('avg over numeric subset; null when no numeric rows or empty set', () => {
    expect(aggregate(rows, { agg: 'avg', fieldKey: 'p_amount' }, ctx).value).toBeCloseTo(20);
    const empty = aggregate(rows, { agg: 'avg', fieldKey: 'p_amount', filters: [{ key: 'title', op: 'is', value: 'zzz' }] }, ctx);
    expect(empty).toMatchObject({ value: null, count: 0, numericCount: 0, ids: [] });
  });

  it('sum on a fully-empty set is 0, not null', () => {
    const res = aggregate(rows, { agg: 'sum', fieldKey: 'p_amount', filters: [{ key: 'title', op: 'is', value: 'zzz' }] }, ctx);
    expect(res.value).toBe(0);
  });

  it('aggregating with includeArchived-style filters behaves like applyView', () => {
    // aggregate has no includeArchived flag — archived rows always drop,
    // matching default query_records behavior.
    const res = aggregate(rows, { agg: 'sum', fieldKey: 'p_amount' }, ctx);
    expect(res.ids).not.toContain('h');
    expect(res.value).toBe(40);
  });
});

/* ---------------- unified calendar merge (pure layer) ----------------
 * The calendar block merges several sources {databaseId, dateKey, filters}.
 * No client merge helper exists on this branch (C-track), so this asserts the
 * pure eval layer each source relies on: per-source applyView + dateKey
 * bucketing yields one keyed day→records map across databases. */
describe('calendar block — multi-source merge semantics (pure layer)', () => {
  const tasksDb = [
    rec('t1', { boardId: 'db_tasks', title: 'Fix roof', dueDate: '2026-10-10' }),
    rec('t2', { boardId: 'db_tasks', title: 'Old chore', dueDate: '2026-10-08' }),
    rec('t3', { boardId: 'db_tasks', title: 'No date' }),
  ];
  const eventsDb = [
    rec('ev1', { boardId: 'db_events', title: 'Market day', p_fdate: '2026-10-10' }),
    rec('ev2', { boardId: 'db_events', title: 'Gala', p_fdate: '2026-10-20', p_fkind: 'internal' }),
  ];

  const mergeSources = (sources: { records: ViewRecord[]; dateKey: string; filters?: Filter[] }[]) => {
    const days = new Map<string, string[]>();
    for (const s of sources) {
      for (const r of applyView(s.records, { filters: s.filters }, ctx).rows) {
        const d = String(r[s.dateKey] ?? '');
        if (!d) continue;
        days.set(d, [...(days.get(d) ?? []), String(r.id)]);
      }
    }
    return days;
  };

  it('records from several databases bucket under their own dateKey values', () => {
    const days = mergeSources([
      { records: tasksDb, dateKey: 'dueDate' },
      { records: eventsDb, dateKey: 'p_fdate' },
    ]);
    expect(days.get('2026-10-10')?.sort()).toEqual(['ev1', 't1']);
    expect(days.get('2026-10-08')).toEqual(['t2']);
    expect([...days.keys()]).not.toContain('');
    expect(days.get('2026-10-20')).toEqual(['ev2']);
  });

  it('per-source filters apply before bucketing', () => {
    const days = mergeSources([
      { records: eventsDb, dateKey: 'p_fdate', filters: [{ key: 'p_fkind', op: 'is_not', value: 'internal' }] },
    ]);
    expect(days.get('2026-10-20')).toBeUndefined();
    expect(days.get('2026-10-10')).toEqual(['ev1']);
  });
});

/* ---------------- My Work grouping (pure layer) ----------------
 * Overdue = dueDate < today; today = dueDate == today; upcoming = > today.
 * `mine` scopes to the current user's rows. */
describe('mywork block — overdue/today/upcoming boundaries (pure layer)', () => {
  const rows = [
    rec('m1', { title: 'Overdue', dueDate: '2026-10-09', assigneeId: 'u-me' }),
    rec('m2', { title: 'Today', dueDate: '2026-10-10', assigneeId: 'u-me' }),
    rec('m3', { title: 'Upcoming', dueDate: '2026-10-11', assigneeId: 'u-me' }),
    rec('m4', { title: 'No date', assigneeId: 'u-me' }),
    rec('m5', { title: 'Someone else overdue', dueDate: '2026-10-01', assigneeId: 'u-bob' }),
  ];
  const overdue: Filter = { key: 'dueDate', op: 'before', value: '2026-10-10' };
  const today: Filter = { key: 'dueDate', op: 'is', value: '2026-10-10' };
  const upcoming: Filter = { key: 'dueDate', op: 'after', value: '2026-10-10' };

  it('boundary partition is exact and non-overlapping', () => {
    expect(applyView(rows, { filters: [overdue] }, ctx).rows.map((r) => r.id)).toEqual(['m1', 'm5']);
    expect(applyView(rows, { filters: [today] }, ctx).rows.map((r) => r.id)).toEqual(['m2']);
    expect(applyView(rows, { filters: [upcoming] }, ctx).rows.map((r) => r.id)).toEqual(['m3']);
    // no-date rows fall into none of the three buckets
    for (const f of [overdue, today, upcoming]) {
      expect(applyView(rows, { filters: [f] }, ctx).rows.map((r) => r.id)).not.toContain('m4');
    }
  });

  it('mine:true restricts every bucket to the current user', () => {
    const cfg = { mine: true, filters: [overdue] };
    expect(applyView(rows, cfg, ctx).rows.map((r) => r.id)).toEqual(['m1']);
  });
});

/* ---------------- planner: packInstall / reuseBoards / viewMap / preserveTemplates ---------------- */
const mini: AuthorTemplate = {
  name: 'Mini Pack',
  description: 'd',
  icon: '🧪',
  databases: [
    {
      id: 'db_projects', key: 'projects', name: 'Projects', kind: 'records',
      columns: [{ id: 'c_open', name: 'Open' }],
      fields: [
        { id: 'f_org', name: 'Org', type: 'relation', relation: { target: 'db_orgs' } },
        { id: 'f_amt', name: 'Amount', type: 'number' },
      ],
      captureTargets: [{ kind: 'expense', databaseId: 'db_txn' }],
      fieldActions: ['expense', 'note'],
      views: [{ id: 'v_pj', name: 'All', type: 'table' }],
      records: [{ id: 'r_one', title: 'One', props: { p_f_amt: 5 } }],
    },
    { id: 'db_orgs', key: 'organizations', name: 'Organizations', kind: 'records' },
    { id: 'db_txn', key: 'transactions', name: 'Transactions', kind: 'records' },
    { id: 'db_people', key: 'people', name: 'People', kind: 'records' },
  ],
  pages: [
    {
      id: 'pg_home', title: 'Home', blocks: [
        { type: 'metric', databaseId: 'db_txn', agg: 'sum', fieldKey: 'p_f_amt', label: 'Spend' },
        { type: 'calendar', sources: [{ databaseId: 'db_projects', dateKey: 'dueDate' }, { databaseId: 'db_txn', dateKey: 'p_fdate' }] },
        { type: 'view', databaseId: 'db_projects', viewId: 'v_pj', inline: { includeArchived: true } },
      ],
    },
    { id: 'pg_tpl', title: 'Review', template: true, parentId: 'pg_home', blocks: [{ type: 'h2', text: 'Q?' }] },
  ],
  links: [{ from: 'pg_home', to: 'r_one', kind: 'related' }],
};

describe('planner — packInstall whole-set semantics', () => {
  const bundle = toBundled('mini', mini);

  it('copies every database/page/record/view, not just the root subtree', () => {
    const plan = planTemplateInstantiation(bundle.snapshot, { templateId: 'pg_home', templateKey: 'mini', packInstall: true, preserveTemplates: true, actorId: 'u' }, { id: nid, now: NOW })!;
    const boards = plan.writes.filter((w) => w.collection === 'boards');
    expect(boards).toHaveLength(4); // all four authored dbs, incl. ones no block references
    const pages = plan.writes.filter((w) => w.collection === 'pages');
    expect(pages).toHaveLength(2);
    expect(pages.find((p) => p.patch.isTemplate === true)).toBeTruthy(); // preserveTemplates
    expect(plan.writes.filter((w) => w.collection === 'views')).toHaveLength(1);
    expect(plan.writes.filter((w) => w.collection === 'tasks')).toHaveLength(1);
    expect(plan.writes.filter((w) => w.collection === 'links')).toHaveLength(1);
  });

  it('reuseBoards: live board keeps id; relations/blocks/captureTargets/views remap to it', () => {
    const plan = planTemplateInstantiation(bundle.snapshot, {
      templateId: 'pg_home', templateKey: 'mini', packInstall: true,
      reuseBoards: { db_orgs: 'LIVE_ORGS', db_people: 'LIVE_PEOPLE' },
    }, { id: nid, now: NOW })!;

    // no board writes for reused dbs
    const boardWrites = plan.writes.filter((w) => w.collection === 'boards');
    expect(boardWrites.map((w) => w.id)).not.toContain('LIVE_ORGS');
    expect(boardWrites).toHaveLength(2); // only projects + txn created
    const pj = boardWrites.find((w) => w.patch.templateDbKey === 'projects')!;
    // relation target db_orgs remapped to the live board id
    const orgField = (pj.patch.fields as { id: string; relation?: { target: string } }[]).find((f) => f.id === 'f_org')!;
    expect(orgField.relation?.target).toBe('LIVE_ORGS');
    // captureTargets authored id remapped to the NEW txn board id
    const txn = boardWrites.find((w) => w.patch.templateDbKey === 'transactions')!;
    expect((pj.patch.captureTargets as { databaseId: string }[])[0].databaseId).toBe(txn.id);
    // block databaseId remaps (metric → txn id; view → projects id)
    const metric = plan.writes.find((w) => w.collection === 'blocks' && w.patch.type === 'metric')!;
    expect(metric.patch.databaseId).toBe(txn.id);
    // calendar sources[].databaseId remap
    const cal = plan.writes.find((w) => w.collection === 'blocks' && w.patch.type === 'calendar')!;
    const srcDbs = (cal.patch.sources as { databaseId: string }[]).map((s) => s.databaseId);
    expect(srcDbs).toEqual([pj.id, txn.id]);
    // viewMap: view block viewId → the new view row id (not authored 'v_pj')
    const viewWrite = plan.writes.find((w) => w.collection === 'views')!;
    const viewBlock = plan.writes.find((w) => w.collection === 'blocks' && w.patch.type === 'view')!;
    expect(viewBlock.patch.viewId).toBe(viewWrite.id);
    expect(viewWrite.patch.databaseId).toBe(pj.id);
    // inline config (includeArchived) passes through verbatim
    expect(viewBlock.patch.inline).toEqual({ includeArchived: true });
  });

  it('second install is idempotent: keyed boards all reuse → zero db/view/record writes', () => {
    // simulate boards installed by the first run (templateDbKey stamped)
    const installed = [
      { id: 'L1', templateDbKey: 'projects' },
      { id: 'L2', templateDbKey: 'organizations' },
      { id: 'L3', templateDbKey: 'transactions' },
      { id: 'L4', templateDbKey: 'people' },
    ];
    const reuseMap = findReusableBoards(installed, mini);
    expect(reuseMap).toEqual({ db_projects: 'L1', db_orgs: 'L2', db_txn: 'L3', db_people: 'L4' });
    const plan = planTemplateInstantiation(bundle.snapshot, {
      templateId: 'pg_home', templateKey: 'mini', packInstall: true, reuseBoards: reuseMap,
    }, { id: nid, now: NOW })!;
    expect(plan.writes.filter((w) => w.collection === 'boards')).toHaveLength(0);
    expect(plan.writes.filter((w) => w.collection === 'views')).toHaveLength(0);
    expect(plan.writes.filter((w) => w.collection === 'tasks')).toHaveLength(0);
    // pages/blocks still copy (a second install re-adds pages; dedupe lives on boards)
    expect(plan.writes.filter((w) => w.collection === 'pages').length).toBeGreaterThan(0);
    const preview = planInstallPreview(bundle, installed);
    expect(preview.databases.create).toHaveLength(0);
    expect(preview.databases.reuse).toHaveLength(4);
    expect(preview.records).toBe(0);
    expect(preview.views).toBe(0);
  });
});

describe('planInstallPreview — create vs reuse counts', () => {
  const bundle = toBundled('mini', mini);

  it('fresh workspace: everything creates', () => {
    const p = planInstallPreview(bundle, []);
    expect(p.databases.create.sort()).toEqual(['Organizations', 'People', 'Projects', 'Transactions'].sort());
    expect(p.databases.reuse).toEqual([]);
    expect(p.records).toBe(1);
    expect(p.views).toBe(1);
    expect(p.pages).toBe(2);
  });

  it('keyed dbs reuse by templateDbKey; starter-people falls back by name', () => {
    const p = planInstallPreview(bundle, [
      { id: 'K1', templateDbKey: 'projects' },
      { id: 'K2', templateKey: 'starter-people', name: 'People' }, // name fallback (people only)
      { id: 'K3', templateKey: 'starter-people', name: 'Transactions' }, // same name, wrong key → NOT reused
    ]);
    expect(p.databases.reuse.sort()).toEqual(['People', 'Projects'].sort());
    expect(p.databases.create.sort()).toEqual(['Organizations', 'Transactions'].sort());
  });
});

describe('findReusableBoards', () => {
  it('templateDbKey match wins over everything else', () => {
    const hit = findReusableBoards([{ id: 'A', templateDbKey: 'projects', name: 'Totally Different' }], mini);
    expect(hit.db_projects).toBe('A');
  });

  it('deleted live boards never match', () => {
    expect(findReusableBoards([{ id: 'A', templateDbKey: 'projects', deleted: true }], mini)).toEqual({});
  });
});

/* ---------------- conversion ---------------- */
describe('planConversion — idea → project', () => {
  const srcBoard = {
    id: 'db_ideas', name: 'Ideas',
    columns: [{ id: 'c_cap', name: 'Captured' }, { id: 'c_conv', name: 'Converted' }],
    fields: [
      { id: 'f_theme', name: 'Theme', type: 'text' },
      { id: 'f_impact', name: 'Impact', type: 'select' },
      { id: 'f_note', name: 'Note', type: 'text' },
    ],
  };
  const destBoard = {
    id: 'db_projects', name: 'Projects',
    columns: [{ id: 'c_idea', name: 'Idea' }, { id: 'c_active', name: 'Active' }],
    fields: [
      { id: 'f_theme', name: 'Theme', type: 'text' },   // same id+type → carried
      { id: 'f_impact', name: 'Impact', type: 'text' }, // type mismatch → warning+drop
      // f_note absent → warning+drop
    ],
  };
  const src = {
    id: 'r_idea', boardId: 'db_ideas', title: 'Water tower', description: 'desc',
    status: 'c_cap', p_f_theme: 'infrastructure', p_f_impact: 'high', p_f_note: 'x', assigneeId: 'u1',
  };

  it('happy path: dest record + link + stage patch, field carry-over rules', () => {
    const res = planConversion({ src, srcBoard, destBoard, sourceStage: 'c_conv', actorId: 'u-me' }, { id: nid, now: NOW });
    if ('error' in res) throw new Error(res.error);
    const [dest, link, stage] = res.ops;
    expect(dest.patch).toMatchObject({
      boardId: 'db_projects', title: 'Water tower', status: 'c_idea',
      convertedFrom: 'r_idea', p_f_theme: 'infrastructure', createdAt: NOW,
    });
    expect(dest.patch.p_f_impact).toBeUndefined();
    expect(dest.patch.p_f_note).toBeUndefined();
    expect(dest.patch.assigneeId).toBeUndefined(); // builtins don't carry
    expect(link.patch).toMatchObject({ fromId: res.destId, toId: 'r_idea', kind: 'related', fieldId: null });
    expect(link.id).toBe(linkId('related', null, res.destId, 'r_idea'));
    expect(stage).toMatchObject({ collection: 'tasks', id: 'r_idea', patch: { status: 'c_conv' } });
    expect(res.warnings.join(' ')).toContain('f_impact');
    expect(res.warnings.join(' ')).toContain('f_note');
  });

  it('destId comes from the injected id source — deterministic replay', () => {
    const mk = () => planConversion({ src, srcBoard, destBoard }, { id: () => 'FIXED', now: NOW });
    const a = mk(); const b = mk();
    if ('error' in a || 'error' in b) throw new Error('unexpected');
    expect(a.destId).toBe('FIXED');
    expect(a.ops[1].id).toBe(b.ops[1].id); // link id is content-derived → identical on replay
    expect(a).toEqual(b); // same input+deps → byte-identical plan (pure dry-run shape)
  });

  it('error cases: bad dest, bad src, invalid stage', () => {
    expect(planConversion({ src, srcBoard, destBoard: null as never }, { id: nid, now: NOW })).toEqual({ error: 'destination database not found' });
    expect(planConversion({ src, srcBoard, destBoard: { data: null } as never }, { id: nid, now: NOW })).toEqual({ error: 'destination database has no id' });
    expect(planConversion({ src: null as never, srcBoard, destBoard }, { id: nid, now: NOW })).toEqual({ error: 'source record not found' });
    expect(planConversion({ src, srcBoard, destBoard, sourceStage: 'ghost' }, { id: nid, now: NOW })).toEqual({ error: "unknown stage 'ghost' for source board" });
  });

  it('convertedFrom marker is what the worker dedupes on (replay → alreadyConverted)', () => {
    // The planner stamps convertedFrom:srcId — the worker's dedupe lookup
    // (live dest record with convertedFrom===srcId → alreadyConverted) keys off it.
    const res = planConversion({ src, srcBoard, destBoard }, { id: nid, now: NOW });
    if ('error' in res) throw new Error(res.error);
    expect(res.ops[0].patch.convertedFrom).toBe('r_idea');
  });
});

/* ---------------- archive patch helpers ---------------- */
describe('archive helpers', () => {
  it('archivePatch emits strict booleans', () => {
    expect(archivePatch(true)).toEqual({ archived: true });
    expect(archivePatch(false)).toEqual({ archived: false });
    expect(archivePatch(1 as never)).toEqual({ archived: false }); // coerces to strict bool
  });

  it('isArchived strict-true on flat and {data} rows only', () => {
    expect(isArchived({ archived: true })).toBe(true);
    expect(isArchived({ data: { archived: true } })).toBe(true);
    expect(isArchived({ archived: 'yes' })).toBe(false);
    expect(isArchived({})).toBe(false);
    expect(ARCHIVED_LABEL).toBe('Archived');
  });
});

/* ---------------- dashboard block config pass-through (responsive pure layer) ----------------
 * No client container-width helper exists on this branch (C-track). The pure
 * layer that IS verifiable: block config fields survive toBundled and the
 * planner verbatim (incl. inline ViewConfig that carries responsive/
 * includeArchived behavior down to the renderer). */
describe('dashboard blocks — config fields pass through author→snapshot→plan', () => {
  const bundle = toBundled('mini', mini);

  it('toBundled keeps metric/calendar/view config verbatim (authored ids)', () => {
    const blocks = Object.values(bundle.snapshot.blocks).filter((b) => b.pageId === 'pg_home');
    expect(blocks.find((b) => b.type === 'metric')).toMatchObject({
      databaseId: 'db_txn', agg: 'sum', fieldKey: 'p_f_amt', label: 'Spend',
    });
    expect(blocks.find((b) => b.type === 'view')).toMatchObject({
      databaseId: 'db_projects', viewId: 'v_pj', inline: { includeArchived: true },
    });
    const cal = blocks.find((b) => b.type === 'calendar')!;
    expect(cal.sources).toHaveLength(2);
  });

  it('real tcg-pack: every dashboard block type survives the full install plan', () => {
    const pack = toBundled('tcg-pack', rawPack as unknown as AuthorTemplate);
    const plan = planTemplateInstantiation(pack.snapshot, { templateId: pack.root, templateKey: 'tcg-pack', packInstall: true, preserveTemplates: true }, { id: nid, now: NOW })!;
    const dash = plan.writes.filter((w) => w.collection === 'blocks' && ['view', 'metric', 'calendar', 'activity', 'mywork'].includes(String(w.patch.type)));
    const types = new Set(dash.map((w) => String(w.patch.type)));
    for (const t of ['view', 'metric', 'calendar', 'activity', 'mywork']) {
      expect(types.has(t), `missing dashboard block type '${t}' in tcg-pack plan`).toBe(true);
    }
    // no block retains an authored db_ id anywhere in its config
    for (const w of dash) {
      expect(JSON.stringify(w.patch)).not.toMatch(/db_[a-z0-9_]+/);
    }
  });
});
