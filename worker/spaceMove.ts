/** Explicit cross-space move of a root (database/board, mood board or root page) with
 * everything that hangs off it (docs/architecture/phase-5-per-space-feeds.md §3.6).
 *
 * The only way a record may change space: generic patches that would re-root a record
 * are refused as `explicit_move_required`. One atomic batch re-stamps the root and its
 * closure, assigns every moved row a DISTINCT new revision (so each reaches the
 * destination's feed and each leaves an eviction fact in the source — the facts are
 * written by trigger in the same statement), and re-homes every incident relation.
 * It is fenced by the actor's capability on both spaces, by every revision it read and
 * by the size of the closure, so a concurrent edit, insert, revocation or move aborts
 * the batch and nothing is half moved. */
import { canMove, canRead } from '../shared/access';
import { stableJson } from '../shared/stablejson';
import { loadAccessContext, spaceAccess } from './access';
import { capabilityFence, LEVEL_EDIT } from './capability';
import { sha256Hex } from './password';

export const MAX_MOVE_RECORDS = 2000;
const ROOT_COLLECTIONS = new Set(['boards', 'moodboards', 'pages']);
const BUILT_IN_ROOTS = new Set(['board-default', 'board-inbox', 'board-website-inbox']);

export class SpaceMoveError extends Error {
  constructor(public readonly code: 'invalid_request' | 'not_found' | 'forbidden' | 'same_space' | 'not_a_root' | 'deleted_root' | 'conflict'
    | 'move_too_large' | 'request_id_reused' | 'access_changed_retry', public readonly status: 400 | 403 | 404 | 409 | 413) {
    super(code); this.name = 'SpaceMoveError';
  }
}
export interface MoveInput { recordId: unknown; toSpaceId: unknown; requestId: unknown; expectedRev?: unknown }
export interface MoveResult { recordId: string; fromSpaceId: string; toSpaceId: string; moved: number; links: number; replayed: boolean }

const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 64 && !/[\u0000-\u001f\u007f]/.test(value);

/** Ownership edges, mirroring scopeParentIds in shared/recordScope.ts: a record of one of
 * `collections` hangs off the record whose id is stored at `field`. D1 caps a compound
 * SELECT at five terms, so the closure is walked level by level with one index-backed
 * statement per edge (a single batch per level), not as one recursive query. */
const EDGES: { collections: string[]; field: string }[] = [
  { collections: ['pages'], field: '$.parentId' },
  { collections: ['blocks'], field: '$.pageId' },
  { collections: ['tasks'], field: '$.boardId' },
  { collections: ['tasks'], field: '$.parentId' },
  { collections: ['views', 'forms'], field: '$.databaseId' },
  { collections: ['mooditems'], field: '$.boardId' },
  { collections: ['comments', 'activity'], field: '$.targetId' },
  { collections: ['files'], field: '$.parentId' },
  { collections: ['automations'], field: '$.trigger.databaseId' },
  { collections: ['automations'], field: '$.databaseId' },
];
const MAX_LEVELS = 12;
const inList = (edge: { collections: string[] }) => edge.collections.map(name => `'${name}'`).join(',');
const children = (edge: typeof EDGES[number]) =>
  `SELECT c.id id, c.seq seq FROM records c JOIN json_each(?) j ON json_extract(c.data, '${edge.field}') = j.value WHERE c.collection IN (${inList(edge)})`;
/** Commit-time proof that the planned closure is closed: nothing outside it hangs off it. */
const closed = (edge: typeof EDGES[number]) =>
  `SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM records c JOIN json_each(?) j ON json_extract(c.data, '${edge.field}') = j.value
     WHERE c.collection IN (${inList(edge)}) AND c.id NOT IN (SELECT value FROM json_each(?))) THEN 1 ELSE json_extract('{','$') END`;
/** Relations touching the closure, whatever their home space. */
const INCIDENT = `SELECT l.id AS id, l.seq AS seq FROM records l JOIN json_each(?) j ON json_extract(l.data, '$.fromId') = j.value WHERE l.collection = 'links'
  UNION SELECT l.id AS id, l.seq AS seq FROM records l JOIN json_each(?) j ON json_extract(l.data, '$.toId') = j.value WHERE l.collection = 'links'`;

async function readPlan(db: D1Database, recordId: string, limit: number) {
  const root = await db.prepare('SELECT collection, data, space_id, seq FROM records WHERE id = ?').bind(recordId).first<{ collection: string; data: string; space_id: string; seq: number }>();
  if (!root) return { row: undefined, closure: [] as { id: string; seq: number }[], links: [] as { id: string; seq: number }[] };
  const seen = new Map<string, number>([[recordId, root.seq]]);
  let frontier = [recordId];
  for (let level = 0; frontier.length; level++) {
    if (level > MAX_LEVELS) throw new SpaceMoveError('move_too_large', 413);
    const ids = JSON.stringify(frontier);
    const results = await db.batch(EDGES.map(edge => db.prepare(children(edge)).bind(ids)));
    frontier = [];
    for (const result of results) for (const child of result.results as unknown as { id: string; seq: number }[]) {
      if (!seen.has(child.id)) { seen.set(child.id, child.seq); frontier.push(child.id); }
    }
    if (seen.size > limit) throw new SpaceMoveError('move_too_large', 413);
  }
  const closure = [...seen].map(([id, seq]) => ({ id, seq })).sort((a, b) => (a.id < b.id ? -1 : 1));
  const ids = JSON.stringify(closure.map(r => r.id));
  const links = (await db.prepare(`${INCIDENT} ORDER BY id LIMIT ?`).bind(ids, ids, limit + 1).all<{ id: string; seq: number }>()).results;
  return { row: root, closure, links };
}

export async function moveRoot(db: D1Database, actor: { id: string; tokenHash?: string }, input: MoveInput, options: { maxRecords?: number } = {}): Promise<MoveResult> {
  const { recordId, toSpaceId, requestId, expectedRev } = input;
  if (!id(recordId) || !id(toSpaceId) || !id(requestId) || (expectedRev !== undefined && !Number.isSafeInteger(expectedRev))) throw new SpaceMoveError('invalid_request', 400);
  if (BUILT_IN_ROOTS.has(recordId)) throw new SpaceMoveError('not_a_root', 400);
  const limit = options.maxRecords ?? MAX_MOVE_RECORDS;
  const argsHash = await sha256Hex(stableJson({ action: 'move_record', recordId, toSpaceId }));

  const prior = await db.prepare('SELECT args_hash, after_json FROM access_audit WHERE actor_id = ? AND request_id = ?').bind(actor.id, requestId).first<{ args_hash: string; after_json: string }>();
  if (prior) {
    if (prior.args_hash !== argsHash) throw new SpaceMoveError('request_id_reused', 409);
    const done = JSON.parse(prior.after_json) as Omit<MoveResult, 'replayed'>;
    // A replay is re-authorized: it never reports success to a caller who lost the destination.
    const current = await loadAccessContext(db, actor.id, [done.toSpaceId]);
    if (!current.enabled || !canRead(spaceAccess(current, done.toSpaceId))) throw new SpaceMoveError('not_found', 404);
    return { ...done, replayed: true };
  }

  const plan = await readPlan(db, recordId, limit);
  const row = plan.row;
  // Hidden and missing look the same: a caller who cannot read the source learns nothing.
  if (!row) throw new SpaceMoveError('not_found', 404);
  const context = await loadAccessContext(db, actor.id, [row.space_id, toSpaceId]);
  const source = spaceAccess(context, row.space_id), destination = spaceAccess(context, toSpaceId);
  if (!context.enabled || !source.principal || !canRead(source)) throw new SpaceMoveError('not_found', 404);
  if (!canMove(source, destination)) throw new SpaceMoveError('forbidden', 403);
  if (!ROOT_COLLECTIONS.has(row.collection) || (row.collection === 'pages' && JSON.parse(row.data).parentId)) throw new SpaceMoveError('not_a_root', 400);
  if (row.space_id === toSpaceId) throw new SpaceMoveError('same_space', 400);
  if (JSON.parse(row.data).deleted === true) throw new SpaceMoveError('deleted_root', 409);
  if (expectedRev !== undefined && expectedRev !== row.seq) throw new SpaceMoveError('conflict', 409);
  if (plan.closure.length > limit || plan.links.length > limit) throw new SpaceMoveError('move_too_large', 413);

  const n = plan.closure.length, k = plan.links.length, ids = JSON.stringify(plan.closure.map(r => r.id));
  const linkIds = JSON.stringify(plan.links.map(r => r.id));
  const revisions = JSON.stringify(Object.fromEntries([...plan.closure, ...plan.links].map(r => [r.id, r.seq])));
  const now = Date.now();
  const result: Omit<MoveResult, 'replayed'> = { recordId, fromSpaceId: row.space_id, toSpaceId, moved: n, links: k };
  const poison = (condition: string) => `SELECT CASE WHEN ${condition} THEN 1 ELSE json_extract('{','$') END`;
  const statements: D1PreparedStatement[] = [
    capabilityFence(db, { userId: actor.id, needs: new Map([[row.space_id, LEVEL_EDIT], [toSpaceId, LEVEL_EDIT]]), workspaceRole: source.principal.workspaceRole, enabled: context.enabled, session: actor.tokenHash }),
    // Nothing the plan read has changed, and nothing new hangs off the root or touches it.
    db.prepare(poison('NOT EXISTS(SELECT 1 FROM json_each(?) e LEFT JOIN records r ON r.id = e.key WHERE COALESCE(r.seq, -1) <> e.value)')).bind(revisions),
    ...EDGES.map(edge => db.prepare(closed(edge)).bind(ids, ids)),
    db.prepare(poison(`(SELECT COUNT(*) FROM (${INCIDENT})) = ?`)).bind(ids, ids, k),
    // Reserve a distinct revision per moved row, above everything ever allocated.
    db.prepare('UPDATE seq_floor SET floor = MAX(floor, (SELECT COALESCE(MAX(seq), 0) FROM records)) + ? WHERE id = 1').bind(n + k),
    db.prepare(`WITH ids AS (SELECT CAST(key AS INTEGER) + 1 AS rn, value AS id FROM json_each(?))
      UPDATE records SET space_id = ?, seq = (SELECT floor FROM seq_floor WHERE id = 1) - ? + (SELECT rn FROM ids WHERE ids.id = records.id)
      WHERE id IN (SELECT id FROM ids)`).bind(ids, toSpaceId, n + k),
  ];
  if (k) {
    // A relation lives in its FROM endpoint's space and remembers its TO endpoint's space
    // when that differs. Recomputed from the endpoints as they are after the move.
    const home = "COALESCE((SELECT e.space_id FROM records e WHERE e.id = json_extract(records.data, '$.fromId')), records.space_id)";
    statements.push(db.prepare(`WITH ids AS (SELECT CAST(key AS INTEGER) + 1 AS rn, value AS id FROM json_each(?))
      UPDATE records SET space_id = ${home},
        peer_space_id = (SELECT t.space_id FROM records t WHERE t.id = json_extract(records.data, '$.toId') AND t.space_id <> ${home}),
        seq = (SELECT floor FROM seq_floor WHERE id = 1) - ? + (SELECT rn FROM ids WHERE ids.id = records.id)
      WHERE id IN (SELECT id FROM ids)`).bind(linkIds, k));
  }
  statements.push(db.prepare(`INSERT INTO access_audit(id, actor_id, space_id, action, before_json, after_json, request_id, args_hash, generation, created_at)
      SELECT ?, ?, ?, 'move_record', ?, ?, ?, ?, generation, ? FROM access_state WHERE id = 1`)
    .bind(crypto.randomUUID(), actor.id, row.space_id, JSON.stringify({ spaceId: row.space_id, rev: row.seq }), JSON.stringify(result), requestId, argsHash, now));
  try {
    await db.batch(statements);
  } catch (error) {
    // The audit row is the commit evidence: a lost response is recovered by the unique request id.
    const committed = await db.prepare('SELECT args_hash, after_json FROM access_audit WHERE actor_id = ? AND request_id = ?').bind(actor.id, requestId).first<{ args_hash: string; after_json: string }>();
    if (committed?.args_hash === argsHash) return { ...(JSON.parse(committed.after_json) as Omit<MoveResult, 'replayed'>), replayed: true };
    if (/malformed JSON/i.test(String((error as Error)?.message ?? error))) throw new SpaceMoveError('access_changed_retry', 409);
    throw error;
  }
  return { ...result, replayed: false };
}
