/** Audited space administration service. No public routes are exposed while
 * the Phase 5 authorization/sync activation barrier is still disabled. */
import {
  canCreateSpace, canGrantSpaceRole, canManageMembers, effectiveSpaceRole, isActivePrincipal,
  isSpaceRole, isWorkspaceRole, type SpaceMembership,
} from '../shared/access';
import { stableJson } from '../shared/stablejson';
import { loadAccessContext, spaceAccess, type AccessContext } from './access';
import { capabilityFence, capabilityViolated, minLevel, type CapabilityFenceInput } from './capability';
import { sha256Hex } from './password';

export class SpaceMutationError extends Error {
  constructor(public readonly code: 'forbidden' | 'invalid_request' | 'request_id_reused' | 'access_changed_retry' | 'last_space_owner', public readonly status: 400 | 403 | 409) {
    super(code); this.name = 'SpaceMutationError';
  }
}
export interface SpaceMutationResult { spaceId: string; generation: number; replayed: boolean }
interface AuditRow { space_id: string; args_hash: string; generation: number }
function validRequestId(requestId: string) {
  if (typeof requestId !== 'string' || !requestId || requestId.length > 64 || /[\u0000-\u001f\u007f]/.test(requestId)) throw new SpaceMutationError('invalid_request', 400);
}
function priorStatement(db: D1Database, userId: string, requestId: string) {
  return db.prepare('SELECT space_id,args_hash,generation FROM access_audit WHERE actor_id=? AND request_id=?').bind(userId, requestId);
}
function replay(row: AuditRow, hash: string): SpaceMutationResult {
  if (row.args_hash !== hash) throw new SpaceMutationError('request_id_reused', 409);
  return { spaceId: row.space_id, generation: row.generation, replayed: true };
}
const actorFence = (context: AccessContext, needs: Map<string, number>): CapabilityFenceInput => ({
  userId: context.userId, needs, workspaceRole: context.principal!.workspaceRole, enabled: context.enabled });
/** A rolled-back batch is a recoverable "your authority changed" only when the ACTOR's own
 * capability changed; any other failure keeps its original error. */
async function assertFreshOrRethrow(db: D1Database, fence: CapabilityFenceInput, error: unknown): Promise<never> {
  if (await capabilityViolated(db, fence)) throw new SpaceMutationError('access_changed_retry', 409);
  throw error;
}

export async function createSpace(db: D1Database, userId: string, input: { name: string; defaultAccess?: 'members' | 'private'; requestId: string }): Promise<SpaceMutationResult> {
  validRequestId(input.requestId);
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 120
      || (input.defaultAccess !== undefined && !['members', 'private'].includes(input.defaultAccess))) throw new SpaceMutationError('invalid_request', 400);
  const name = input.name.trim(), defaultAccess = input.defaultAccess ?? 'private';
  const hash = await sha256Hex(stableJson({ action: 'create_space', name, defaultAccess }));
  const context = await loadAccessContext(db, userId, []);
  if (!canCreateSpace(context.principal)) throw new SpaceMutationError('forbidden', 403);
  const prior = await priorStatement(db, userId, input.requestId).first<AuditRow>();
  if (prior) {
    const current = await loadAccessContext(db, userId, [prior.space_id]);
    if (!canManageMembers(spaceAccess(current, prior.space_id))) throw new SpaceMutationError('forbidden', 403);
    return replay(prior, hash);
  }
  const spaceId = crypto.randomUUID(), now = Date.now();
  try {
    await db.batch([
      capabilityFence(db, actorFence(context, new Map())),
      db.prepare('INSERT INTO spaces(id,name,default_access,export_policy,created_by,created_at) VALUES(?,?,?,?,?,?)')
        .bind(spaceId, name, defaultAccess, 'disabled', userId, now),
      db.prepare("INSERT INTO space_members(space_id,user_id,role,access,updated_at) VALUES(?,?,'owner','allow',?)").bind(spaceId, userId, now),
      db.prepare(`INSERT INTO access_audit(id,actor_id,space_id,action,after_json,request_id,args_hash,generation,created_at)
        SELECT ?,?,?,'create_space',?,?,?,generation,? FROM access_state WHERE id=1`)
        .bind(crypto.randomUUID(), userId, spaceId, JSON.stringify({ name, defaultAccess, exportPolicy: 'disabled' }), input.requestId, hash, now),
    ]);
  } catch (error) {
    // Concurrent identical requests can race after preflight. Reauthorize a
    // committed replay; never apply a second space creation to obtain success.
    const committed = await priorStatement(db, userId, input.requestId).first<AuditRow>();
    if (committed) {
      const current = await loadAccessContext(db, userId, [committed.space_id]);
      if (!canManageMembers(spaceAccess(current, committed.space_id))) throw new SpaceMutationError('forbidden', 403);
      return replay(committed, hash);
    }
    return assertFreshOrRethrow(db, actorFence(context, new Map()), error);
  }
  const committed = await priorStatement(db, userId, input.requestId).first<AuditRow>();
  if (!committed) throw new Error('space creation audit missing');
  return { spaceId, generation: committed.generation, replayed: false };
}

export async function setSpaceMember(db: D1Database, userId: string, input: { spaceId: string; targetUserId: string; membership: SpaceMembership | null; requestId: string }): Promise<SpaceMutationResult> {
  validRequestId(input.requestId);
  if (![input.spaceId, input.targetUserId].every(id => typeof id === 'string' && id.length > 0 && id.length <= 64)
      || (input.membership !== null && (!input.membership || !isSpaceRole(input.membership.role) || !['allow', 'deny'].includes(input.membership.access)))) throw new SpaceMutationError('invalid_request', 400);
  const hash = await sha256Hex(stableJson({ action: 'set_member', spaceId: input.spaceId, targetUserId: input.targetUserId, membership: input.membership }));
  const context = await loadAccessContext(db, userId, [input.spaceId]);
  const actor = spaceAccess(context, input.spaceId), actorRole = effectiveSpaceRole(actor);
  if (!canManageMembers(actor)) throw new SpaceMutationError('forbidden', 403);
  const [priorResult, targetResult, existingResult, ownersResult] = await db.batch([
    priorStatement(db, userId, input.requestId),
    db.prepare('SELECT COALESCE(workspace_role,role) role,disabled_at FROM users WHERE id=?').bind(input.targetUserId),
    db.prepare('SELECT role,access FROM space_members WHERE space_id=? AND user_id=?').bind(input.spaceId, input.targetUserId),
    db.prepare(`SELECT COUNT(*) n FROM space_members m JOIN users u ON u.id=m.user_id
      WHERE m.space_id=? AND m.role='owner' AND m.access='allow' AND u.disabled_at IS NULL
        AND COALESCE(u.workspace_role,u.role)!='guest'`).bind(input.spaceId),
  ]);
  const prior = priorResult.results[0] as AuditRow | undefined;
  if (prior) return replay(prior, hash);
  const target = targetResult.results[0] as { role: unknown; disabled_at: number | null } | undefined;
  const existing = existingResult.results[0] as SpaceMembership | undefined;
  if (!target || !isWorkspaceRole(target.role)) throw new SpaceMutationError('forbidden', 403);
  if (input.membership !== null) {
    if (!canGrantSpaceRole(actor, target.role, input.membership.role)
        || (input.membership.access === 'allow' && !isActivePrincipal({ id: input.targetUserId, workspaceRole: target.role, disabledAt: target.disabled_at }))) throw new SpaceMutationError('forbidden', 403);
  }
  if (existing && ['owner', 'admin'].includes(existing.role) && actorRole !== 'owner'
      && !(existing.role === 'admin' && input.targetUserId === userId)) throw new SpaceMutationError('forbidden', 403);
  if (existing?.role === 'owner' && existing.access === 'allow'
      && (ownersResult.results[0] as { n: number }).n <= 1) throw new SpaceMutationError('last_space_owner', 409);
  const now = Date.now();
  try {
    await db.batch([
      // The actor must still be able to manage this space's members at commit time.
      capabilityFence(db, actorFence(context, new Map([[input.spaceId, minLevel(context.principal, canManageMembers)]]))),
      input.membership === null
        ? db.prepare('DELETE FROM space_members WHERE space_id=? AND user_id=?').bind(input.spaceId, input.targetUserId)
        : db.prepare(`INSERT INTO space_members(space_id,user_id,role,access,updated_at) VALUES(?,?,?,?,?)
          ON CONFLICT(space_id,user_id) DO UPDATE SET role=excluded.role,access=excluded.access,updated_at=excluded.updated_at`)
          .bind(input.spaceId, input.targetUserId, input.membership.role, input.membership.access, now),
      db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM space_members m JOIN users u ON u.id=m.user_id
        WHERE m.space_id=? AND m.role='owner' AND m.access='allow' AND u.disabled_at IS NULL
          AND COALESCE(u.workspace_role,u.role)!='guest') THEN 1 ELSE json_extract('{','$') END`).bind(input.spaceId),
      db.prepare(`INSERT INTO access_audit(id,actor_id,space_id,target_user_id,action,before_json,after_json,request_id,args_hash,generation,created_at)
        SELECT ?,?,?,?,'set_member',?,?,?,?,generation,? FROM access_state WHERE id=1`)
        .bind(crypto.randomUUID(), userId, input.spaceId, input.targetUserId, JSON.stringify(existing ?? null), JSON.stringify(input.membership), input.requestId, hash, now),
    ]);
  } catch (error) {
    const committed = await priorStatement(db, userId, input.requestId).first<AuditRow>();
    if (committed) {
      if (!canManageMembers(spaceAccess(await loadAccessContext(db, userId, [input.spaceId]), input.spaceId))) throw new SpaceMutationError('forbidden', 403);
      return replay(committed, hash);
    }
    return assertFreshOrRethrow(db, actorFence(context, new Map([[input.spaceId, minLevel(context.principal, canManageMembers)]])), error);
  }
  const committed = await priorStatement(db, userId, input.requestId).first<AuditRow>();
  if (!committed) throw new Error('membership audit missing');
  return { spaceId: input.spaceId, generation: committed.generation, replayed: false };
}
