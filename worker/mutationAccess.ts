/** Central write authorization. Never uses source labels, client identity,
 * execution checkpoints or a changeset as a grant. */
import { canComment, canEdit, canEditComment, canRead, isActivePrincipal } from '../shared/access';
import { scopeParentIds, scopeResolver, ScopeError, type RecordScope, type ScopeRecord } from '../shared/recordScope';
import type { Mutation } from '../shared/types';
import { mergeRecord } from './merge';
import { accessFence, CORE_SPACE_ID, loadAccessContext, MAX_ACCESS_SPACES, spaceAccess, type AccessContext } from './access';
import { capabilityFence, LEVEL_READ, minLevel, need, type Needs } from './capability';
import { loadScopeGraph, MAX_SCOPE_GRAPH_RECORDS, RecordAccessError, type ScopeGraphRecord } from './recordAccess';
import { ownsThumbnail, thumbnailParentId } from '../shared/fileOwnership';

export interface AuthorityRow { id: string; collection: string; data: string; field_ts: string; seq: number }
export interface AccessRejection { id: string; collection: string; reason: string }
export interface WriteAuthority {
  context: AccessContext;
  spaces: ReadonlyMap<string, string>;
  /** Updated only with our own committed revisions after each bounded batch. */
  dependencies: Map<string, number>;
  /** Highest capability level this plan relied on, per space (see capability.ts).
   * The batch fence fails iff THIS caller's level fell below it. */
  needs: ReadonlyMap<string, number>;
}
export interface MutationAuthorization {
  authority: WriteAuthority;
  changes: Mutation[];
  rejected: AccessRejection[];
  blockedExpectation: boolean;
}

const isRoot = (record: ScopeRecord) => record.collection === 'boards' || record.collection === 'moodboards'
  || (record.collection === 'pages' && (record.data.parentId === undefined || record.data.parentId === null || record.data.parentId === ''));
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function configurationReferences(record: ScopeRecord): { id: string; edit: boolean }[] {
  if (record.collection !== 'automations' || !Array.isArray(record.data.actions)) return [];
  return record.data.actions.filter(plain).flatMap(action => [
    ...(typeof action.databaseId === 'string' ? [{ id: action.databaseId, edit: true }] : []),
    ...(typeof action.templateId === 'string' ? [{ id: action.templateId, edit: false }] : []),
  ]);
}

export async function authorizeMutations(db: D1Database, userId: string, incoming: Mutation[], existing: ReadonlyMap<string, AuthorityRow>, expected: ReadonlyMap<string, number> | undefined, generation: number): Promise<MutationAuthorization> {
  const changes = incoming.map(ch => ({ ...ch, patch: { ...ch.patch } }));
  const candidates = new Map<string, ScopeRecord>();
  const before = new Map<string, { data: Record<string, unknown>; field_ts: Record<string, number> }>();
  const merged = new Map<string, { data: Record<string, unknown>; field_ts: Record<string, number> }>();
  const touched = new Map<string, Set<string>>();
  const denied = new Map<string, AccessRejection>();
  const reject = (id: string, collection: string, reason: string) => { if (!denied.has(id)) denied.set(id, { id, collection, reason }); };
  for (const ch of changes) {
    const old = existing.get(ch.id);
    if (!before.has(ch.id)) {
      const initial = { data: old ? JSON.parse(old.data) : {}, field_ts: old ? JSON.parse(old.field_ts) : {} };
      before.set(ch.id, initial); merged.set(ch.id, initial); touched.set(ch.id, new Set());
    }
    // Child space claims never enter merge state. The server-owned SQL column
    // is resolved through the graph, including roots created in this call.
    if (!['pages', 'boards', 'moodboards'].includes(ch.collection)) delete ch.patch.spaceId;
    for (const field of Object.keys(ch.patch)) {
      if (field.startsWith('_') || ['space_id', 'collection', 'uploadClaimHash', 'uploadClaim', 'uploadSubmission'].includes(field)
          || (field === 'id' && ch.patch.id !== ch.id)) reject(ch.id, ch.collection, 'protected_field');
    }
    delete ch.patch.id;
    const current = merged.get(ch.id)!;
    for (const field of Object.keys(ch.patch)) if (current.field_ts[field] === undefined || ch.ts >= current.field_ts[field]) touched.get(ch.id)!.add(field);
    merged.set(ch.id, mergeRecord(current, ch));
    const collision = candidates.get(ch.id);
    if (collision && collision.collection !== ch.collection) reject(ch.id, ch.collection, 'collection_mismatch');
    candidates.set(ch.id, { id: ch.id, collection: ch.collection, data: merged.get(ch.id)!.data });
  }
  const seeds = [...new Set([
    ...candidates.keys(), ...(expected?.keys() ?? []),
    ...[...candidates.values()].flatMap(record => [...scopeParentIds(record), ...configurationReferences(record).map(ref => ref.id),
      ...(record.collection === 'files' && typeof record.data.thumbId === 'string' && record.data.thumbId.length <= 64 ? [record.data.thumbId] : []),
      ...(thumbnailParentId(record.id) ? [thumbnailParentId(record.id)!] : []),
    ]),
  ])];
  const graph = new Map<string, ScopeGraphRecord>();
  for (let i = 0; i < seeds.length; i += 500) {
    const loaded = await loadScopeGraph(db, seeds.slice(i, i + 500));
    if (loaded.generation !== generation) throw new RecordAccessError('access_reset_required');
    for (const [id, record] of loaded.records) graph.set(id, record);
    if (graph.size > MAX_SCOPE_GRAPH_RECORDS) throw new RecordAccessError('scope_graph_budget');
  }
  for (const [id, old] of existing) if (graph.get(id)?.rev !== old.seq) throw new RecordAccessError('access_reset_required');
  const oldResolve = scopeResolver(graph);
  const oldScopes = new Map<string, RecordScope>();
  for (const id of new Set([...existing.keys(), ...(expected?.keys() ?? [])])) {
    try { oldScopes.set(id, oldResolve(id)); } catch (error) { if (!(error instanceof ScopeError)) throw error; }
  }
  const proposed = new Map<string, ScopeRecord>(graph);
  for (const [id, record] of candidates) {
    const rootSpace = oldScopes.get(id)?.spaceId ?? graph.get(id)?.rootSpaceId ?? CORE_SPACE_ID;
    const requested = touched.get(id)!.has('spaceId') && isRoot(record) ? record.data.spaceId : rootSpace;
    if (typeof requested !== 'string' || !requested || requested.length > 64) reject(id, record.collection, 'invalid_scope');
    proposed.set(id, { ...record, rootSpaceId: typeof requested === 'string' ? requested : '' });
  }
  const resolve = scopeResolver(proposed), scopes = new Map<string, RecordScope>();
  for (const [id, record] of candidates) {
    try { scopes.set(id, resolve(id)); }
    catch (error) { if (!(error instanceof ScopeError)) throw error; reject(id, record.collection, 'parent_unavailable'); }
  }
  const references = new Map<string, RecordScope>();
  for (const record of candidates.values()) for (const reference of configurationReferences(record)) {
    try { references.set(reference.id, resolve(reference.id)); }
    catch (error) { if (!(error instanceof ScopeError)) throw error; reject(record.id, record.collection, 'reference_unavailable'); }
  }
  const spaceIds = [...new Set([...oldScopes.values(), ...scopes.values(), ...references.values()].flatMap(scope => [...scope.readSpaceIds]))];
  if (spaceIds.length > MAX_ACCESS_SPACES) throw new RecordAccessError('scope_graph_budget');
  const context = await loadAccessContext(db, userId, spaceIds);
  if (context.generation !== generation || !context.enabled) throw new RecordAccessError('access_reset_required');
  const read = (scope: RecordScope | undefined, tombstoneOnly = false) => !!scope && !scope.serviceOnly && (tombstoneOnly || !scope.ancestorDeleted)
    && scope.readSpaceIds.every(id => canRead(spaceAccess(context, id)));
  let blockedExpectation = false;
  for (const id of expected?.keys() ?? []) {
    if (!read(oldScopes.get(id) ?? scopes.get(id))) {
      reject(id, candidates.get(id)?.collection ?? '', 'not_found_or_forbidden'); blockedExpectation = true;
    }
  }
  /** Level each candidate's own capability check needed (same predicates as below). */
  const required = new Map<string, number>();
  for (const [id, record] of candidates) {
    const old = existing.get(id), scope = scopes.get(id), oldScope = oldScopes.get(id);
    // Cascading delete/restore may encounter an already-deleted ancestor (or
    // one being deleted in this call). Permit only tombstone bookkeeping,
    // still requiring the same space capability and all revision fences.
    // This must never authorize reading/editing the hidden descendant body.
    const fields = touched.get(id)!;
    const tombstoneOnly = !!old && typeof record.data.deleted === 'boolean'
      && [...fields].every(field => field === 'deleted' || field === 'deletedVia')
      && (record.data.deletedVia == null || typeof record.data.deletedVia === 'string');
    if (!isActivePrincipal(context.principal) || !read(scope, tombstoneOnly) || (old && !read(oldScope, tombstoneOnly))) {
      // Do not distinguish guessed IDs, hidden parent/type/configuration or
      // malformed ownership for a caller with no readable scope.
      denied.set(id, { id, collection: record.collection, reason: 'not_found_or_forbidden' }); continue;
    }
    if (old && old.collection !== record.collection) { reject(id, record.collection, 'collection_mismatch'); continue; }
    if (oldScope && scope!.spaceId !== oldScope.spaceId) { reject(id, record.collection, 'explicit_move_required'); continue; }
    const access = spaceAccess(context, scope!.spaceId);
    const initial = before.get(id)!.data, after = record.data;
    required.set(id, record.collection === 'comments'
      ? (old ? minLevel(context.principal, a => canEditComment(a, String(initial.authorId ?? ''))) : minLevel(context.principal, canComment))
      : record.collection === 'activity' && !old && after.verb === 'commented' ? minLevel(context.principal, canComment)
        : minLevel(context.principal, canEdit));
    // A thumbnail is auxiliary bytes owned by this canonical attachment, not
    // an arbitrary file reference. Its tombstone is generated by D1 from the
    // main row, so accepting a foreign pointer could poison another upload.
    if (record.collection === 'files' && after.thumbId != null
        && (!ownsThumbnail(id, after.thumbId) || graph.has(String(after.thumbId)) || candidates.has(String(after.thumbId)))) {
      reject(id, record.collection, 'reference_unavailable');
    }
    const thumbnailOwner = thumbnailParentId(id);
    // Current durable ownership wins over a proposed pointer clear: the clear
    // may belong to a later bounded batch that never commits. A caller can
    // release the pointer first and claim the ID in a subsequent operation.
    const main = thumbnailOwner ? (graph.get(thumbnailOwner) ?? candidates.get(thumbnailOwner)) : undefined;
    if (!old && main?.collection === 'files' && main.data.thumbId === id) reject(id, record.collection, 'reference_unavailable');
    if (record.collection === 'comments') {
      if (old ? !canEditComment(access, String(initial.authorId ?? '')) : !canComment(access)) reject(id, record.collection, 'read_only');
      if ((!old && after.authorId !== userId) || (old && ['authorId', 'targetId', 'targetType', 'createdAt'].some(f => fields.has(f) && after[f] !== initial[f]))) reject(id, record.collection, 'protected_field');
      if ([...fields].some(f => !(old ? ['body', 'deleted'] : ['body', 'authorId', 'targetId', 'targetType', 'createdAt', 'deleted']).includes(f))) reject(id, record.collection, 'protected_field');
    } else if (record.collection === 'activity' && !old && after.verb === 'commented') {
      if (!canComment(access)) reject(id, record.collection, 'read_only');
      if (after.actorId !== userId) reject(id, record.collection, 'protected_field');
    } else if (!canEdit(access)) reject(id, record.collection, 'read_only');
    for (const field of ['createdBy', 'uploadedBy', 'actorId']) {
      if (fields.has(field) && ((!old && after[field] !== userId) || (old && after[field] !== initial[field]))) reject(id, record.collection, 'protected_field');
    }
    for (const reference of configurationReferences(record)) {
      const refScope = references.get(reference.id);
      if (!read(refScope) || (reference.edit && !canEdit(spaceAccess(context, refScope!.spaceId)))) reject(id, record.collection, 'reference_unavailable');
    }
  }
  // A rejected proposed parent must not supply a pretend scope/identity to a
  // dependent write. Fail the dependent rather than publishing a half-plan.
  // An existing parent with an unrelated denied title edit is still a valid
  // canonical target (e.g. a commenter editing their own comment).
  const parentPlanRequired = (parentId: string) => {
    if (!denied.has(parentId)) return false;
    const prior = graph.get(parentId), candidate = proposed.get(parentId);
    if (!prior || !candidate) return true;
    const fields = ['parentType', 'targetType', 'fromType', 'toType'];
    return candidate.rootSpaceId !== prior.rootSpaceId || (candidate.data.deleted === true) !== (prior.data.deleted === true)
      || fields.some(field => (candidate.data[field] ?? null) !== (prior.data[field] ?? null))
      || JSON.stringify(scopeParentIds(candidate)) !== JSON.stringify(scopeParentIds(prior));
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, record] of candidates) if (!denied.has(id) && scopeParentIds(record).some(parentPlanRequired)) {
      reject(id, record.collection, 'parent_unavailable'); changed = true;
    }
  }
  const dependencies = new Map([...graph].map(([id, r]) => [id, r.rev]));
  for (const id of seeds) if (!dependencies.has(id)) dependencies.set(id, -1);
  // What the surviving plan relied on: the level its own check needed in the
  // record's space, read access to every space it resolved through (old scope,
  // link endpoints, references) and edit access to automation destinations.
  const needs: Needs = new Map();
  for (const [id, scope] of scopes) if (!denied.has(id)) {
    need(needs, scope.spaceId, required.get(id) ?? minLevel(context.principal, canEdit));
    for (const space of scope.readSpaceIds) need(needs, space, LEVEL_READ);
    for (const space of oldScopes.get(id)?.readSpaceIds ?? []) need(needs, space, LEVEL_READ);
    for (const reference of configurationReferences(candidates.get(id)!)) {
      const refScope = references.get(reference.id);
      if (!refScope) continue;
      for (const space of refScope.readSpaceIds) need(needs, space, LEVEL_READ);
      if (reference.edit) need(needs, refScope.spaceId, minLevel(context.principal, canEdit));
    }
  }
  for (const id of expected?.keys() ?? []) for (const space of (oldScopes.get(id) ?? scopes.get(id))?.readSpaceIds ?? []) need(needs, space, LEVEL_READ);
  return {
    authority: { context, spaces: new Map([...scopes].filter(([id]) => !denied.has(id)).map(([id, scope]) => [id, scope.spaceId])), dependencies, needs },
    changes: changes.filter(ch => !denied.has(ch.id)), rejected: [...denied.values()], blockedExpectation,
  };
}

/** Both guards belong to the same record/outbox/journal/checkpoint transaction.
 * Parent revisions also fence deletion/reference changes that do not change a
 * space ID. Missing proposed parents must still be absent before creation. */
export function writeAuthorityFences(db: D1Database, authority: WriteAuthority): D1PreparedStatement[] {
  return [accessFence(db, authority.context), capabilityFence(db, {
    userId: authority.context.userId, needs: authority.needs,
    workspaceRole: authority.context.principal!.workspaceRole, enabled: authority.context.enabled,
  }), db.prepare(`SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM json_each(?) e LEFT JOIN records r ON r.id=e.key
    WHERE COALESCE(r.seq,-1)<>e.value
  ) THEN 1 ELSE json_extract('{','$') END`).bind(JSON.stringify(Object.fromEntries(authority.dependencies)))];
}
