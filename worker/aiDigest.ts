import {Hono} from 'hono';
import {requireAuth,loadPrefs,kindAllowed,type Env,type AuthUser} from './auth';
import {withReadGate} from './readAccess';
import {getRecs,SELECT,toRow,type RawRow} from './records';
import {notify} from './notifications';
import {hasD1Budget,D1BudgetExhausted} from './d1budget';
import {websiteDigestFor} from './website';
import {serverDateContext,withWorkspaceContext} from './workspaceSettings';
import {startOfWeek,addDays,type Weekday} from '../shared/dates';
/** IDs only are retained. Each rendering re-reads content and current rights.
 * This deterministic digest uses database names/type metadata as labels, never
 * infers decisions or project outcomes from missing evidence. */
export async function buildDigest(env:Env,uid:string,now=Date.now()){
 env=env.WORKSPACE_CONTEXT?env:withWorkspaceContext(env);
 const dateContext=await serverDateContext(env,now),today=dateContext.today,weekKey=startOfWeek(today,dateContext.weekStart as Weekday)!,until=addDays(today,7)!;
 const scoped=withReadGate(env,uid);
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
 const website=await websiteWeek(scoped,now);
 if(!await scoped.READ_GATE!.validateObserved())return {week:weekKey,today,records:[],pendingApprovals:[],website:null,truncated:true,accessChanged:true,aiSummary:{status:'disabled',text:null}};
 return {week:weekKey,today,records,pendingApprovals,website,truncated:rows.length>500||approvalIds.length>100,aiSummary:{status:'disabled',text:null}};
}
/** The digest's Website part: counts by family, patron pipeline movement and
 * the oldest open submissions over the last seven days, from the same
 * deterministic summary the MCP website_digest tool returns. Null when the
 * Website inbox is absent or unreadable for this person. */
async function websiteWeek(env:Env,now:number){
 if(!hasD1Budget(env.DB,8))return null;
 const d=await websiteDigestFor(env,'',{},now);
 if('error' in d)return null;
 return {received:d.received.count,byFamily:d.byFamily.map(p=>({label:p.label,count:p.count})),patronMovement:d.patronMovement.map(p=>({label:p.label,count:p.count})),oldestOpen:d.oldestOpen.slice(0,5),replyFirst:d.replyFirst.slice(0,5).map(r=>({recordId:r.recordId,url:r.url,title:r.title})),responseBands:d.responseBands.map(p=>({label:p.label,count:p.count})),targetBreaches:d.targetBreaches.count,targetDays:d.targetDays,truncated:d.truncated};
}
export async function runWeeklyDigests(env:Env,now=Date.now()){
 env=env.WORKSPACE_CONTEXT?env:withWorkspaceContext(env);
 const dateContext=await serverDateContext(env,now),weekKey=startOfWeek(dateContext.today,dateContext.weekStart as Weekday)!;
 const due=(await env.DB.prepare(`SELECT id FROM users u WHERE disabled_at IS NULL AND NOT EXISTS(SELECT 1 FROM ai_digest_runs d WHERE d.user_id=u.id AND d.week=? AND (d.delivered=1 OR d.attempts>=8 OR d.retry_at>?)) ORDER BY id LIMIT 1`).bind(weekKey,now).all<{id:string}>()).results;
 for(const user of due){if(!hasD1Budget(env.DB,28))break;try {await env.DB.prepare("INSERT OR IGNORE INTO ai_digest_runs(user_id,week,record_ids,created_at) VALUES(?,?,'[]',?)").bind(user.id,weekKey,now).run();const digest=await buildDigest(env,user.id,now);
  if(digest.accessChanged)throw new Error('digest_access_changed');
  await env.DB.prepare('UPDATE ai_digest_runs SET record_ids=? WHERE user_id=? AND week=?').bind(JSON.stringify([...new Set([...digest.records.map(r=>r.id),...digest.pendingApprovals.map(r=>r.id)])]),user.id,digest.week).run();
  const target=digest.records[0]??digest.pendingApprovals[0];
  const outcome=!target?'no_content':!kindAllowed(await loadPrefs(env.DB,user.id),'automation')?'preferences_off':null;
  if(outcome){
   // `delivered` is the legacy terminal-processing flag. Outcome distinguishes
   // actual delivery from intentional suppression; no retained content is purged.
   await env.DB.prepare('UPDATE ai_digest_runs SET delivered=1,outcome=? WHERE user_id=? AND week=?').bind(outcome,user.id,digest.week).run();
  }else{
   // Reuse the notification kernel's current-recipient/target transaction fence.
   // A failure or raced revocation must not acknowledge delivery separately.
   await notify(env,{targetType:'record',targetId:target!.id,userId:user.id,kind:'automation',title:'Your weekly review is ready',body:'Open AI workflows to review current authorized work, deadlines and approvals.',url:'/ai',groupKey:'weekly-digest:'+digest.week,dedupeKey:'weekly-digest:'+digest.week+':'+user.id},[
    env.DB.prepare("UPDATE ai_digest_runs SET delivered=1,outcome='delivered' WHERE user_id=? AND week=?").bind(user.id,digest.week),
   ]);
   if(!await env.DB.prepare('SELECT delivered FROM ai_digest_runs WHERE user_id=? AND week=?').bind(user.id,digest.week).first<number>('delivered'))throw new Error('digest_delivery_unavailable');
  }
  }catch(error){if(error instanceof D1BudgetExhausted)throw error;await env.DB.prepare('UPDATE ai_digest_runs SET attempts=attempts+1,retry_at=? WHERE user_id=? AND week=? AND delivered=0').bind(now+3600000,user.id,weekKey).run();}
 }
}
export const aiDigestApi=new Hono<{Bindings:Env;Variables:{user:AuthUser}}>();aiDigestApi.use('*',requireAuth);
aiDigestApi.get('/',async c=>c.json(await buildDigest(c.env,c.get('user').id)));
