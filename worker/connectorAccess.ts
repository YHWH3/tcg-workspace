/** OAuth grants identify a durable, server-owned connection. Token properties never
 * carry a mutable space list: reductions/revocations affect already-issued tokens. */
import type { Env } from './auth';
import { loadAccessContext, readableSpaceIds } from './access';
export interface ConnectorAuthority { id: string; version: number }
export interface ConnectionRow {
  id:string; user_id:string; client_id:string; spaces_json:string; version:number;
  created_at:number; expires_at:number; revoked_at:number|null;
}
export async function loadConnection(db:D1Database,userId:string,id:string):Promise<ConnectionRow|null> {
  return db.prepare('SELECT g.* FROM ai_connections g JOIN users u ON u.id=g.user_id AND u.disabled_at IS NULL WHERE g.id=? AND g.user_id=? AND g.revoked_at IS NULL AND g.expires_at>?')
    .bind(id,userId,Date.now()).first<ConnectionRow>();
}
export async function availableConnectorSpaces(env:Env,userId:string) {
  const {results}=await env.DB.prepare('SELECT id,name FROM spaces WHERE deleted_at IS NULL ORDER BY id LIMIT 501').all<{id:string;name:string}>();
  if(results.length>500)throw new Error('space selection exceeds supported bound');
  const allowed=new Set(readableSpaceIds(await loadAccessContext(env.DB,userId,results.map(s=>s.id))));
  return results.filter(s=>allowed.has(s.id));
}
export async function reduceConnection(env:Env,userId:string,id:string,spaces:unknown,expectedVersion:unknown) {
  if(!Array.isArray(spaces)||spaces.length>500||!spaces.every(s=>typeof s==='string'&&s.length>0&&s.length<=64)||!Number.isSafeInteger(expectedVersion))return false;
  // The subset condition is checked INSIDE the update, including concurrent reductions.
  const r=await env.DB.prepare(`UPDATE ai_connections SET spaces_json=?,version=version+1
    WHERE id=? AND user_id=? AND version=? AND revoked_at IS NULL AND expires_at>?
    AND NOT EXISTS(SELECT 1 FROM json_each(?) n WHERE n.value NOT IN(SELECT value FROM json_each(spaces_json)))`)
    .bind(JSON.stringify([...new Set(spaces)]),id,userId,expectedVersion,Date.now(),JSON.stringify(spaces)).run();
  return r.meta.changes===1;
}

/** Same canonical graph/roles and transactional fence used by record writes,
 * for auxiliary server-table mutations (approvals, public capability creation). */
export async function connectorRecordFence(env:Env,userId:string,ids:string[]) {
  const {createReadGate}=await import('./readAccess');
  const gate=env.READ_GATE??createReadGate(env.DB,userId,env.CONNECTOR);
  if(!await gate.enabled())return null;
  const decision=await gate.decide(ids);
  if(ids.some(id=>!decision.readable.has(id)))throw new Error('not_found');
  const spaces=[...new Set([...decision.scopes.values()].flatMap(s=>[...s.readSpaceIds]))];
  const context=await loadAccessContext(env.DB,userId,spaces,undefined,env.CONNECTOR);
  const {capabilityFence}=await import('./capability');
  const {loadScopeGraph}=await import('./recordAccess');
  const graph=await loadScopeGraph(env.DB,ids);
  return capabilityFence(env.DB,{userId,needs:new Map(spaces.map(s=>[s,1])),workspaceRole:context.principal!.workspaceRole,enabled:context.enabled,recordRevisions:new Map([...graph.records].map(([id,r])=>[id,r.rev])),connector:context.connector});
}
