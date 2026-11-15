import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {openAuditFixture,type AuditFixture} from './audit-fixture';
import {pushApi,sendPushNotifications} from '../worker/push';
import {notify} from '../worker/notifications';
import {sendNotificationEmails} from '../worker/notificationEmail';
import {pushBase64,pushBytes} from '../worker/webpush';
import {withD1Budget,d1BudgetRemaining} from '../worker/d1budget';

// Public RFC 8291 receiver fixture, never an operational subscription.
const receiver='BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
const secret='BTBZMqHH6r4Tts7J_aSIgg';
const subscription={endpoint:'https://fcm.googleapis.com/send/disposable-fixture',keys:{p256dh:receiver,auth:secret}};
const notice={userId:'bob',kind:'mention' as const,targetType:'page',targetId:'private',title:'OLD_COPY',body:'NEVER_SEND_ANSWERS',dedupeKey:'push'};
let f:AuditFixture;
const sink=vi.fn<Fetcher['fetch']>(),email=vi.fn<Fetcher['fetch']>();
beforeEach(async()=>{
  sink.mockReset();sink.mockImplementation(async()=>new Response(null,{status:201}));
  email.mockReset();email.mockImplementation(async()=>Response.json({id:'email-fixture'}));
  f=await openAuditFixture(undefined,{
    WEB_PUSH:'simulated',WORKSPACE_ENV:'local-test',PUSH_TEST_SINK:{fetch:sink},VAPID_PUBLIC_KEY:receiver,
    EMAIL_PROVIDER:'simulated',EMAIL_TEST_SINK:{fetch:email},EMAIL_APP_ORIGIN:'https://workspace.example.test',
    EMAIL_LINK_KEY:crypto.randomUUID(),
  });
  await f.db.batch([
    f.db.prepare("UPDATE users SET email='fixture@example.test',email_verified_at=1,prefs=? WHERE id='bob'")
      .bind(JSON.stringify({notifications:{mention:['inbox','email','push']}})),
    f.db.prepare("INSERT INTO records(id,collection,data,field_ts,seq) VALUES('private','pages',?,'{}',1)")
      .bind(JSON.stringify({title:'Current private title'})),
  ]);
});
afterEach(async()=>{await f?.dispose();});
const register=(user='bob',value=subscription)=>pushApi.request('/subscriptions',{method:'POST',headers:f.auth(user),body:JSON.stringify(value)},f.env,f.ctx);
async function drain(){
  const env=withD1Budget(f.env);
  await sendPushNotifications(env);
  expect(d1BudgetRemaining(env.DB)).toBeGreaterThanOrEqual(0);
}
async function payload() {
  const body=sink.mock.lastCall?.[1]?.body as Uint8Array<ArrayBuffer>;
  const sender=body.slice(21,86),raw=pushBytes(receiver);
  const key=await crypto.subtle.importKey('jwk',{
    kty:'EC',crv:'P-256',x:pushBase64(raw.slice(1,33)),y:pushBase64(raw.slice(33)),
    d:'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  },{name:'ECDH',namedCurve:'P-256'},false,['deriveBits']);
  const publicKey=await crypto.subtle.importKey('raw',sender,{name:'ECDH',namedCurve:'P-256'},false,[]);
  const shared=await crypto.subtle.deriveBits({name:'ECDH',public:publicKey},key,256);
  const info=new Uint8Array([...new TextEncoder().encode('WebPush: info\0'),...raw,...sender]);
  const material=await crypto.subtle.importKey('raw',shared,'HKDF',false,['deriveBits']);
  const ikm=await crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt:pushBytes(secret),info},material,256);
  const content=await crypto.subtle.importKey('raw',ikm,'HKDF',false,['deriveBits','deriveKey']);
  const salt=body.slice(0,16);
  const cek=await crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt,info:new TextEncoder().encode('Content-Encoding: aes128gcm\0')},content,{name:'AES-GCM',length:128},false,['decrypt']);
  const iv=await crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt,info:new TextEncoder().encode('Content-Encoding: nonce\0')},content,96);
  const plaintext=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv},cek,body.slice(86)));
  expect(plaintext.at(-1)).toBe(2);
  return JSON.parse(new TextDecoder().decode(plaintext.slice(0,-1)));
}

it('authenticates subscriptions, constrains endpoints and protects endpoint ownership',async()=>{
  expect((await pushApi.request('/subscriptions',{method:'POST',body:JSON.stringify(subscription)},f.env,f.ctx)).status).toBe(401);
  expect((await register('bob',{...subscription,endpoint:'https://evil.example.test/p'})).status).toBe(400);
  expect((await register()).status).toBe(200);
  expect((await register()).status).toBe(200);
  expect((await register('alice')).status).toBe(409);
  expect(await f.db.prepare('SELECT COUNT(*) FROM push_subscriptions').first('COUNT(*)')).toBe(1);
  expect((await pushApi.request('/config',{headers:f.auth('bob')},f.env,f.ctx)).status).toBe(200);
});
it('atomically queues both channels, deduplicates replay and encrypts one generic device delivery',async()=>{
  await register();
  await expect(notify(f.env,notice,[f.db.prepare("SELECT json_extract('{','$')")])).rejects.toThrow();
  expect(await f.db.prepare('SELECT COUNT(*) FROM email_outbox').first('COUNT(*)')).toBe(0);
  await notify(f.env,notice);await notify(f.env,notice);
  expect(await f.db.prepare('SELECT COUNT(*) FROM email_outbox').first('COUNT(*)')).toBe(2);
  await Promise.all([drain(),drain()]);
  expect(sink).toHaveBeenCalledTimes(1);
  expect(await payload()).toMatchObject({title:'New activity in TCG Workspace',url:'/inbox',userId:'bob'});
  expect(JSON.stringify(await payload())).not.toMatch(/OLD_COPY|NEVER_SEND_ANSWERS|Current private title/);
  await sendNotificationEmails(withD1Budget(f.env));
  expect(email).toHaveBeenCalledTimes(1);
  expect(sink.mock.lastCall?.[0]).toBe('https://push-simulator.invalid');
  expect(sink.mock.lastCall?.[1]?.redirect).toBe('error');
});
it('checks current access for optional titles and falls back after revocation',async()=>{
  await register();
  await f.db.batch([
    f.db.prepare('UPDATE access_state SET enabled=1'),
    f.db.prepare("UPDATE users SET workspace_role='guest',prefs=json_set(prefs,'$.pushShowContent',json('true')) WHERE id='bob'"),
    f.db.prepare("INSERT INTO space_members(space_id,user_id,role) VALUES('space-core','bob','viewer')"),
  ]);
  await notify(f.env,notice);await drain();
  expect((await payload()).title).toBe('Current private title');
  await notify(f.env,{...notice,dedupeKey:'revoke'});
  await f.db.prepare("DELETE FROM space_members WHERE user_id='bob'").run();
  await drain();
  expect(sink).toHaveBeenCalledTimes(2);
  expect((await payload()).title).toBe('New activity in TCG Workspace');
});
it.each(['disabled','expired','opt-out'])('stops pending push after recipient becomes %s',async reason=>{
  await register();await notify(f.env,notice);
  if(reason==='disabled')await f.db.prepare("UPDATE users SET disabled_at=1 WHERE id='bob'").run();
  if(reason==='expired')await f.db.prepare("UPDATE sessions SET expires_at=0 WHERE user_id='bob'").run();
  if(reason==='opt-out')await f.db.prepare("UPDATE users SET prefs='{}' WHERE id='bob'").run();
  await drain();expect(sink).not.toHaveBeenCalled();
});
it.each([404,410])('removes a subscription after service response %s',async status=>{
  await register();await notify(f.env,notice);
  sink.mockImplementation(async()=>new Response(null,{status}));
  await drain();
  expect(await f.db.prepare('SELECT COUNT(*) FROM push_subscriptions').first('COUNT(*)')).toBe(0);
});
it('bounds failures and cascades session revocation through subscriptions and pending deliveries',async()=>{
  await register();await notify(f.env,notice);
  sink.mockImplementation(async()=>new Response(null,{status:503}));
  for(let i=0;i<5;i++){
    await f.db.prepare('UPDATE email_outbox SET next_attempt_at=0').run();
    await drain();
  }
  expect(sink).toHaveBeenCalledTimes(5);
  expect(await f.db.prepare('SELECT COUNT(*) FROM push_subscriptions').first('COUNT(*)')).toBe(0);
  await register();await notify(f.env,{...notice,dedupeKey:'revoked-session'});
  await f.db.prepare("DELETE FROM sessions WHERE user_id='bob'").run();
  expect(await f.db.prepare('SELECT COUNT(*) FROM push_subscriptions').first('COUNT(*)')).toBe(0);
  expect(await f.db.prepare('SELECT COUNT(*) FROM email_outbox WHERE push_subscription_id IS NOT NULL').first('COUNT(*)')).toBe(0);
});

it.each([201,410])('holds a late %s response after subscription keys change',async status=>{
  await register();await notify(f.env,notice);
  sink.mockImplementationOnce(async()=>{
    await f.db.prepare('UPDATE push_subscriptions SET auth=?').bind(pushBase64(new Uint8Array(16).fill(7))).run();
    return new Response(null,{status});
  });
  await drain();
  expect(await f.db.prepare('SELECT COUNT(*) FROM push_subscriptions').first('COUNT(*)')).toBe(1);
  expect(await f.db.prepare("SELECT last_error FROM email_outbox WHERE push_subscription_id IS NOT NULL").first('last_error')).toBe('subscription_changed');
  await f.db.prepare('UPDATE email_outbox SET next_attempt_at=0 WHERE push_subscription_id IS NOT NULL').run();
  await drain();
  expect(sink).toHaveBeenCalledTimes(2);
  expect(await f.db.prepare('SELECT COUNT(*) FROM email_outbox WHERE push_subscription_id IS NOT NULL AND sent_at IS NOT NULL').first('COUNT(*)')).toBe(1);
});
