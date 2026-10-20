/** Protocol 3: the access manifest and the per-space pull feed.
 * Specification and review: docs/architecture/phase-5-per-space-feeds.md.
 *
 * One pull is ONE D1 batch: the manifest and every candidate statement see the same
 * snapshot, and each candidate statement embeds the caller's CURRENT effective level
 * (the same SQL as the write fence), so a caller revoked a moment ago can never
 * receive a page computed with the old readable set (FD-03). Nothing is written. */
import { isWorkspaceRole } from '../shared/access';
import {
  MAX_JOINING_SPACES, MAX_PULL_LIMIT, MIN_PULL_LIMIT, PERMISSION_PROTOCOL,
  type ManifestSpaceV3, type ManifestV3, type PullRequestV3, type PullResponseV3, type PulledEviction,
} from '../shared/protocol';
import { stableJson } from '../shared/stablejson';
import type { PulledRecord } from '../shared/types';
import { MAX_ACCESS_SPACES } from './access';
import { levelRole, levelSql } from './capability';
import { sha256Hex } from './password';
import { readAuthorizedRecords, RecordAccessError } from './recordAccess';
import { SyncProtocolError } from './syncState';

/** Per-statement fetch bound. Any request limit ≤ 500 is served exactly: a row among the
 * first `limit` of the true stream is among the first 501 of its own statement. */
const FETCH = 501;

const bad = (): never => { throw new SyncProtocolError('invalid_sync_request', 400); };
const isInt = (value: unknown): value is number => Number.isSafeInteger(value);
const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 64;

export function parsePullRequest(body: unknown): PullRequestV3 {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad();
  const b = body as Record<string, unknown>;
  if (b.protocol !== PERMISSION_PROTOCOL) throw new SyncProtocolError('permission_protocol_required', 426);
  if (typeof b.etag !== 'string' || b.etag.length > 64) return bad();
  if (!isInt(b.cursor) || b.cursor < 0) return bad();
  const limit = b.limit === undefined ? MAX_PULL_LIMIT : b.limit;
  if (!isInt(limit) || limit < MIN_PULL_LIMIT || limit > MAX_PULL_LIMIT) return bad();
  const rawJoining = b.joining === undefined ? [] : b.joining;
  if (!Array.isArray(rawJoining) || rawJoining.length > MAX_JOINING_SPACES) return bad();
  const seen = new Set<string>();
  const joining = rawJoining.map(entry => {
    const e = entry as { space?: unknown; after?: unknown; base?: unknown } | null;
    if (!e || typeof e !== 'object' || !isId(e.space) || !isInt(e.after) || e.after < 0 || !isInt(e.base) || e.base < 0 || seen.has(e.space)) return bad();
    seen.add(e.space);
    return { space: e.space, after: e.after, base: e.base };
  });
  const deferred = b.deferred === undefined ? [] : b.deferred;
  if (!Array.isArray(deferred) || deferred.length + joining.length > MAX_ACCESS_SPACES) return bad();
  for (const space of deferred) { if (!isId(space) || seen.has(space)) return bad(); seen.add(space); }
  return { protocol: PERMISSION_PROTOCOL, etag: b.etag, cursor: b.cursor, joining, limit, ...(deferred.length ? { deferred } : {}) };
}

/** The caller's current principal and readable spaces (with roles), one batch. */
export function manifestStatements(db: D1Database, userId: string): D1PreparedStatement[] {
  return [
    db.prepare('SELECT id, COALESCE(workspace_role, role) workspace_role, disabled_at FROM users WHERE id = ?').bind(userId),
    db.prepare(`SELECT id, name, export_policy, events_floor, lvl FROM (
        SELECT s.id id, s.name name, s.export_policy export_policy, s.events_floor events_floor, ${levelSql('?', 's.id')} lvl FROM spaces s
      ) WHERE lvl >= 1 ORDER BY name, id LIMIT ?`).bind(userId, MAX_ACCESS_SPACES + 1),
  ];
}

export interface ParsedManifest { manifest: ManifestV3; floors: ReadonlyMap<string, number> }

export async function parseManifest(userId: string, principal: D1Result, spaces: D1Result): Promise<ParsedManifest> {
  const row = principal.results[0] as { id: string; workspace_role: unknown; disabled_at: number | null } | undefined;
  if (!row || row.disabled_at !== null || !isWorkspaceRole(row.workspace_role)) throw new SyncProtocolError('unauthenticated', 401);
  const rows = spaces.results as unknown as { id: string; name: string; export_policy: string; events_floor: number; lvl: number }[];
  if (rows.length > MAX_ACCESS_SPACES) throw new RecordAccessError('scope_graph_budget');
  const list: ManifestSpaceV3[] = rows.map(r => ({ id: r.id, name: r.name, role: levelRole(r.lvl)!, exportPolicy: r.export_policy === 'members' ? 'members' : 'disabled' }));
  const etag = (await sha256Hex(stableJson({ v: PERMISSION_PROTOCOL, userId, workspaceRole: row.workspace_role, spaces: list }))).slice(0, 22);
  return {
    manifest: { protocol: PERMISSION_PROTOCOL, userId, workspaceRole: row.workspace_role, etag, spaces: list },
    floors: new Map(rows.map(r => [r.id, r.events_floor])),
  };
}

export async function loadManifest(db: D1Database, userId: string): Promise<ParsedManifest> {
  const [principal, spaces] = await db.batch(manifestStatements(db, userId));
  return parseManifest(userId, principal, spaces);
}

export type { PullResponseV3 } from '../shared/protocol';
export type PullOutcome =
  | { status: 200; body: PullResponseV3 }
  | { status: 409; body: { error: 'manifest_changed'; manifest: ManifestV3 } | { error: 'cursor_ahead' } | { error: 'rebackfill_required'; spaces: string[] } | { error: 'access_changed_retry' } };

interface Item { seq: number; kind: 0 | 1; id: string; space: string }

export async function pullFeed(db: D1Database, userId: string, req: PullRequestV3): Promise<PullOutcome> {
  const joiningIds = [...req.joining.map(j => j.space), ...(req.deferred ?? [])], joiningJson = JSON.stringify(joiningIds);
  // Spaces the caller can read, minus the ones being backfilled (they have their own scan).
  const settledSpaces = `SELECT s.id FROM spaces s WHERE ${levelSql('?', 's.id')} >= 1 AND s.id NOT IN (SELECT value FROM json_each(?))`;
  const statements: D1PreparedStatement[] = [
    ...manifestStatements(db, userId),
    db.prepare('SELECT MAX((SELECT COALESCE(MAX(seq),0) FROM records),(SELECT floor FROM seq_floor WHERE id=1)) hw'),
    // A link whose peer space is still being backfilled reaches the client through that
    // space's own scan, never through the shared cursor (never a link to a record the
    // client cannot yet hold).
    db.prepare(`SELECT r.id, r.seq, r.space_id FROM records r WHERE r.space_id IN (${settledSpaces})
        AND (r.peer_space_id IS NULL OR r.peer_space_id NOT IN (SELECT value FROM json_each(?))) AND r.seq > ? ORDER BY r.seq LIMIT ${FETCH}`)
      .bind(userId, joiningJson, joiningJson, req.cursor),
    db.prepare(`SELECT e.space_id, e.seq, e.record_id FROM space_events e WHERE e.space_id IN (${settledSpaces}) AND e.seq > ? ORDER BY e.seq LIMIT ${FETCH}`)
      .bind(userId, joiningJson, req.cursor),
  ];
  for (const { space, after } of req.joining) {
    statements.push(
      db.prepare(`SELECT id, seq, space_id FROM (
          SELECT * FROM (SELECT id, seq, space_id FROM records WHERE space_id = ? AND seq > ? ORDER BY seq LIMIT ${FETCH})
          UNION
          SELECT * FROM (SELECT id, seq, space_id FROM records WHERE peer_space_id = ? AND seq > ? ORDER BY seq LIMIT ${FETCH})
        ) WHERE ${levelSql('?', '?')} >= 1 ORDER BY seq LIMIT ${FETCH}`).bind(space, after, space, after, space, userId),
      db.prepare(`SELECT space_id, seq, record_id FROM space_events WHERE space_id = ? AND seq > ? AND ${levelSql('?', '?')} >= 1 ORDER BY seq LIMIT ${FETCH}`)
        .bind(space, after, space, userId),
    );
  }
  const results = await db.batch(statements);
  const [principal, spaces, highWater, settledRecords, settledEvents] = results;
  const { manifest, floors } = await parseManifest(userId, principal, spaces);
  if (manifest.etag !== req.etag) return { status: 409, body: { error: 'manifest_changed', manifest } };
  const known = new Set(manifest.spaces.map(space => space.id));
  if (joiningIds.some(id => !known.has(id))) return bad();

  const hw = Number((highWater.results[0] as { hw: number }).hw);
  if (req.cursor > hw || req.joining.some(j => j.after > hw || j.base > hw)) return { status: 409, body: { error: 'cursor_ahead' } };
  // Retention: a pruned fact (seq <= floor) is only a problem if it could concern a row the
  // client already holds. For the shared cursor that is any fact in (cursor, floor]. A
  // backfill reads current state, so only facts NEWER than its first page can matter:
  // restart it when a floor has passed its base (a scan from 0 / not yet started is exempt,
  // and a scan merely short of the floor is fine — asking it to restart would loop forever).
  const stale = manifest.spaces.filter(space => {
    if (req.deferred?.includes(space.id)) return false;
    const scan = req.joining.find(j => j.space === space.id), floor = floors.get(space.id) ?? 0;
    return scan ? scan.base > 0 && scan.base < floor : req.cursor < floor;
  }).map(space => space.id);
  if (stale.length) return { status: 409, body: { error: 'rebackfill_required', spaces: stale } };

  // Merge every statement's candidates into one ascending stream.
  const byId = new Map<string, Item>(), events = new Map<string, Item>();
  const takeRecords = (result: D1Result) => { for (const r of result.results as unknown as { id: string; seq: number; space_id: string }[]) byId.set(r.id, { seq: r.seq, kind: 1, id: r.id, space: r.space_id }); };
  const takeEvents = (result: D1Result) => { for (const e of result.results as unknown as { space_id: string; seq: number; record_id: string }[]) events.set(`${e.space_id}\u0000${e.seq}`, { seq: e.seq, kind: 0, id: e.record_id, space: e.space_id }); };
  takeRecords(settledRecords); takeEvents(settledEvents);
  for (let i = 0; i < req.joining.length; i++) { takeRecords(results[5 + 2 * i]); takeEvents(results[6 + 2 * i]); }
  const stream = [...events.values(), ...byId.values()].sort((a, b) => a.seq - b.seq || a.kind - b.kind || (a.id < b.id ? -1 : a.id > b.id ? 1 : a.space < b.space ? -1 : 1));
  const hasMore = stream.length > req.limit;
  let page = stream.slice(0, req.limit);
  // Never end a page inside an equal-revision group: the next page starts at seq > last.
  if (hasMore && stream[req.limit].seq === page[page.length - 1].seq) {
    const cut = page[page.length - 1].seq;
    page = page.filter(item => item.seq !== cut);
    if (!page.length) return { status: 409, body: { error: 'access_changed_retry' } };
  }
  const reached = hasMore ? page[page.length - 1].seq : hw;

  const recordItems = page.filter(item => item.kind === 1);
  const records: PulledRecord[] = [];
  if (recordItems.length) {
    let authorized;
    try { authorized = await readAuthorizedRecords(db, userId, recordItems.map(item => item.id), { includeDeleted: true, includeAncestorDeleted: true }); }
    catch (error) {
      if (error instanceof RecordAccessError && error.code === 'access_reset_required') return { status: 409, body: { error: 'access_changed_retry' } };
      throw error;
    }
    for (const item of recordItems) {
      const record = authorized.records.get(item.id);
      if (!record) continue; // hidden (service-only, forbidden, unresolvable): the cursor still passes it
      // A candidate that moved or changed between the batch and the content read must
      // not skip a revision or publish content from a different place: recompute.
      if (record.rev !== item.seq) return { status: 409, body: { error: 'access_changed_retry' } };
      const peerSpaceId = record.scope.readSpaceIds.find(space => space !== record.scope.spaceId);
      records.push({ id: record.id, collection: record.collection, data: record.data, field_ts: record.fieldTs, seq: record.rev, spaceId: record.scope.spaceId, ...(peerSpaceId ? { peerSpaceId } : {}) });
    }
  }
  const evictions: PulledEviction[] = page.filter(item => item.kind === 0).map(item => ({ id: item.id, rev: item.seq, spaceId: item.space }));
  return { status: 200, body: {
    protocol: PERMISSION_PROTOCOL, etag: manifest.etag, highWater: hw, records, evictions,
    cursor: Math.max(req.cursor, reached),
    // `base` is fixed by the scan's first response and echoed back unchanged afterwards.
    joining: req.joining.map(j => ({ space: j.space, after: Math.max(j.after, reached), base: j.base > 0 ? j.base : hw })),
    hasMore,
  } };
}
