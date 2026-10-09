/**
 * Records + views client helpers. A "record" is a `tasks` row inside a
 * `boards` row acting as a database (`board.kind`). Views live in the
 * `views` collection. All writes go through `mutate()`.
 *
 * Pure logic (filters/sorts/grouping, tree checks, link ids, deps) is shared
 * with the worker via shared/{views,tree,deps,linkid}.ts.
 */
import { useLiveQuery } from 'dexie-react-hooks';
import { authStore } from './auth';
import { logActivity } from './activity';
import { db, type LocalRow } from './db';
import { mutate } from './sync/engine';
import { cmpOrder, orderBetween, uuid } from './utils';
import { columnIdFor, columnsOf, firstColumnId, lastColumnId, taskBoardId, type BoardColumn, type BoardRow, type TaskRow } from '../modules/boards/api';
import { fieldsOf, propKey, type FieldDef } from '../../shared/fields';
import { applyView as applyViewShared, type FieldKey, type ViewConfig, type ViewCtx, type ViewRow as SharedViewRow, type ViewType } from '../../shared/views';
import { checkReparent, descendants, MAX_DEPTH } from '../../shared/tree';
import { isRelationField, type RelationFieldDef } from './links';

export { isRelationField, type RelationFieldDef } from './links';
export { evalFilter, fieldValue, sortRecords } from '../../shared/views';
export type { FieldKey, Filter, SortSpec, ViewConfig, ViewCtx, ViewType } from '../../shared/views';
export { MAX_DEPTH as MAX_RECORD_DEPTH } from '../../shared/tree';
export { checkReparent, descendants, depthOf, subtreeHeight, wouldCreateCycle, wouldExceedDepth } from '../../shared/tree';

/** Dexie rows carry `_ts` alongside the shared shape. */
export interface DbViewRow extends SharedViewRow, LocalRow {}
export type ViewRow = DbViewRow;

/* ---------- database model ---------- */

export type BoardKind = 'tasks' | 'records';

export function boardKind(board: BoardRow | undefined | null): BoardKind {
  return board?.kind === 'records' ? 'records' : 'tasks';
}

export function isRecordsDb(board: BoardRow | undefined | null): boolean {
  return boardKind(board) === 'records';
}

export function recordNoun(board: BoardRow | undefined | null): string {
  return String(board?.recordNoun ?? (isRecordsDb(board) ? 'Record' : 'Task'));
}

export interface ShowBuiltins {
  assignee: boolean;
  due: boolean;
  priority: boolean;
}

export function showBuiltinsOf(board: BoardRow | undefined | null): ShowBuiltins {
  const sb = (board?.showBuiltins ?? {}) as Partial<ShowBuiltins>;
  const def = boardKind(board) === 'tasks';
  return {
    assignee: sb.assignee ?? def,
    due: sb.due ?? def,
    priority: sb.priority ?? def,
  };
}

/** Stages only exist when the database has columns (records DBs may have none). */
export function stagesOf(board: BoardRow | undefined | null): BoardColumn[] {
  const cols = board?.columns;
  return Array.isArray(cols) && cols.length > 0 ? (cols as BoardColumn[]) : [];
}

export function relationFields(board: BoardRow | undefined | null): RelationFieldDef[] {
  return fieldsOf(board).filter(isRelationField);
}

/* ---------- views ---------- */

export const VIEW_TYPE_LABELS: Record<ViewType, string> = {
  board: 'Board',
  table: 'Table',
  list: 'List',
  gallery: 'Gallery',
  calendar: 'Calendar',
  timeline: 'Timeline',
};

export function useViews(databaseId: string | undefined): DbViewRow[] {
  const rows = useLiveQuery(
    () => (databaseId ? db.collection('views').where('databaseId').equals(databaseId).toArray() : []),
    [databaseId],
    [],
  );
  return ((rows ?? []) as DbViewRow[]).filter((v) => !v.deleted).sort((a, b) => cmpOrder(a.order, b.order));
}

export function useAllViews(): DbViewRow[] {
  const rows = useLiveQuery(() => db.collection('views').toArray(), [], []);
  return ((rows ?? []) as DbViewRow[]).filter((v) => !v.deleted);
}

const viewPrefKey = (dbId: string) => `ws_view_${dbId}`;

/** Implicit default view when a database has none (never persisted until edited). */
export function implicitView(board: BoardRow): DbViewRow {
  const type: ViewType = isRecordsDb(board) ? 'table' : 'board';
  return {
    id: '',
    databaseId: board.id,
    name: VIEW_TYPE_LABELS[type],
    type,
    order: '',
    config: { showSubrecords: type === 'table' },
    _ts: {},
  } as DbViewRow;
}

/**
 * Active view: explicit viewId → per-user localStorage → board.defaultViewId
 * → first view → implicit default.
 */
export function resolveView(board: BoardRow, views: DbViewRow[], viewIdParam?: string): DbViewRow {
  if (viewIdParam) {
    const v = views.find((x) => x.id === viewIdParam);
    if (v) return v;
  }
  const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(viewPrefKey(board.id)) : null;
  if (stored) {
    const v = views.find((x) => x.id === stored);
    if (v) return v;
  }
  if (board.defaultViewId) {
    const v = views.find((x) => x.id === board.defaultViewId);
    if (v) return v;
  }
  if (views.length) return views[0];
  return implicitView(board);
}

/** Persist a per-user view choice (null clears). */
export function rememberView(databaseId: string, viewId: string | null): void {
  try {
    if (viewId) localStorage.setItem(viewPrefKey(databaseId), viewId);
    else localStorage.removeItem(viewPrefKey(databaseId));
  } catch {
    /* storage unavailable */
  }
}

export async function createView(databaseId: string, type: ViewType, name?: string, config?: ViewConfig): Promise<string> {
  const views = ((await db.collection('views').where('databaseId').equals(databaseId).toArray()) as DbViewRow[]).filter((v) => !v.deleted).sort((a, b) => cmpOrder(a.order, b.order));
  const id = uuid();
  const me = authStore.get().user;
  await mutate('views', id, {
    databaseId,
    name: name?.trim() || VIEW_TYPE_LABELS[type],
    type,
    order: orderBetween(views.length ? String(views[views.length - 1].order ?? '') || null : null, null),
    config: config ?? {},
    createdBy: me?.id ?? null,
    createdAt: Date.now(),
  });
  return id;
}

export async function updateView(id: string, patch: { name?: string; config?: ViewConfig; type?: ViewType }): Promise<void> {
  await mutate('views', id, patch as Record<string, unknown>);
}

export async function deleteView(view: DbViewRow): Promise<void> {
  await mutate('views', view.id, { deleted: true });
  rememberView(String(view.databaseId), null);
}

/**
 * Persist edits made against an implicit view: creates the first explicit
 * view with the merged config and returns its id. Real views are patched.
 */
export async function persistViewConfig(board: BoardRow, view: DbViewRow, config: ViewConfig): Promise<string> {
  if (view.id) {
    await updateView(view.id, { config });
    return view.id;
  }
  return createView(board.id, view.type ?? 'table', view.name, config);
}

/* ---------- field keys ---------- */

export function fieldKeyOf(field: FieldDef): FieldKey {
  return field.type === 'relation' ? `rel_${field.id}` : `p_${field.id}`;
}

/** Top-level record key holding a custom field's value. */
export function propKeyOf(field: FieldDef): string {
  return propKey(field.id);
}

export function fieldKeyLabel(board: BoardRow | undefined | null, key: FieldKey): string {
  const builtin: Record<string, string> = {
    title: 'Title',
    status: 'Stage',
    assigneeId: 'Assignee',
    dueDate: 'Due date',
    priority: 'Priority',
    createdAt: 'Created',
    createdBy: 'Created by',
  };
  if (builtin[key]) return builtin[key];
  const fid = key.replace(/^p_|^rel_/, '');
  return fieldsOf(board).find((f) => f.id === fid)?.name ?? key;
}

/** Ordered field keys a view can display/edit. */
export function availableFieldKeys(board: BoardRow | undefined | null): FieldKey[] {
  const builtins = showBuiltinsOf(board);
  const keys: FieldKey[] = ['title'];
  if (stagesOf(board).length) keys.push('status');
  if (builtins.assignee) keys.push('assigneeId');
  if (builtins.due) keys.push('dueDate');
  if (builtins.priority) keys.push('priority');
  keys.push('createdAt', 'createdBy');
  for (const f of fieldsOf(board)) keys.push(fieldKeyOf(f));
  return keys;
}

/** Default visible columns when view.config.visible is unset. */
export function defaultVisibleKeys(board: BoardRow | undefined | null): FieldKey[] {
  const builtins = showBuiltinsOf(board);
  const keys: FieldKey[] = ['title'];
  if (stagesOf(board).length) keys.push('status');
  if (builtins.assignee) keys.push('assigneeId');
  if (builtins.due) keys.push('dueDate');
  if (builtins.priority) keys.push('priority');
  for (const f of fieldsOf(board)) keys.push(fieldKeyOf(f));
  return keys;
}

/** Human label for a group key ('' → 'No value', status → column name, select → option name). */
export function groupKeyLabel(board: BoardRow | undefined | null, key: FieldKey, raw: string): string {
  if (!raw) return 'No value';
  if (key === 'status') return stagesOf(board).find((c) => c.id === raw)?.name ?? raw;
  if (key === 'priority') {
    const p = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low', none: 'No priority' }[raw];
    return p ?? raw;
  }
  const fid = key.replace(/^p_|^rel_/, '');
  const f = fieldsOf(board).find((x) => x.id === fid);
  return f?.options?.find((o) => o.id === raw)?.name ?? raw;
}

/* ---------- view evaluation context ---------- */

import type { DbLinkRow } from './links';
import { relationValues } from './links';

export function viewCtx(board: BoardRow | undefined | null, tasks: readonly TaskRow[], links: readonly DbLinkRow[], meId: string | null | undefined, today: string): ViewCtx {
  const fieldsById: Record<string, FieldDef> = {};
  for (const f of fieldsOf(board)) fieldsById[f.id] = f;
  return {
    meId,
    today,
    fieldsById,
    columnsById: stagesOf(board).map((c) => c.id),
    relationTitles: (recordId, fieldId) => {
      const f = fieldsById[fieldId];
      if (!f || !isRelationField(f)) return [];
      return relationValues(links, recordId, f).map((id) => String(tasks.find((x) => x.id === id)?.title ?? 'Untitled'));
    },
  };
}

export function applyView(records: readonly TaskRow[], config: ViewConfig | undefined, ctx: ViewCtx): { rows: TaskRow[]; groups?: { key: string; rows: TaskRow[] }[] } {
  const r = applyViewShared(records, config ?? {}, ctx);
  return { rows: r.rows as TaskRow[], groups: r.groups?.map((g) => ({ key: g.key, rows: g.rows as TaskRow[] })) };
}

/* ---------- records ---------- */

export function useDbRecords(boardId: string | undefined): TaskRow[] {
  const all = useLiveQuery(() => db.tasks.toArray(), [], []);
  return ((all ?? []) as TaskRow[]).filter((t) => !t.deleted && (boardId ? taskBoardId(t) === boardId : true));
}

/** Direct children (sub-records) of a record, in order. */
export function childrenOf(tasks: TaskRow[], parentId: string): TaskRow[] {
  return tasks.filter((t) => !t.deleted && String(t.parentId ?? '') === parentId).sort((a, b) => cmpOrder(a.order, b.order));
}

export function recordTitle(rec: { title?: unknown } | undefined | null): string {
  return String(rec?.title ?? '') || 'Untitled';
}

export function buildParentMap(tasks: readonly { id: string; deleted?: unknown; parentId?: unknown }[]): Map<string, string | null> {
  const m = new Map<string, string | null>();
  for (const t of tasks) if (!t.deleted) m.set(t.id, (t.parentId as string | null) ?? null);
  return m;
}

export async function createRecord(
  databaseId: string,
  opts: { title?: string; status?: string | null; parentId?: string | null; extra?: Record<string, unknown> } = {},
): Promise<string> {
  const board = (await db.boards.get(databaseId)) as BoardRow | undefined;
  const cols = stagesOf(board);
  const status = opts.status !== undefined ? opts.status : cols.length ? cols[0].id : null;
  const siblings = (await db.tasks.toArray())
    .filter((t) => !t.deleted && taskBoardId(t) === databaseId)
    .sort((a, b) => cmpOrder(a.order, b.order));
  const id = uuid();
  const me = authStore.get().user;
  await mutate('tasks', id, {
    title: opts.title ?? '',
    description: '',
    boardId: databaseId,
    status,
    priority: 'none',
    assigneeId: null,
    dueDate: null,
    pageId: null,
    parentId: opts.parentId ?? null,
    order: orderBetween(siblings.length ? String(siblings[siblings.length - 1].order ?? '') || null : null, null),
    createdBy: me?.id ?? null,
    createdAt: Date.now(),
    ...(opts.extra ?? {}),
  });
  return id;
}

/** Validates same-database + shared checkReparent (cycle + depth ≤3), then writes parentId. */
export async function setParent(recordId: string, parentId: string | null): Promise<void> {
  const tasks = (await db.tasks.toArray()) as TaskRow[];
  const rec = tasks.find((t) => t.id === recordId);
  if (!rec || rec.deleted) throw new Error('Record not found');
  if (parentId) {
    const parent = tasks.find((t) => t.id === parentId && !t.deleted);
    if (!parent) throw new Error('Parent record not found');
    if (taskBoardId(parent) !== taskBoardId(rec)) throw new Error('Sub-records must live in the same database.');
    const check = checkReparent(buildParentMap(tasks), recordId, parentId);
    if (check === 'self' || check === 'cycle') throw new Error('Cannot nest a record under itself or its own descendant.');
    if (check === 'depth') throw new Error(`Sub-records can be nested at most ${MAX_DEPTH} levels.`);
  }
  await mutate('tasks', recordId, { parentId: parentId ?? null });
}

/** Soft-delete a record and cascade to live descendants (deletedVia = id). */
export async function deleteRecord(id: string): Promise<void> {
  const tasks = (await db.tasks.toArray()) as TaskRow[];
  const pm = buildParentMap(tasks);
  const rec = tasks.find((t) => t.id === id);
  await mutate('tasks', id, { deleted: true });
  for (const d of descendants(pm, id)) {
    const row = tasks.find((t) => t.id === d);
    if (row && !row.deleted) await mutate('tasks', d, { deleted: true, deletedVia: id });
  }
  if (rec) logActivity('deleted', 'task', id, String(rec.title ?? 'record'));
}

/** Restore a soft-deleted record and the descendants it took down (deletedVia = id). */
export async function restoreRecord(id: string): Promise<void> {
  const tasks = (await db.tasks.toArray()) as TaskRow[];
  const rec = tasks.find((t) => t.id === id);
  await mutate('tasks', id, { deleted: false });
  for (const t of tasks) {
    if (t.deleted && t.deletedVia === id) await mutate('tasks', t.id, { deleted: false, deletedVia: null });
  }
  if (rec) logActivity('restored', 'task', id, String(rec.title ?? 'record'));
}

/**
 * Move a record (and descendants) to another database. Lands at the end of
 * the target's first stage (status null when it has no stages). Relation
 * links under fields absent on the target DB are kept but hidden — the count
 * is returned.
 */
export async function moveRecordToDatabase(id: string, dbId: string): Promise<{ hiddenRelations: number }> {
  const target = (await db.boards.get(dbId)) as BoardRow | undefined;
  if (!target || target.deleted) throw new Error('Target database not found');
  const targetCols = stagesOf(target);
  const targetFieldIds = new Set(fieldsOf(target).map((f) => f.id));
  const tasks = (await db.tasks.toArray()) as TaskRow[];
  const rec = tasks.find((t) => t.id === id);
  if (!rec || rec.deleted) throw new Error('Record not found');
  const pm = buildParentMap(tasks);
  const moving = new Set([id, ...descendants(pm, id)]);
  const status = targetCols.length ? targetCols[0].id : null;
  const siblings = tasks.filter((t) => !t.deleted && taskBoardId(t) === dbId && !moving.has(t.id)).sort((a, b) => cmpOrder(a.order, b.order));
  let lastOrder = siblings.length ? String(siblings[siblings.length - 1].order ?? '') || null : null;
  for (const mid of moving) {
    const t = tasks.find((x) => x.id === mid)!;
    const order = orderBetween(lastOrder, null);
    lastOrder = order;
    await mutate('tasks', mid, {
      boardId: dbId,
      status: mid === id ? status : t.status,
      order,
      parentId: mid === id ? null : t.parentId,
    });
  }
  const links = (await db.collection('links').toArray()) as DbLinkRow[];
  let hidden = 0;
  for (const l of links) {
    if (l.deleted || l.kind !== 'relation' || !l.fieldId) continue;
    if ((moving.has(String(l.fromId)) || moving.has(String(l.toId))) && !targetFieldIds.has(String(l.fieldId))) hidden += 1;
  }
  logActivity('moved', 'task', id, String(rec.title ?? 'record'), { boardId: dbId });
  return { hiddenRelations: hidden };
}

/* ---------- relation field creation ---------- */

/**
 * Create a relation field on `dbId`. twoWay additionally creates the reverse
 * field on the target database, each pointing at the other; the field created
 * first is primary (links store its fieldId).
 */
export async function createRelationField(
  dbId: string,
  opts: { name: string; target: string; twoWay?: boolean; reverseName?: string; single?: boolean },
): Promise<{ fieldId: string; reverseFieldId?: string }> {
  const [a, b] = await Promise.all([db.boards.get(dbId), opts.target === 'pages' ? Promise.resolve(undefined) : db.boards.get(opts.target)]);
  const boardA = a as BoardRow | undefined;
  if (!boardA || boardA.deleted) throw new Error('Database not found');
  const boardB = b as BoardRow | undefined;
  if (opts.twoWay && opts.target !== 'pages' && (!boardB || boardB.deleted)) throw new Error('Target database not found');
  const fid = uuid().slice(0, 8);
  const rid = uuid().slice(0, 8);
  const fieldA: FieldDef = {
    id: fid,
    name: opts.name.trim() || 'Relation',
    type: 'relation',
    relation: {
      target: opts.target,
      pairedFieldId: opts.twoWay ? rid : null,
      single: opts.single ?? false,
      primary: true,
    },
  };
  await mutate('boards', dbId, { fields: [...fieldsOf(boardA), fieldA] });
  if (opts.twoWay && boardB && opts.target !== 'pages') {
    const fieldB: FieldDef = {
      id: rid,
      name: (opts.reverseName ?? boardA.name ?? 'Records').toString().trim() || 'Records',
      type: 'relation',
      relation: {
        target: dbId,
        pairedFieldId: fid,
        primary: false,
      },
    };
    await mutate('boards', opts.target, { fields: [...fieldsOf(boardB), fieldB] });
    return { fieldId: fid, reverseFieldId: rid };
  }
  return { fieldId: fid };
}

/* ---------- stage helpers on records ---------- */

export function recordStatus(rec: TaskRow, board: BoardRow | undefined | null): string | null {
  const cols = stagesOf(board);
  if (!cols.length) return null;
  return columnIdFor(rec, board);
}

export function recordIsDone(rec: TaskRow, board: BoardRow | undefined | null): boolean {
  const cols = stagesOf(board);
  if (!cols.length) return false;
  return columnIdFor(rec, board) === lastColumnId(board);
}

export { firstColumnId, lastColumnId, columnsOf };

/* ---------- Bundled template gallery (People & Organizations starter) ---------- */

export interface StarterTemplate {
  name: string;
  description?: string;
  icon?: string;
  databases?: Array<{
    id: string;
    name: string;
    icon?: string;
    kind?: string;
    recordNoun?: string;
    showBuiltins?: { assignee?: boolean; due?: boolean; priority?: boolean };
    columns?: BoardColumn[];
    fields?: FieldDef[];
    views?: Array<{ id: string; name: string; type: ViewType; config?: ViewConfig }>;
  }>;
  pages?: Array<{ id: string; title: string; icon?: string; blocks?: string[] }>;
}

export const STARTER_PEOPLE_ID = 'starter-people';

/** Idempotent install of a bundled template (remaps template-local db ids to fresh uuids). */
export async function installStarterTemplate(tpl: StarterTemplate): Promise<void> {
  const me = authStore.get().user;
  const now = Date.now();
  const dbIdMap = new Map<string, string>();
  for (const d of tpl.databases ?? []) dbIdMap.set(d.id, uuid());
  const remapFields = (fields: FieldDef[] = []): FieldDef[] =>
    fields.map((f) => ({
      ...f,
      relation: f.relation ? { ...f.relation, target: dbIdMap.get(String(f.relation.target)) ?? String(f.relation.target) } : f.relation,
    }));
  for (const d of tpl.databases ?? []) {
    const boardId = dbIdMap.get(d.id)!;
    await mutate('boards', boardId, {
      name: d.name,
      icon: d.icon ?? '',
      kind: d.kind === 'records' ? 'records' : 'tasks',
      recordNoun: d.recordNoun,
      showBuiltins: d.showBuiltins ?? { assignee: false, due: false, priority: false },
      columns: d.columns ?? [],
      fields: remapFields(d.fields),
      order: orderBetween(null, null),
      createdAt: now,
      createdBy: me?.id,
    });
    for (const v of d.views ?? []) {
      await mutate('views', uuid(), {
        databaseId: boardId,
        name: v.name,
        type: v.type,
        order: orderBetween(null, null),
        config: v.config ?? {},
        createdAt: now,
        createdBy: me?.id,
      });
    }
  }
  for (const pg of tpl.pages ?? []) {
    const pageId = uuid();
    await mutate('pages', pageId, { title: pg.title, icon: pg.icon ?? '', parentId: null, order: orderBetween(null, null), createdAt: now });
    let prev: string | null = null;
    for (const md of pg.blocks ?? []) {
      const embedDb = md.match(/^Embed:\s*(\S+)/);
      const blockId = uuid();
      prev = orderBetween(prev, null);
      if (embedDb) {
        const bid = dbIdMap.get(embedDb[1]);
        if (!bid) continue;
        await mutate('blocks', blockId, { pageId, type: 'tasks', boardId: bid, order: prev });
      } else {
        const { markdownToBlocks } = await import('../../shared/markdown');
        for (const r of markdownToBlocks(md)) {
          prev = orderBetween(prev, null);
          await mutate('blocks', uuid(), { ...r, pageId, order: prev } as Record<string, unknown>);
        }
      }
    }
  }
}
