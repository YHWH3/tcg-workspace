import { canRead } from '../shared/access';
import { scopeResolver, ScopeError, type RecordScope, type ScopeRecord } from '../shared/recordScope';
import { accessFence, loadAccessContext, MAX_ACCESS_SPACES, spaceAccess, type AccessContext } from './access';

export const MAX_SCOPE_GRAPH_RECORDS = 5000;
const MAX_RECORD_IDS = 500;

interface RawScopeRow { id: string; collection: string; data: string; space_id: string; seq: number }
interface RawStoredRow extends RawScopeRow { field_ts: string }
export interface ScopeGraphRecord extends ScopeRecord { rev: number }
export interface ScopedStoredRecord extends ScopeGraphRecord { fieldTs: Record<string, number> }
export interface ScopeGraph {
  generation: number;
  records: ReadonlyMap<string, ScopeGraphRecord>;
}
export class RecordAccessError extends Error {
  constructor(public readonly code: 'invalid_scope_request' | 'scope_graph_budget' | 'access_reset_required') {
    super(code); this.name = 'RecordAccessError';
  }
}

// UNION (not UNION ALL) deduplicates shared ancestors and terminates cycles.
// The indexed records.id join prevents a workspace-wide ancestry scan. Type
// validation is deliberately separate in the pure planner; a matching ID in
// the wrong collection must never grant authority.
const scopeProjection = (alias: string) => `json_object(
  'parentId',json_extract(${alias}.data,'$.parentId'),
  'boardId',json_extract(${alias}.data,'$.boardId'),
  'pageId',json_extract(${alias}.data,'$.pageId'),
  'databaseId',json_extract(${alias}.data,'$.databaseId'),
  'targetType',json_extract(${alias}.data,'$.targetType'),
  'targetId',json_extract(${alias}.data,'$.targetId'),
  'parentType',json_extract(${alias}.data,'$.parentType'),
  'thumbId',json_extract(${alias}.data,'$.thumbId'),
  'fromType',json_extract(${alias}.data,'$.fromType'),
  'fromId',json_extract(${alias}.data,'$.fromId'),
  'toType',json_extract(${alias}.data,'$.toType'),
  'toId',json_extract(${alias}.data,'$.toId'),
  'deleted',json(CASE WHEN json_extract(${alias}.data,'$.deleted')=1 THEN 'true' ELSE 'false' END),
  'trigger',json_object('databaseId',json_extract(${alias}.data,'$.trigger.databaseId'))
)`;
const graphSql = `WITH RECURSIVE scope_graph(id,collection,data,space_id,seq) AS (
  SELECT r.id,r.collection,${scopeProjection('r')},r.space_id,r.seq FROM records r
    WHERE id IN (SELECT value FROM json_each(?))
  UNION
  SELECT p.id,p.collection,${scopeProjection('p')},p.space_id,p.seq FROM scope_graph child
    JOIN records p ON p.id IN (SELECT value FROM json_each(
      CASE child.collection
        WHEN 'pages' THEN json_array(json_extract(child.data,'$.parentId'))
        WHEN 'tasks' THEN json_array(COALESCE(json_extract(child.data,'$.boardId'),'board-default'),json_extract(child.data,'$.parentId'))
        WHEN 'blocks' THEN json_array(json_extract(child.data,'$.pageId'))
        WHEN 'views' THEN json_array(json_extract(child.data,'$.databaseId'))
        WHEN 'mooditems' THEN json_array(json_extract(child.data,'$.boardId'))
        WHEN 'comments' THEN json_array(json_extract(child.data,'$.targetId'))
        WHEN 'activity' THEN json_array(json_extract(child.data,'$.targetId'))
        WHEN 'files' THEN json_array(json_extract(child.data,'$.parentId'))
        WHEN 'forms' THEN json_array(json_extract(child.data,'$.databaseId'))
        WHEN 'automations' THEN json_array(COALESCE(json_extract(child.data,'$.trigger.databaseId'),json_extract(child.data,'$.databaseId')))
        WHEN 'links' THEN json_array(json_extract(child.data,'$.fromId'),json_extract(child.data,'$.toId'))
        ELSE '[]' END))
) SELECT * FROM scope_graph LIMIT ?`;

function validateIds(ids: readonly string[]) {
  if (!Array.isArray(ids) || ids.length > MAX_RECORD_IDS || ids.some(id => typeof id !== 'string' || !id || id.length > 64)) {
    throw new RecordAccessError('invalid_scope_request');
  }
}

/** A coherent graph+epoch read, one binding batch and two SQL statements.
 * Graph JSON contains only ownership fields, never titles/bodies/claim hashes.
 * New mutation planners
 * can load additional destination/parent seeds before overlaying their plans. */
export async function loadScopeGraph(db: D1Database, ids: readonly string[]): Promise<ScopeGraph> {
  validateIds(ids);
  const [graph, state] = await db.batch([
    db.prepare(graphSql).bind(JSON.stringify([...new Set(ids)]), MAX_SCOPE_GRAPH_RECORDS + 1),
    db.prepare('SELECT generation FROM access_state WHERE id=1'),
  ]);
  const generation = (state.results[0] as { generation: number } | undefined)?.generation;
  if (!generation || !Number.isSafeInteger(generation)) throw new RecordAccessError('access_reset_required');
  if (graph.results.length > MAX_SCOPE_GRAPH_RECORDS) throw new RecordAccessError('scope_graph_budget');
  const records = new Map<string, ScopeGraphRecord>();
  for (const r of graph.results as unknown as RawScopeRow[]) {
    records.set(r.id, { id: r.id, collection: r.collection, data: JSON.parse(r.data), rootSpaceId: r.space_id, rev: r.seq });
  }
  return { generation, records };
}

export interface AuthorizedRecords {
  context: AccessContext;
  records: ReadonlyMap<string, ScopedStoredRecord & { scope: RecordScope }>;
}

/** Reusable read preflight for API/MCP/history. Denied and nonexistent IDs both
 * disappear from `records`. Do not serialize the internal graph or context.
 * Routes still authenticate the principal and apply endpoint-specific rules. */
export async function readAuthorizedRecords(db: D1Database, userId: string, ids: readonly string[], options: { includeDeleted?: boolean } = {}): Promise<AuthorizedRecords> {
  const graph = await loadScopeGraph(db, ids), resolve = scopeResolver(graph.records);
  const scopes = new Map<string, RecordScope>();
  for (const id of new Set(ids)) {
    try { scopes.set(id, resolve(id)); }
    catch (error) { if (!(error instanceof ScopeError)) throw error; }
  }
  const spaceIds = [...new Set([...scopes.values()].flatMap(scope => [...scope.readSpaceIds]))];
  if (spaceIds.length > MAX_ACCESS_SPACES) throw new RecordAccessError('scope_graph_budget');
  const context = await loadAccessContext(db, userId, spaceIds);
  if (graph.generation !== context.generation) throw new RecordAccessError('access_reset_required');
  const allowed = new Map<string, ScopeGraphRecord & { scope: RecordScope }>();
  for (const [id, scope] of scopes) {
    const record = graph.records.get(id);
    if (!record || scope.serviceOnly || scope.ancestorDeleted || (!options.includeDeleted && record.data.deleted === true)) continue;
    if (scope.readSpaceIds.every(spaceId => canRead(spaceAccess(context, spaceId)))) allowed.set(id, { ...record, scope });
  }
  const records = new Map<string, ScopedStoredRecord & { scope: RecordScope }>();
  if (!allowed.size) return { context, records };
  // Fetch content only after authority is known. A record may have changed its
  // references between graph and content reads without changing origin space;
  // compare its revision as well as fencing permission generation.
  let content: D1Result;
  try {
    [, content] = await db.batch([
      accessFence(db, context),
      db.prepare('SELECT id,collection,data,space_id,seq,field_ts FROM records WHERE id IN (SELECT value FROM json_each(?))')
        .bind(JSON.stringify([...allowed.keys()])),
    ]);
  } catch (error) {
    const current = await loadAccessContext(db, userId, []);
    if (current.generation !== context.generation || current.enabled !== context.enabled) throw new RecordAccessError('access_reset_required');
    throw error;
  }
  if (content.results.length !== allowed.size) throw new RecordAccessError('access_reset_required');
  for (const r of content.results as unknown as RawStoredRow[]) {
    const expected = allowed.get(r.id);
    if (!expected || expected.rev !== r.seq || expected.collection !== r.collection) throw new RecordAccessError('access_reset_required');
    records.set(r.id, { id: r.id, collection: r.collection, data: JSON.parse(r.data), rootSpaceId: r.space_id,
      rev: r.seq, fieldTs: JSON.parse(r.field_ts), scope: expected.scope });
  }
  return { context, records };
}
