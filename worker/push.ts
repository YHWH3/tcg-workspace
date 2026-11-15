import {Hono} from 'hono';
import {z} from 'zod';
import {channelsFor,parsePrefs,requireAuth,type AuthUser,type Env,type NotifKind} from './auth';
import {encryptPush,isPushEndpoint,pushBytes,pushMode,vapidAuthorization,type PushEnv} from './webpush';
import {getRec} from './records';
import {createReadGate,withReadGate} from './readAccess';
import {hasD1Budget} from './d1budget';
import {levelSql} from './capability';
import {retryDelay} from './execution';

const subscriptionSchema = z.object({
  endpoint:z.string().min(1).max(2048).refine(isPushEndpoint),
  keys:z.object({p256dh:z.string().regex(/^[\w-]{87}$/),auth:z.string().regex(/^[\w-]{22}$/)}),
});
export const pushApi = new Hono<{Bindings:Env;Variables:{user:AuthUser}}>();
pushApi.use('*',requireAuth);
pushApi.get('/config',c=>c.json({available:!!pushMode(c.env),publicKey:pushMode(c.env)?c.env.VAPID_PUBLIC_KEY??null:null}));
pushApi.post('/subscriptions',async c=>{
  if(!pushMode(c.env))return c.json({error:'Push notifications are currently unavailable.'},503);
  const parsed=subscriptionSchema.safeParse(await c.req.json().catch(()=>null));
  if(!parsed.success)return c.json({error:'Invalid push subscription.'},400);
  const {endpoint,keys}=parsed.data;
  try {
    await crypto.subtle.importKey('raw',pushBytes(keys.p256dh),{name:'ECDH',namedCurve:'P-256'},false,[]);
    if(pushBytes(keys.auth).length!==16)return c.json({error:'Invalid push subscription.'},400);
  } catch {
    return c.json({error:'Invalid push subscription.'},400);
  }
  const user=c.get('user'),now=Date.now();
  const result=await c.env.DB.prepare(`
    INSERT INTO push_subscriptions(id,user_id,session_hash,endpoint,p256dh,auth,created_at,user_agent)
    SELECT ?,u.id,?, ?,?,?,?,? FROM users u JOIN sessions s ON s.user_id=u.id
    WHERE u.id=? AND u.disabled_at IS NULL AND s.token_hash=? AND s.expires_at>?
      AND ((SELECT COUNT(*) FROM push_subscriptions WHERE user_id=u.id)<10
        OR EXISTS(SELECT 1 FROM push_subscriptions WHERE user_id=u.id AND endpoint=?))
    ON CONFLICT(endpoint) DO UPDATE SET session_hash=excluded.session_hash,p256dh=excluded.p256dh,
      auth=excluded.auth,failures=0 WHERE push_subscriptions.user_id=excluded.user_id`
  ).bind(crypto.randomUUID(),user.tokenHash,endpoint,keys.p256dh,keys.auth,now,
    (c.req.header('user-agent')??'').slice(0,200),user.id,user.tokenHash,now,endpoint).run();
  return result.meta.changes?c.json({ok:true}):c.json({error:'This device belongs to another session or the device limit was reached.'},409);
});
pushApi.delete('/subscriptions',async c=>{
  const parsed=z.object({endpoint:z.string().max(2048)}).safeParse(await c.req.json().catch(()=>null));
  if(!parsed.success)return c.json({error:'Invalid push subscription.'},400);
  await c.env.DB.prepare('DELETE FROM push_subscriptions WHERE user_id=? AND session_hash=? AND endpoint=?')
    .bind(c.get('user').id,c.get('user').tokenHash,parsed.data.endpoint).run();
  return c.json({ok:true});
});

type PushRow={id:string;user_id:string;kind:string;target_id:string|null;attempts:number;created_at:number;
  push_subscription_id:string;endpoint:string;p256dh:string;auth:string;session_hash:string;prefs:string|null};

/** One durable delivery per subscription. Browser tags collapse uncertain retries. */
export async function sendPushNotifications(env:{DB:D1Database}&PushEnv) {
  const mode=pushMode(env);
  if(!mode)return;
  const db=env.DB;
  for(let i=0;i<10&&hasD1Budget(db,12);i++){
    const now=Date.now(),lease=crypto.randomUUID();
    const claimed=await db.prepare(`
      UPDATE email_outbox SET lease_id=?,lease_until=?
      WHERE id=(SELECT id FROM email_outbox WHERE push_subscription_id IS NOT NULL
        AND sent_at IS NULL AND terminal_at IS NULL AND next_attempt_at<=? AND COALESCE(lease_until,0)<=?
        ORDER BY next_attempt_at,created_at,id LIMIT 1)
      RETURNING id,user_id,kind,target_id,attempts,created_at,push_subscription_id`
    ).bind(lease,now+30_000,now,now).first<PushRow>();
    if(!claimed)return;
    const finish=(error:string,retry=false)=>db.prepare(`
      UPDATE email_outbox SET last_error=?,terminal_at=?,next_attempt_at=?,lease_id=NULL,lease_until=NULL
      WHERE id=? AND lease_id=?`
    ).bind(error,retry?null:Date.now(),Date.now()+retryDelay(claimed.attempts+1),claimed.id,lease).run();
    const subscription=await db.prepare(`
      SELECT p.endpoint,p.p256dh,p.auth,p.session_hash,u.prefs FROM push_subscriptions p
      JOIN users u ON u.id=p.user_id JOIN sessions s ON s.token_hash=p.session_hash AND s.user_id=p.user_id
      WHERE p.id=? AND p.user_id=? AND u.disabled_at IS NULL AND s.expires_at>?`
    ).bind(claimed.push_subscription_id,claimed.user_id,now).first<PushRow>();
    if(!subscription||!channelsFor(parsePrefs(subscription.prefs),claimed.kind.slice(5) as NotifKind).has('push')){
      await finish('recipient_unavailable');continue;
    }
    const row={...claimed,...subscription};
    if(!isPushEndpoint(row.endpoint)||row.attempts>=5||now-row.created_at>=86_400_000){
      await finish('push_unavailable');continue;
    }
    let title='New activity in TCG Workspace';
    let revisions:[string,number][]=[];
    let spaces:readonly string[]=[];
    let permissionMode=0;
    let content=false;
    if(parsePrefs(row.prefs).pushShowContent&&row.target_id){
      const record=await getRec(withReadGate(env as Env,row.user_id),row.target_id);
      if(record&&!record.data.deleted&&!record.data.archived){
        const decision=await createReadGate(db,row.user_id).decideEditable([row.target_id]);
        if((!decision.enabled||decision.readable.has(row.target_id))&&decision.revs.get(row.target_id)===record.rev){
          title=String(record.data.title??record.data.name??title).slice(0,160);
          content=true;
          permissionMode=decision.enabled?1:0;
          revisions=[...(decision.graphRevs??decision.revs)];
          spaces=decision.scopes.get(row.target_id)?.readSpaceIds??[];
        }
      }
    }
    const message=JSON.stringify({title,url:'/inbox',tag:row.id,userId:row.user_id,session:row.session_hash});
    let body:Uint8Array<ArrayBuffer>;
    let authorization:string|undefined;
    try {
      body=await encryptPush(row.p256dh,row.auth,new TextEncoder().encode(message));
      if(mode==='on')authorization=await vapidAuthorization(row.endpoint,env);
    } catch {
      await finish('push_encryption_failed');continue;
    }
    const contentFence=content?`
      AND (SELECT enabled FROM access_state WHERE id=1)=?
      AND NOT EXISTS(SELECT 1 FROM json_each(?) entry WHERE NOT EXISTS(
        SELECT 1 FROM records WHERE id=json_extract(entry.value,'$[0]') AND seq=json_extract(entry.value,'$[1]')))
      AND NOT EXISTS(SELECT 1 FROM json_each(?) space WHERE ${levelSql('?', 'space.value')}<1)`:'';
    const attempt=await db.prepare(`
      UPDATE email_outbox SET attempts=attempts+1 WHERE id=? AND lease_id=? AND lease_until>?
      AND EXISTS(SELECT 1 FROM push_subscriptions p JOIN users u ON u.id=p.user_id
        JOIN sessions s ON s.token_hash=p.session_hash AND s.user_id=u.id
        WHERE p.id=? AND u.id=? AND u.disabled_at IS NULL AND s.expires_at>?
          AND u.prefs IS ? AND p.endpoint=? AND p.p256dh=? AND p.auth=? AND p.session_hash=?)
      ${contentFence}`
    ).bind(row.id,lease,Date.now(),row.push_subscription_id,row.user_id,Date.now(),row.prefs,
      row.endpoint,row.p256dh,row.auth,row.session_hash,
      ...(content?[permissionMode,JSON.stringify(revisions),JSON.stringify(permissionMode?spaces:[]),row.user_id]:[])).run();
    if(!attempt.meta.changes){await finish('recipient_changed',true);continue;}
    let status:number|undefined;
    try{
      const options:RequestInit={method:'POST',body,headers:{
        'Content-Type':'application/octet-stream','Content-Encoding':'aes128gcm','TTL':'3600',
        ...(authorization?{Authorization:authorization}:{}),
      },credentials:'omit',redirect:'error',signal:AbortSignal.timeout(5000)};
      const response=mode==='simulated'
        ? await env.PUSH_TEST_SINK!.fetch('https://push-simulator.invalid',options)
        : await fetch(row.endpoint,options);
      status=response.status;
      await response.body?.cancel();
    }catch{
      // The durable row and notification tag retain an uncertain delivery.
    }
    if(status!==undefined&&status>=200&&status<300){
      const completed=await db.batch([
        db.prepare('UPDATE push_subscriptions SET failures=0,last_ok_at=? WHERE id=? AND session_hash=? AND endpoint=? AND p256dh=? AND auth=?')
          .bind(Date.now(),row.push_subscription_id,row.session_hash,row.endpoint,row.p256dh,row.auth),
        db.prepare('UPDATE email_outbox SET sent_at=?,last_error=NULL,lease_id=NULL,lease_until=NULL WHERE id=? AND lease_id=? AND changes()=1').bind(Date.now(),row.id,lease),
      ]);
      if(!completed[1].meta.changes)await finish('subscription_changed',true);
    }else{
      const failed=await db.prepare('UPDATE push_subscriptions SET failures=failures+1 WHERE id=? AND session_hash=? AND endpoint=? AND p256dh=? AND auth=?')
        .bind(row.push_subscription_id,row.session_hash,row.endpoint,row.p256dh,row.auth).run();
      if(!failed.meta.changes){await finish('subscription_changed',true);continue;}
      await finish(status===undefined?'push_unconfirmed':'push_'+status,row.attempts+1<5&&(status===undefined||status===429||status>=500));
      await db.prepare('DELETE FROM push_subscriptions WHERE id=? AND session_hash=? AND endpoint=? AND p256dh=? AND auth=? AND (? IN(404,410) OR failures>=5)')
        .bind(row.push_subscription_id,row.session_hash,row.endpoint,row.p256dh,row.auth,status??0).run();
    }
  }
}
