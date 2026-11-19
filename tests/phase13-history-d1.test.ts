import {afterEach, expect, it, vi} from 'vitest';
vi.mock('../worker/events', async original => ({...await original<typeof import('../worker/events')>(), scheduleOutbox: vi.fn()}));
import {openAuditFixture, type AuditFixture} from './audit-fixture';
import {applyChanges} from '../worker/sync';
import {historyApi, loadBodyHistory} from '../worker/history';
import {withD1Budget, d1BudgetRemaining} from '../worker/d1budget';

let fixture: AuditFixture;
afterEach(async () => {vi.restoreAllMocks(); await fixture?.dispose();});
async function setup(enabled = true) {
  fixture = await openAuditFixture();
  await fixture.db.prepare('UPDATE access_state SET enabled=?').bind(enabled ? 1 : 0).run();
  await write('pages', 'first', {title:'First page'});
  await write('pages', 'second', {title:'Second page'});
}
async function write(collection: string, id: string, patch: Record<string, unknown>) {
  const result = await applyChanges(fixture.env, 'alice', [{collection, id, patch, ts:Date.now()}], {serverTs:true});
  expect(result.partialError).toBeUndefined(); expect(result.rejected).toBe(0);
}
it.each([false, true])('records complete added, edited, moved and removed blocks with permission mode %s', async enabled => {
  await setup(enabled);
  await write('blocks', 'answer', {pageId:'first', type:'p', text:'Original answer'});
  await write('blocks', 'answer', {text:'Updated answer'});
  await write('blocks', 'answer', {pageId:'second'});
  await write('blocks', 'answer', {deleted:true});
  const first = await loadBodyHistory(fixture.db, 'alice', 'first');
  expect(first.entries.map(row => row.change)).toEqual(['removed', 'changed', 'added']);
  expect(first.entries[0]).toMatchObject({before:{text:'Updated answer'}, after:{text:'Updated answer'}});
  const second = await loadBodyHistory(fixture.db, 'alice', 'second');
  expect(second.entries.map(row => row.change)).toEqual(['removed', 'added']);
  expect(second.entries[0].before.text).toBe('Updated answer');
  expect(second.entries[0].currentRevision).toBeGreaterThan(0);
  expect(first.coverage).toContain('0044');
  const page = await loadBodyHistory(fixture.db, 'alice', 'first', undefined, 1);
  expect(page.nextBefore).toBeTruthy();
  const next = await loadBodyHistory(fixture.db, 'alice', 'first', page.nextBefore!, 1);
  expect(next.entries[0].revision).toBeLessThan(page.entries[0].revision);
});
it('excludes history without retained parent metadata and bounds candidate work', async () => {
  await setup();
  await write('blocks', 'legacy', {pageId:'first', type:'p', text:'Legacy source'});
  await fixture.db.prepare("UPDATE record_history SET before_parent_id=NULL,after_parent_id=NULL,was_created=NULL WHERE record_id='legacy'").run();
  expect((await loadBodyHistory(fixture.db, 'alice', 'first')).entries).toEqual([]);
  const changes = Array.from({length:60}, (_, i) => ({id:'bounded-'+i, collection:'blocks', patch:{pageId:'first',type:'p',text:'Answer '+i},ts:Date.now()}));
  const result = await applyChanges(fixture.env, 'alice', changes, {serverTs:true});expect(result.changed).toBe(60);
  const env = withD1Budget(fixture.env);
  const page = await loadBodyHistory(env.DB, 'alice', 'first', undefined, 50);
  expect(page.entries).toHaveLength(50);expect(page.nextBefore).not.toBeNull();
  expect(40-d1BudgetRemaining(env.DB)).toBeLessThanOrEqual(9);
  const plan = await fixture.db.prepare('EXPLAIN QUERY PLAN SELECT revision FROM record_history WHERE revision<? AND (before_parent_id=? OR after_parent_id=?) ORDER BY revision DESC LIMIT 51')
    .bind(Number.MAX_SAFE_INTEGER, 'first', 'first').all<{detail:string}>();
  expect(plan.results.map(row => row.detail).join(' ')).toContain('record_history_before_parent');
});
it('keeps moved block history private when its current destination is private', async () => {
  await setup(false);
  await fixture.db.prepare("INSERT INTO spaces(id,name,default_access,export_policy,created_by,created_at) VALUES('private','Private','private','members','alice',1)").run();
  await fixture.db.prepare("INSERT INTO space_members(space_id,user_id,role) VALUES('private','alice','owner')").run();
  await write('pages', 'private-page', {title:'Private'});
  await fixture.db.prepare("UPDATE records SET space_id='private' WHERE id='private-page'").run();
  await write('blocks', 'moved', {pageId:'first',type:'p',text:'Private after movement'});
  await write('blocks', 'moved', {pageId:'private-page'});
  // Prepare legacy moved data, then verify its current permission-aware reads.
  await fixture.db.prepare('UPDATE access_state SET enabled=1').run();
  const reply = await loadBodyHistory(fixture.db, 'bob', 'first');
  expect(reply.entries).toEqual([]);
  await expect(loadBodyHistory(fixture.db, 'bob', 'private-page')).rejects.toThrow('not_found');
});
it('restores selected block fields through the existing revision-fenced job', async () => {
  await setup();
  await write('blocks', 'answer', {pageId:'first',type:'p',text:'Original'});
  await write('blocks', 'answer', {text:'Revised'});
  const entry = (await loadBodyHistory(fixture.db, 'alice', 'first')).entries[0];
  const response = await historyApi.request('/answer/restore', {method:'POST',headers:fixture.auth('alice'),body:JSON.stringify({revision:entry.revision,expectedRev:entry.currentRevision,fields:['text'],side:'before',requestId:'body-restore'})}, fixture.env, fixture.ctx);
  expect(response.status).toBe(200);
  const row = await fixture.db.prepare("SELECT data FROM records WHERE id='answer'").first<{data:string}>();
  expect(JSON.parse(row!.data).text).toBe('Original');
});
it('rejects access revoked during a body history read', async () => {
  await setup();
  await fixture.db.prepare("UPDATE users SET workspace_role='guest' WHERE id='bob'").run();
  await fixture.db.prepare("INSERT INTO space_members(space_id,user_id,role) VALUES('space-core','bob','viewer')").run();
  await write('blocks', 'answer', {pageId:'first',type:'p',text:'Answer'});
  const access = await import('../worker/access');
  const load = access.loadAccessContext;
  let reads = 0;
  vi.spyOn(access, 'loadAccessContext').mockImplementation(async (...args) => {
    if (++reads === 2) await fixture.db.prepare("DELETE FROM space_members WHERE user_id='bob'").run();
    return load(...args);
  });
  await expect(loadBodyHistory(fixture.db, 'bob', 'first')).rejects.toThrow('not_found');
});
