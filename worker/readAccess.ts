/** Phase 5 read seam for every user-visible read that is not the sync feed.
 *
 * One request-scoped `ReadGate` decides, for rows a route has already loaded, which the
 * principal may read NOW. It reuses the authorization kernel unchanged: the ownership
 * graph (`loadScopeGraph`), the pure scope resolver, and the principal's current
 * memberships (`loadAccessContext`, the same decision as `effectiveSpaceRole`). It is
 * not a second authorization system and it grants nothing; it only removes.
 *
 * Order matters: content is read FIRST and authority is evaluated AFTER it, against the
 * row's own revision. A row survives only if, at a moment after its bytes were read, the
 * principal could read every space its scope resolves through AND the graph still shows
 * the revision that was read. A revocation before the decision removes the row; a
 * concurrent move or re-parenting changes the revision and removes it too (fail closed).
 * Denied and nonexistent ids are indistinguishable to callers.
 *
 * While `access_state.enabled = 0` the gate keeps everything (Phase 0–4 behavior).
 * Gates are built per request and never stored in module state. Internal service work
 * (automations, form processing, integrity checks whose results never reach a caller)
 * uses the ungated environment explicitly via `serviceEnv`. */
import { canEdit, canRead } from '../shared/access';
import { scopeResolver, ScopeError, type RecordScope } from '../shared/recordScope';
import { loadAccessContext, MAX_ACCESS_SPACES, spaceAccess } from './access';
import type { Env } from './auth';
import { levelSql } from './capability';
import { loadScopeGraph, RecordAccessError, type ScopeGraphRecord } from './recordAccess';

const GRAPH_CHUNK = 500;

export interface ReadDecision {
  /** False: permissions are not active; every id is readable (legacy). */
  enabled: boolean;
  readable: ReadonlySet<string>;
  /** Existing records the principal may NOT read (never shown to callers as such). */
  denied: ReadonlySet<string>;
  /** Graph revision of each existing id (for the revision check). */
  revs: ReadonlyMap<string, number>;
  scopes: ReadonlyMap<string, RecordScope>;
}

export interface ReadGate {
  readonly userId: string;
  enabled(): Promise<boolean>;
  decide(ids: readonly string[]): Promise<ReadDecision>;
  /** Keep the rows the principal may read now. Rows carrying `rev` must match the graph. */
  filter<T extends { id: string; rev?: number }>(rows: readonly T[]): Promise<T[]>;
  /** True iff `id` exists and is readable (legacy: true iff it exists or is unknown). */
  canRead(id: string): Promise<boolean>;
  /** Final tool boundary: no earlier allowed payload may survive current revocation. */
  validateObserved(): Promise<boolean>;
}

export async function accessEnabled(db: D1Database): Promise<boolean> {
  const row = await db.prepare('SELECT enabled FROM access_state WHERE id=1').first<{ enabled: number }>();
  return row?.enabled === 1;
}

export function createReadGate(db: D1Database, userId: string): ReadGate {
  let mode: boolean | undefined;
  const isEnabled = async () => (mode = await accessEnabled(db));
  // Cache only ownership data, NEVER membership decisions. Every decision loads
  // current authority and verifies every cached ancestor revision in the SAME batch.
  const observed = new Set<string>();
  let graph = new Map<string, ScopeGraphRecord>();
  const decide = async (input: readonly string[]): Promise<ReadDecision> => {
    const ids = [...new Set(input.filter(id => typeof id === 'string' && id.length > 0 && id.length <= 64))];
    if (mode !== true && !(await isEnabled())) return { enabled: false, readable: new Set(ids), denied: new Set(), revs: new Map(), scopes: new Map() };
    const result = await decideFresh(ids);
    for (const id of result.readable) observed.add(id);
    return result;
  };
  const decideFresh = async (ids: readonly string[], retry = true): Promise<ReadDecision> => {
    const missing = ids.filter(id=>!graph.has(id));
    for (let i = 0; i < missing.length; i += GRAPH_CHUNK) {
      for (const [id, record] of (await loadScopeGraph(db, missing.slice(i, i + GRAPH_CHUNK))).records) graph.set(id, record);
    }
    const resolve = scopeResolver(graph), scopes = new Map<string, RecordScope>();
    for (const id of ids) {
      if (!graph.has(id)) continue;
      try { scopes.set(id, resolve(id)); } catch (error) { if (!(error instanceof ScopeError)) throw error; }
    }
    const spaces = [...new Set([...scopes.values()].flatMap(scope => [...scope.readSpaceIds]))];
    if (spaces.length > MAX_ACCESS_SPACES) throw new RecordAccessError('scope_graph_budget');
    // Current authority, read after the content the caller already holds.
    const context = await loadAccessContext(db, userId, spaces, new Map([...graph].map(([id,r])=>[id,r.rev])));
    mode = context.enabled;
    if (!context.recordsCurrent) {
      graph.clear();
      if (retry) return decideFresh(ids,false);
      return { enabled:true, readable:new Set(), denied:new Set(ids), revs:new Map(), scopes:new Map() };
    }
    const readable = new Set<string>(), denied = new Set<string>(), revs = new Map<string, number>();
    for (const id of ids) {
      const record = graph.get(id);
      if (!record) continue;
      revs.set(id, record.rev);
      const scope = scopes.get(id);
      const ok = context.enabled && !!scope && !scope.serviceOnly && !scope.ancestorDeleted && scope.readSpaceIds.every(space => canRead(spaceAccess(context, space)));
      (ok ? readable : denied).add(id);
    }
    if (!context.enabled) return { enabled: false, readable: new Set(ids), denied: new Set(), revs, scopes };
    return { enabled: true, readable, denied, revs, scopes };
  };
  return {
    userId,
    enabled: isEnabled,
    decide,
    async validateObserved() {
      if (!observed.size) return true;
      const ids = [...observed], result = await decide(ids);
      return !result.enabled || ids.every(id=>result.readable.has(id));
    },
    async filter(rows) {
      if (!rows.length) return [...rows];
      const decision = await decide(rows.map(row => row.id));
      if (!decision.enabled) return [...rows];
      return rows.filter(row => decision.readable.has(row.id) && (row.rev === undefined || decision.revs.get(row.id) === row.rev));
    },
    async canRead(id) {
      const decision = await decide([id]);
      return !decision.enabled || decision.readable.has(id);
    },
  };
}

/** The request-scoped environment of a user-visible read: same bindings, plus the gate. */
export function withReadGate<E extends Env>(env: E, userId: string): E {
  if (env.READ_GATE?.userId === userId) return env;
  const service = env.SERVICE_ENV ?? env;
  return { ...env, READ_GATE: createReadGate(env.DB, userId), SERVICE_ENV: service };
}

/** The ungated environment, for service work whose results never reach the caller. */
export function serviceEnv<E extends Env>(env: E): E {
  return (env.SERVICE_ENV as E | undefined) ?? env;
}

/** Apply the request's gate (if any) to rows loaded through `env`. */
export async function gateRows<T extends { id: string; rev?: number }>(env: Pick<Env, 'READ_GATE'>, rows: T[]): Promise<T[]> {
  return env.READ_GATE ? env.READ_GATE.filter(rows) : rows;
}

/** Users among `userIds` who can currently read record `targetId` (service decision:
 * recipients of record-derived notifications). Legacy: everyone. Two binding calls. */
export async function readersOf(db: D1Database, targetId: string, userIds: readonly string[]): Promise<Set<string>> {
  const users = [...new Set(userIds)];
  if (!users.length || !(await accessEnabled(db))) return new Set(users);
  const graph = await loadScopeGraph(db, [targetId]);
  let scope: RecordScope;
  try { scope = scopeResolver(graph.records)(targetId); } catch (error) { if (error instanceof ScopeError) return new Set(); throw error; }
  if (scope.serviceOnly) return new Set();
  const { results } = await db.prepare(`SELECT u.value AS id FROM json_each(?) u
      WHERE NOT EXISTS(SELECT 1 FROM json_each(?) s WHERE ${levelSql('u.value', 's.value')} < 1)`)
    .bind(JSON.stringify(users), JSON.stringify([...scope.readSpaceIds])).all<{ id: string }>();
  return new Set(results.map(row => row.id));
}

/** May `userId` edit record `id` now (readable AND editor on its space)? Legacy: true when it exists.
 * For member routes that hand out capabilities (form tokens) or reveal configuration. */
export async function editableBy(db: D1Database, userId: string, id: string): Promise<boolean> {
  if (!(await accessEnabled(db))) return true;
  const graph = await loadScopeGraph(db, [id]);
  let scope: RecordScope;
  try { scope = scopeResolver(graph.records)(id); } catch (error) { if (error instanceof ScopeError) return false; throw error; }
  if (scope.serviceOnly) return false;
  const context = await loadAccessContext(db, userId, [...scope.readSpaceIds]);
  return context.enabled && scope.readSpaceIds.every(space => canRead(spaceAccess(context, space))) && canEdit(spaceAccess(context, scope.spaceId));
}
