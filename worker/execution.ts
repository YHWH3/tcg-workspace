import type { Env } from './auth';
import type { ApplyOptions } from './sync';

export const EXECUTION_LEASE_MS=60_000;
export const EXECUTION_MAX_ATTEMPTS=8;
export function retryDelay(attempt:number):number { return Math.min(15*60_000,1_000*2**Math.min(attempt,10)); }

export function executionFence(db:D1Database,table:'automation_runs'|'form_submissions',id:string,lease:string):()=>D1PreparedStatement {
  const key=table==='automation_runs'?'id':'submission_id';
  return ()=>db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM ${table} WHERE ${key}=? AND lease_id=? AND lease_until>?) THEN 1 ELSE json_extract('{','$') END`).bind(id,lease,Date.now());
}

export function executionCheckpoint(db:D1Database,operationId:string,recordId:string):D1PreparedStatement {
  return db.prepare('INSERT OR IGNORE INTO execution_steps(operation_id,step_id,done_at) VALUES(?,?,?)').bind(operationId,'record:'+recordId,Date.now());
}

export function executionOptions(env:Pick<Env,'DB'>,table:'automation_runs'|'form_submissions',id:string,lease:string):NonNullable<ApplyOptions['execution']> {
  return {guard:executionFence(env.DB,table,id,lease),checkpoint:recordId=>executionCheckpoint(env.DB,id,recordId)};
}

export async function completedRecords(db:D1Database,id:string):Promise<Set<string>> {
  const {results}=await db.prepare('SELECT step_id FROM execution_steps WHERE operation_id=?').bind(id).all<{step_id:string}>();
  return new Set(results.filter(r=>r.step_id.startsWith('record:')).map(r=>r.step_id.slice(7)));
}
