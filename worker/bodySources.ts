import type {Env} from './auth';

/** A generation covers the whole block set, including new/deleted/moved blocks. */
export async function bodyVersions(env:Env,ids:readonly string[]):Promise<Record<string,number>> {
 if(!ids.length)return {};
 const rows=(await env.DB.prepare(`SELECT j.value id,COALESCE(b.generation,0) generation FROM json_each(?) j
 LEFT JOIN body_generations b ON b.record_id=j.value`).bind(JSON.stringify([...new Set(ids)])).all<{id:string;generation:number}>()).results;
 return Object.fromEntries(rows.map(r=>[r.id,r.generation]));
}
export function bodyFence(env:Env,versions:Record<string,number>) {
 return env.DB.prepare(`SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM json_each(?) j
 LEFT JOIN body_generations b ON b.record_id=j.key WHERE COALESCE(b.generation,0)<>j.value)
 THEN 1 ELSE json_extract('{','$') END`).bind(JSON.stringify(versions));
}
export async function bodiesCurrent(env:Env,versions:Record<string,number>) {
 const current=await bodyVersions(env,Object.keys(versions));
 return Object.keys(versions).every(id=>current[id]===versions[id]);
}
