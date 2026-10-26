/** Targeted, read-gated upgrade inventory. No task/body collection scan: only
 * authored stable ids, matching database keys and this installed page subtree. */
import type {Env} from './auth';
import type {BundledTemplate,PackRecord} from '../shared/bundled';
import {installRecordId} from '../shared/templates';
import {gateRows} from './readAccess';
export async function loadPackUpgradeRecords(env:Env,bundle:BundledTemplate,rootId:string):Promise<PackRecord[]>{
 const ids=Object.entries(bundle.snapshot).flatMap(([collection,bag])=>['boards','pages','views','blocks'].includes(collection)?Object.keys(bag??{}).map(id=>installRecordId(bundle.key,collection,id)):[]);
 const keys=Object.values(bundle.snapshot.boards).map(b=>b.key).filter(Boolean);
 const rows=await env.DB.prepare(`WITH RECURSIVE sub(id) AS (
 SELECT id FROM records WHERE id=? AND collection='pages'
 UNION SELECT r.id FROM records r JOIN sub ON json_extract(r.data,'$.parentId')=sub.id WHERE r.collection='pages'),
 dbs(id) AS(SELECT id FROM records WHERE collection='boards' AND json_extract(data,'$.templateDbKey') IN(SELECT value FROM json_each(?)))
 SELECT id,collection,data,seq AS rev FROM records WHERE id IN(SELECT value FROM json_each(?)) OR id IN(SELECT id FROM sub) OR id IN(SELECT id FROM dbs)
 OR(collection='blocks' AND json_extract(data,'$.pageId') IN(SELECT id FROM sub)) OR(collection='views' AND json_extract(data,'$.databaseId') IN(SELECT id FROM dbs)) LIMIT 2001`)
 .bind(rootId,JSON.stringify(keys),JSON.stringify(ids)).all<{id:string;collection:string;data:string;rev:number}>();
 if(rows.results.length>2000)throw new Error('Pack inventory exceeds the bounded upgrade limit. Review the installation before upgrading.');
 return (await gateRows(env,rows.results)).map(r=>({...r,data:JSON.parse(r.data)}));
}
