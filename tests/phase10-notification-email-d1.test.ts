import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {openAuditFixture,type AuditFixture} from './audit-fixture';
import {channelsFor,loadPrefs,sanitizePrefs} from '../worker/auth';
import {sendNotificationEmails,unsubscribeApi} from '../worker/notificationEmail';
import {notify} from '../worker/notifications';
import {d1BudgetRemaining,withD1Budget} from '../worker/d1budget';

let f: AuditFixture;
const endpoint = 'https://workspace.example.test';
const notice = {userId:'bob',kind:'mention' as const,targetType:'page',targetId:'private',
  title:'Stored title',body:'PRIVATE BODY',dedupeKey:'delivery'};
const post = vi.fn<Fetcher['fetch']>();

beforeEach(async () => {
  post.mockReset();
  post.mockImplementation(async () => Response.json({id:'simulated-receipt'}));
  f=await openAuditFixture(undefined,{
    EMAIL_PROVIDER:'simulated',WORKSPACE_ENV:'local-test',EMAIL_APP_ORIGIN:endpoint,
    EMAIL_LINK_KEY:crypto.randomUUID(),EMAIL_TEST_SINK:{fetch:post},
  });
  await f.db.batch([
    f.db.prepare("UPDATE users SET email='bob@example.test',email_verified_at=1,prefs=? WHERE id='bob'")
      .bind(JSON.stringify({notifications:{mention:['inbox','email','push']}})),
    f.db.prepare("INSERT INTO records(id,collection,data,field_ts,seq) VALUES('private','pages',?,'{}',1)")
      .bind(JSON.stringify({title:'<Private & readable>'})),
  ]);
});
afterEach(async()=>{await f?.dispose();});

async function drain() {
  const env = withD1Budget(f.env);
  await sendNotificationEmails(env);
  expect(40 - d1BudgetRemaining(env.DB)).toBeLessThanOrEqual(40);
}
const sentBody = () => JSON.parse(String(post.mock.lastCall?.[1]?.body));
const makeDue = () => f.db.prepare('UPDATE email_outbox SET next_attempt_at=0').run();

it('normalizes legacy and multichannel preferences', () => {
  const prefs=sanitizePrefs({notifications:{mention:['push','invalid','email','email'],assigned:'off'},digestHour:25});
  expect([...channelsFor(prefs,'mention')]).toEqual(['inbox','email','push']);
  expect([...channelsFor(prefs,'assigned')]).toEqual([]);
  expect([...channelsFor(prefs,'due_soon')]).toEqual(['inbox']);
  expect(prefs.digestHour).toBeUndefined();
});

it('queues in the Inbox transaction, collapses replay and excludes body and title by default',async()=>{
  await expect(notify(f.env,notice,[f.db.prepare("SELECT json_extract('{','$')")])).rejects.toThrow();
  expect(await f.db.prepare('SELECT COUNT(*) n FROM notifications').first('n')).toBe(0);
  expect(await f.db.prepare('SELECT COUNT(*) n FROM email_outbox').first('n')).toBe(0);
  await notify(f.env,notice);
  await notify(f.env,notice);
  expect(await f.db.prepare('SELECT COUNT(*) n FROM email_outbox').first('n')).toBe(1);
  await Promise.all([drain(),drain()]);
  expect(post).toHaveBeenCalledTimes(1);
  expect(sentBody().text).toContain('You were mentioned');
  expect(sentBody().text).not.toMatch(/Private|Stored title|PRIVATE BODY/);
  expect(await f.db.prepare('SELECT provider_id FROM email_outbox').first('provider_id')).toBe('simulated-receipt');
});

it('escapes readable titles and uses generic text after access revocation',async()=>{
  await f.db.batch([
    f.db.prepare('UPDATE access_state SET enabled=1'),
    f.db.prepare("UPDATE users SET workspace_role='guest' WHERE id='bob'"),
    f.db.prepare("INSERT INTO space_members(space_id,user_id,role) VALUES('space-core','bob','viewer')"),
    f.db.prepare('UPDATE workspace_settings SET email_show_titles=1'),
  ]);
  await notify(f.env,notice);
  await drain();
  expect(sentBody().html).toContain('&lt;Private &amp; readable&gt;');
  expect(sentBody().text).not.toContain('PRIVATE BODY');
  await notify(f.env,{...notice,dedupeKey:'revoked'});
  await f.db.prepare("DELETE FROM space_members WHERE user_id='bob'").run();
  await drain();
  expect(sentBody().text).toContain('You have a new notification in TCG Workspace');
  expect(sentBody().text).not.toContain('Private');
});

it('retries identical bytes and stops when a confirmed identity or rendered payload changes',async()=>{
  post.mockRejectedValueOnce(new Error('disposable acknowledgement loss'));
  await notify(f.env,notice);
  await drain();
  await makeDue();
  await drain();
  expect(post).toHaveBeenCalledTimes(2);
  expect(post.mock.calls[1][1]?.headers).toEqual(post.mock.calls[0][1]?.headers);
  expect(post.mock.calls[1][1]?.body).toEqual(post.mock.calls[0][1]?.body);
  await notify(f.env,{...notice,dedupeKey:'changed'});
  post.mockRejectedValueOnce(new Error('disposable acknowledgement loss'));
  await drain();
  await f.db.prepare('UPDATE workspace_settings SET email_show_titles=1').run();
  await makeDue();
  await drain();
  expect(post).toHaveBeenCalledTimes(3);
  expect(await f.db.prepare("SELECT COUNT(*) n FROM email_outbox WHERE last_error='delivery_payload_changed' AND terminal_at IS NOT NULL").first('n')).toBe(1);
  await notify(f.env,{...notice,dedupeKey:'new-address'});
  await f.db.prepare("UPDATE users SET email_verified_at=2 WHERE id='bob'").run();
  await drain();
  expect(post).toHaveBeenCalledTimes(3);
});

it('requires a valid link and explicit POST to unsubscribe while retaining Inbox and push',async()=>{
  await notify(f.env,notice);
  await drain();
  const link = sentBody().headers['List-Unsubscribe'].slice(1,-1);
  const path = '/unsubscribe'+new URL(link).search;
  expect((await unsubscribeApi.request(path+'invalid',{method:'POST'},f.env,f.ctx)).status).toBe(400);
  expect((await unsubscribeApi.request(path,{},f.env,f.ctx)).status).toBe(200);
  expect(channelsFor(await loadPrefs(f.db,'bob'),'mention').has('email')).toBe(true);
  expect((await unsubscribeApi.request(path,{method:'POST'},f.env,f.ctx)).status).toBe(200);
  expect([...channelsFor(await loadPrefs(f.db,'bob'),'mention')]).toEqual(['inbox','push']);
  await notify(f.env,{...notice,dedupeKey:'opt-out'});
  await drain();
  expect(post).toHaveBeenCalledTimes(1);
});

it('reclaims expired leases, caps retries and holds uncertain sends beyond the provider window',async()=>{
  post.mockImplementation(async () => new Response(null,{status:429}));
  await notify(f.env,notice);
  await f.db.prepare("UPDATE email_outbox SET lease_until=?,lease_id='other'").bind(Date.now()+60_000).run();
  await drain();
  expect(post).not.toHaveBeenCalled();
  await f.db.prepare('UPDATE email_outbox SET lease_until=0,attempts=7').run();
  await drain();
  expect(post).toHaveBeenCalledTimes(1);
  expect(await f.db.prepare('SELECT attempts FROM email_outbox WHERE terminal_at IS NOT NULL').first('attempts')).toBe(8);
  await notify(f.env,{...notice,dedupeKey:'outside-window'});
  await f.db.prepare('UPDATE email_outbox SET attempts=1,created_at=? WHERE terminal_at IS NULL').bind(Date.now()-86_400_000).run();
  await drain();
  expect(post).toHaveBeenCalledTimes(1);
  expect(await f.db.prepare("SELECT COUNT(*) n FROM email_outbox WHERE last_error='delivery_requires_review'").first('n')).toBe(1);
});
