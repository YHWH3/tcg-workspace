import {Hono} from 'hono';
import {requireAuth,type Env,type AuthUser} from './auth';
import {withReadGate} from './readAccess';
import {getRecs,SELECT,toRow,type RawRow} from './records';
import {notify} from './notifications';
import {hasD1Budget,D1BudgetExhausted} from './d1budget';
const week=(now:number)=>{const d=new Date(now);d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7));return d.toISOString().slice(0,10);};
/** IDs only are retained. Each rendering re-reads content and current rights.
 * This deterministic digest uses database names/type metadata as labels, never
 * infers decisions or project outcomes from missing evidence. */
export async function buildDigest(env:Env,uid:string,now=Date.now()){
 const scoped=withReadGate(env,uid),today=new Date(now).toISOString().slice(0,10),until=new Date(now+7*86400000).toISOString().slice(0,10);
 const batch=await env.DB.batch([
  env.DB.prepare(`SELECT ${SELECT} FROM records WHERE collection='tasks' AND COALESCE(json_extract(data,'$.deleted'),0)!=1 AND COALESCE(json_extract(data,'$.archived'),0)!=1 AND (json_extract(data,'$.dueDate')<=? OR updated_at>=?) ORDER BY COALESCE(json_extract(data,'$.dueDate'),'9999'),id LIMIT 501`).bind(until,now-7*86400000),
  env.DB.prepare("SELECT target_id FROM approvals WHERE status='pending' AND approver_id=? ORDER BY created_at,id LIMIT 101").bind(uid),
 ]);
 const rows=batch[0].results as unknown as RawRow[],approvalIds=(batch[1].results as unknown as {target_id:string}[]).map(r=>r.target_id);
 const allowed=await scoped.READ_GATE!.filter(rows.slice(0,500).map(toRow));
 const boards=await getRecs(scoped,[...new Set(allowed.map(r=>String(r.data.boardId??'board-default')))]),approvals=await getRecs(scoped,approvalIds.slice(0,100));
 const records=allowed.flatMap(r=>{
  const board=boards.get(String(r.data.boardId??'board-default')),columns=board?.data.columns as {id:string}[]|undefined;
  if(!board||columns?.length&&r.data.status===columns.at(-1)?.id)return [];
  const label=String(board.data.name??'').toLowerCase(),due=typeof r.data.dueDate==='string'&&!!r.data.dueDate;
  const category=label.includes('decision')?'decisions':label.includes('follow')?'followups':label.includes('project')?'projects':due?'deadlines':'changes';
  return [{id:r.id,title:r.data.title,dueDate:r.data.dueDate,status:r.data.status,category,overdue:due&&String(r.data.dueDate)<today,url:`/boards/${String(r.data.boardId??'board-default')}/tasks/${r.id}`}];
 });
 const pendingApprovals=[...approvals.values()].map(r=>({id:r.id,title:r.data.title??r.data.name,url:'/inbox'}));
 if(!await scoped.READ_GATE!.validateObserved())return {week:week(now),today,records:[],pendingApprovals:[],truncated:true,accessChanged:true,aiSummary:{status:'disabled',text:null}};
 return {week:week(now),today,records,pendingApprovals,truncated:rows.length>500||approvalIds.length>100,aiSummary:{status:'disabled',text:null}};
}
export async function runWeeklyDigests(env:Env,now=Date.now()){
 const due=(await env.DB.prepare(`SELECT id FROM users u WHERE disabled_at IS NULL AND NOT EXISTS(SELECT 1 FROM ai_digest_runs d WHERE d.user_id=u.id AND d.week=? AND (d.delivered=1 OR d.attempts>=8 OR d.retry_at>?)) ORDER BY id LIMIT 1`).bind(week(now),now).all<{id:string}>()).results;
 for(const user of due){if(!hasD1Budget(env.DB,28))break;try {await env.DB.prepare("INSERT OR IGNORE INTO ai_digest_runs(user_id,week,record_ids,created_at) VALUES(?,?,'[]',?)").bind(user.id,week(now),now).run();const digest=await buildDigest(env,user.id,now);
  await env.DB.prepare('UPDATE ai_digest_runs SET record_ids=? WHERE user_id=? AND week=?').bind(JSON.stringify(digest.records.map(r=>r.id)),user.id,digest.week).run();
  if(digest.records.length)await notify(env,{targetType:'record',targetId:digest.records[0].id,userId:user.id,kind:'automation',title:'Your weekly review is ready',body:'Open AI workflows to review current authorized work and deadlines.',url:'/ai',groupKey:'weekly-digest:'+digest.week,dedupeKey:'weekly-digest:'+digest.week+':'+user.id});
  await env.DB.prepare('UPDATE ai_digest_runs SET delivered=1 WHERE user_id=? AND week=?').bind(user.id,digest.week).run();
  }catch(error){if(error instanceof D1BudgetExhausted)throw error;await env.DB.prepare('UPDATE ai_digest_runs SET attempts=attempts+1,retry_at=? WHERE user_id=? AND week=? AND delivered=0').bind(now+3600000,user.id,week(now)).run();}
 }
}
export const aiDigestApi=new Hono<{Bindings:Env;Variables:{user:AuthUser}}>();aiDigestApi.use('*',requireAuth);
aiDigestApi.get('/',async c=>c.json(await buildDigest(c.env,c.get('user').id)));
