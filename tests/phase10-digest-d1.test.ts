import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {openAuditFixture,type AuditFixture} from './audit-fixture';
import {enqueueEmailDigests,emailDigestApi} from '../worker/emailDigest';
import {sendNotificationEmails,unsubscribeApi} from '../worker/notificationEmail';
import {applyChanges} from '../worker/sync';
import {withD1Budget,d1BudgetRemaining} from '../worker/d1budget';
import {buildEmailDigest} from '../shared/emailDigest';
import type {AttentionItem} from '../shared/attention';
import {WEBSITE_INBOX_ID} from '../shared/websiteInbox';
import {collectAttention} from '../worker/attention';

let f: AuditFixture;
const sink = vi.fn<Fetcher['fetch']>();
const morning = Date.parse('2026-11-16T01:30:00Z');
beforeEach(async () => {
  vi.spyOn(Date,'now').mockReturnValue(morning);
  sink.mockReset();
  sink.mockImplementation(async () => Response.json({id:'digest-receipt'}));
  f = await openAuditFixture(undefined,{
    EMAIL_PROVIDER:'simulated',WORKSPACE_ENV:'local-test',
    EMAIL_APP_ORIGIN:'https://workspace.example.test',EMAIL_LINK_KEY:crypto.randomUUID(),
    EMAIL_TEST_SINK:{fetch:sink},
  });
  await f.db.batch([
    f.db.prepare("UPDATE workspace_settings SET time_zone='Asia/Kolkata'"),
    f.db.prepare("UPDATE users SET email='bob@example.test',email_verified_at=1,prefs=? WHERE id='bob'")
      .bind(JSON.stringify({emailDigest:'daily',digestHour:7})),
  ]);
});
afterEach(async () => {vi.restoreAllMocks();await f?.dispose();});

async function seed() {
  const applied = await applyChanges(f.env,'alice',[
    {id:'work',collection:'boards',ts:1,patch:{name:'Work',columns:[{id:'open'},{id:'done'}]}},
    {id:'today',collection:'tasks',ts:1,patch:{title:'<Due & safe>',boardId:'work',status:'open',assigneeId:'bob',dueDate:'2026-11-16',description:'NEVER_EMAIL_ANSWERS'}},
    {id:WEBSITE_INBOX_ID,collection:'boards',ts:1,patch:{name:'Website',kind:'records',columns:[{id:'new'},{id:'done'}],
      attention:{enabled:true,personKey:'assigneeId',triage:true,triagers:['bob']}}},
    {id:'new-submission',collection:'tasks',ts:1,patch:{title:'New application',boardId:WEBSITE_INBOX_ID,status:'new',createdAt:morning,p_wi_received:'2026-11-16'}},
  ],{serverTs:true});
  expect(applied.rejectedItems).toBeUndefined();
  await f.db.prepare("INSERT OR REPLACE INTO date_index(record_id,field_key,date) VALUES('today','dueDate','2026-11-16')").run();
  await f.db.prepare("INSERT INTO notifications(id,user_id,kind,target_type,target_id,title,created_at) VALUES('mention','bob','mention','record','today','OLD_COPY',?)").bind(morning).run();
}
async function drain() {
  const env = withD1Budget(f.env);
  await sendNotificationEmails(env);
  expect(d1BudgetRemaining(env.DB)).toBeGreaterThanOrEqual(0);
}
const body = () => JSON.parse(String(sink.mock.lastCall?.[1]?.body));

it('groups visible sources and omits restricted entries and duplicate references', () => {
  const item:AttentionItem={key:'1',kind:'approval_pending',targetType:'approval',targetId:'a',title:'Review',url:'/approvals',severity:3,actions:[]};
  const sections=buildEmailDigest([item,{...item,key:'2'},{...item,key:'3',targetId:'b',restricted:true}], '2026-11-16');
  expect(sections).toHaveLength(1);
  expect(sections[0]).toMatchObject({heading:'Needs you',items:[item]});
});

it('deduplicates concurrent daily scheduling at the local hour and midnight', async () => {
  await enqueueEmailDigests(f.env,morning-60_000);
  expect(await f.db.prepare('SELECT COUNT(*) FROM email_outbox').first('COUNT(*)')).toBe(0);
  await Promise.all([enqueueEmailDigests(f.env,morning),enqueueEmailDigests(f.env,morning)]);
  expect(await f.db.prepare('SELECT digest_key FROM email_outbox').first('digest_key')).toBe('d:2026-11-16');
  await enqueueEmailDigests(f.env,Date.parse('2026-11-16T18:31:00Z'));
  expect(await f.db.prepare('SELECT COUNT(*) FROM email_outbox').first('COUNT(*)')).toBe(1);
  await enqueueEmailDigests(f.env,morning+86_400_000);
  expect(await f.db.prepare('SELECT COUNT(*) FROM email_outbox').first('COUNT(*)')).toBe(2);
});

it('deduplicates weekly schedules and excludes unverified or disabled recipients', async () => {
  await f.db.prepare("UPDATE users SET prefs=? WHERE id='bob'").bind(JSON.stringify({emailDigest:'weekly'})).run();
  await enqueueEmailDigests(f.env,morning);
  await enqueueEmailDigests(f.env,morning+3*86_400_000);
  expect(await f.db.prepare('SELECT COUNT(*) FROM email_outbox').first('COUNT(*)')).toBe(1);
  await enqueueEmailDigests(f.env,morning+7*86_400_000);
  expect(await f.db.prepare('SELECT COUNT(*) FROM email_outbox').first('COUNT(*)')).toBe(2);
  await f.db.prepare("UPDATE users SET disabled_at=1 WHERE id='bob'").run();
  await enqueueEmailDigests(f.env,morning+14*86_400_000);
  expect(await f.db.prepare('SELECT COUNT(*) FROM email_outbox').first('COUNT(*)')).toBe(2);
});

it.each([false,true])('sends current gated sections with title opt-in and unsubscribe (permissions=%s)', async enabled => {
  await seed();
  await f.db.batch([
    f.db.prepare('UPDATE access_state SET enabled=?').bind(enabled?1:0),
    f.db.prepare("INSERT OR IGNORE INTO space_members(space_id,user_id,role) VALUES('space-core','bob','viewer')"),
    f.db.prepare('UPDATE workspace_settings SET email_show_titles=1'),
  ]);
  await enqueueEmailDigests(f.env,morning);
  const queue = await collectAttention(f.env,'bob');
  expect(queue.items.some(item=>item.targetId==='today')).toBe(true);
  await drain();
  expect(sink).toHaveBeenCalledTimes(1);
  expect(body().text).toContain('Due today (1)');
  expect(body().text).toContain('Unread mentions (1)');
  expect(body().text).toContain('New on the Website inbox (1)');
  expect(body().html).toContain('&lt;Due &amp; safe&gt;');
  expect(body().text).toContain('https://workspace.example.test/');
  expect(body().text).not.toMatch(/NEVER_EMAIL_ANSWERS|OLD_COPY/);
  const link = body().headers['List-Unsubscribe'].slice(1,-1);
  const response = await unsubscribeApi.request('/unsubscribe'+new URL(link).search,{method:'POST'},f.env,f.ctx);
  expect(response.status).toBe(200);
  expect(JSON.parse(await f.db.prepare("SELECT prefs FROM users WHERE id='bob'").first<string>('prefs')??'{}').emailDigest).toBe('off');
});

it('keeps titles private by default and stops queued digests after opt-out', async () => {
  await seed();
  await enqueueEmailDigests(f.env,morning);
  await drain();
  expect(body().text).toContain('Due today');
  expect(body().text).not.toContain('<Due & safe>');
  await enqueueEmailDigests(f.env,morning+86_400_000);
  await f.db.prepare("UPDATE email_outbox SET next_attempt_at=0").run();
  await f.db.prepare("UPDATE users SET prefs='{}' WHERE id='bob'").run();
  await drain();
  expect(sink).toHaveBeenCalledTimes(1);
});

it('skips empty scheduled digests and explicitly queues authenticated test digests', async () => {
  await enqueueEmailDigests(f.env,morning);
  await drain();
  expect(sink).not.toHaveBeenCalled();
  expect(await f.db.prepare('SELECT last_error FROM email_outbox').first('last_error')).toBe('digest_empty');
  expect((await emailDigestApi.request('/test',{method:'POST'},f.env,f.ctx)).status).toBe(401);
  for (let i=0;i<2;i++) {
    expect((await emailDigestApi.request('/test',{method:'POST',headers:f.auth('bob')},f.env,f.ctx)).status).toBe(202);
  }
  expect((await emailDigestApi.request('/test',{method:'POST',headers:f.auth('bob')},f.env,f.ctx)).status).toBe(429);
  await drain();
  expect(sink).toHaveBeenCalledTimes(2);
  expect(body().text).toContain('nothing in your digest');
});

it('omits revoked records and holds an uncertain digest if its source changed', async () => {
  await seed();
  await f.db.batch([
    f.db.prepare('UPDATE workspace_settings SET email_show_titles=1'),
    f.db.prepare('UPDATE access_state SET enabled=1'),
    f.db.prepare("UPDATE users SET workspace_role='guest' WHERE id='bob'"),
  ]);
  await enqueueEmailDigests(f.env,morning);
  await drain();
  expect(sink).not.toHaveBeenCalled();
  await f.db.prepare("INSERT INTO space_members(space_id,user_id,role) VALUES('space-core','bob','viewer')").run();
  expect((await emailDigestApi.request('/test',{method:'POST',headers:f.auth('bob')},f.env,f.ctx)).status).toBe(202);
  sink.mockRejectedValueOnce(new Error('simulated lost acknowledgement'));
  await drain();
  await f.db.prepare("UPDATE records SET data=json_set(data,'$.title','Changed'),seq=seq+1 WHERE id='today'").run();
  await f.db.prepare('UPDATE email_outbox SET next_attempt_at=0 WHERE terminal_at IS NULL').run();
  await drain();
  expect(sink).toHaveBeenCalledTimes(1);
  expect(await f.db.prepare("SELECT COUNT(*) FROM email_outbox WHERE last_error='delivery_payload_changed'").first('COUNT(*)')).toBe(1);
});

it('fences a record change between collecting titles and committing the send', async () => {
  await seed();
  await f.db.prepare('UPDATE workspace_settings SET email_show_titles=1').run();
  await enqueueEmailDigests(f.env,morning);
  let raced = false;
  const database = new Proxy(f.db, {get(target,key) {
    if (key === 'prepare') return (sql:string) => {
      const statement = target.prepare(sql);
      if (!sql.includes('SET payload_hash=')) return statement;
      return new Proxy(statement,{get(prepared,property) {
        if (property === 'bind') return (...values:Parameters<D1PreparedStatement['bind']>) => {
          const bound = prepared.bind(...values);
          return new Proxy(bound,{get(result,operation) {
            if (operation === 'run') return async () => {
              raced = true;
              await target.prepare("UPDATE records SET seq=seq+1 WHERE id='today'").run();
              return result.run();
            };
            const value = Reflect.get(result,operation);
            return typeof value === 'function' ? value.bind(result) : value;
          }});
        };
        const value = Reflect.get(prepared,property);
        return typeof value === 'function' ? value.bind(prepared) : value;
      }});
    };
    const value = Reflect.get(target,key);
    return typeof value === 'function' ? value.bind(target) : value;
  }});
  await sendNotificationEmails(withD1Budget({...f.env,DB:database}));
  expect(raced).toBe(true);
  expect(sink).not.toHaveBeenCalled();
  expect(await f.db.prepare('SELECT last_error FROM email_outbox').first('last_error')).toBe('recipient_changed');
});
