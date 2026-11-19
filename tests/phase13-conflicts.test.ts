import 'fake-indexeddb/auto';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {LocalDB} from '../src/core/db';
import {losingFields, retainAcknowledged, observeConflicts, pruneRecovery, resolveConflict, conflictKey, CONFLICT_RETENTION, type ConflictEnvelope} from '../src/core/sync/conflicts';
import {applyFeedPage, installManifest} from '../src/core/sync/accessCache';
import {feedOf, manifestFor, page, record, requestFor, replyFor} from './feed-cache-fixture';
let store: LocalDB, userId: string;
const now = Date.now();
const candidate = {field:'title', mine:'My work', mineTs:10, at:now};
const remote = {data:{title:'Other work'}, field_ts:{title:20}};
beforeEach(async () => {userId='conflict-'+crypto.randomUUID();store = new LocalDB('workspace-' + userId); await store.open();});
afterEach(async () => {await store.delete();});
const read = async (id = 'a') => (await store.meta.get(conflictKey(id)))?.value as ConflictEnvelope | undefined;
const ack = (id = 'a', ts = 10) => retainAcknowledged(store, [{id, collection:'pages', patch:{title:'My work'}, ts}], now);
const observe = (id = 'a') => observeConflicts(store, 'pages', id, remote, [], now);

it('detects lost pending fields, including equal timestamp divergence, without inventing an actor', () => {
  const result = losingFields(remote, [], [{id:'a',patch:{title:'My work'},ts:20}], now);
  expect(result).toMatchObject([{...candidate,mineTs:20,theirs:'Other work',theirsTs:20,theirsBy:null}]);
  expect(losingFields(remote, [candidate], [{id:'a',patch:{title:'Latest work'},ts:30}], now)).toEqual([]);
});
it('settles equal values, ignores old remote versions, expired candidates and guarded/refused edits', () => {
  expect(losingFields({data:{title:'My work'},field_ts:{title:30}}, [candidate], [], now)).toEqual([]);
  expect(losingFields({data:{title:'Old'},field_ts:{title:1}}, [candidate], [], now)).toEqual([]);
  expect(losingFields(remote, [{...candidate,at:now-CONFLICT_RETENTION}], [], now)).toEqual([]);
  expect(losingFields(remote, [], [{id:'a',patch:{title:'Guarded'},ts:10,ifUnchanged:{fields:{title:'Old'}}},{id:'a',patch:{title:'Refused'},ts:10,state:'rejected'}], now)).toEqual([]);
});
it('survives queue acknowledgement and restart before the losing server echo', async () => {
  await store.transaction('rw', store.outbox, store.meta, async () => {await store.outbox.add({id:'a',collection:'pages',patch:{title:'My work'},ts:10}); await ack(); await store.outbox.clear();});
  store.close(); await store.open(); expect(await store.outbox.count()).toBe(0);
  await store.transaction('rw',store.meta,() => observe());
  expect((await read())!.entries).toMatchObject([{mine:'My work',theirs:'Other work',theirsBy:null}]);
  expect(await store.meta.get('sync-candidates:a')).toBeUndefined();
});
it('retains an older echo until settled and does not report an accepted identical value', async () => {
  await ack(); await observeConflicts(store,'pages','a',{data:{title:'Older'},field_ts:{title:1}},[],now);
  expect(await store.meta.get('sync-candidates:a')).toBeDefined(); expect(await read()).toBeUndefined();
  await observeConflicts(store,'pages','a',{data:{title:'My work'},field_ts:{title:10}},[],now);
  expect(await store.meta.get('sync-candidates:a')).toBeUndefined(); expect(await read()).toBeUndefined();
});
it('does not let an older acknowledged candidate hide a newer pending edit', async () => {
  await ack(); await observeConflicts(store,'pages','a',remote,[{id:'a',patch:{title:'Newest'},ts:30}],now);
  expect(await read()).toBeUndefined();
});
it('does not reset age/token for repeated echoes and invalidates a changed server source', async () => {
  await ack(); await observe(); const first = (await read())!.entries[0];
  await observe(); expect((await read())!.entries[0]).toEqual(first);
  await observeConflicts(store,'pages','a',{data:{title:'Third editor'},field_ts:{title:40}},[],now+1);
  expect((await read())!.entries[0].token).not.toBe(first.token);
  expect((await read())!.entries[0].theirs).toBe('Third editor');
});
it('caps each recovery pool at 200 fields and prunes at the exact 14-day boundary', async () => {
  await retainAcknowledged(store,Array.from({length:240},(_,i)=>({id:'r'+i,collection:'pages' as const,patch:{title:i},ts:10})),now);
  expect(await store.meta.where('key').startsWith('sync-candidates:').count()).toBe(200);
  for(const row of await store.meta.where('key').startsWith('sync-candidates:').toArray()) await observe(String((row.value as {id:string}).id));
  await pruneRecovery(store,now);expect(await store.meta.where('key').startsWith('conflicts:').count()).toBe(200);
  await pruneRecovery(store,now+CONFLICT_RETENTION);expect(await store.meta.count()).toBe(0);
});
it('applies Use mine through a value-guarded write in the same recovery transaction', async () => {
  await ack();await observe();await store.pages.put({id:'a',title:'Other work',_ts:{title:20}});
  const envelope = (await read())!, entry = envelope.entries[0], write = vi.fn(async()=>{});
  await resolveConflict(store,envelope,entry,'mine',()=>{},write,now);
  expect(write).toHaveBeenCalledWith('pages','a',{title:'My work'},{fields:{title:'Other work'}});expect(await read()).toBeUndefined();
});
it.each(['mine','dismiss'] as const)('refuses stale %s actions without discarding a newer review', async action => {
  await ack();await observe(); const envelope = (await read())!, entry = envelope.entries[0];
  await observeConflicts(store,'pages','a',{data:{title:'Third editor'},field_ts:{title:30}},[],now);
  await expect(resolveConflict(store,envelope,entry,action,()=>{},vi.fn(),now)).rejects.toThrow('review changed');
  expect((await read())!.entries[0].theirs).toBe('Third editor');
});
it('retains recovery after a failed write, account change or local field update', async () => {
  await ack();await observe();await store.pages.put({id:'a',title:'Other work',_ts:{title:20}});
  const envelope=(await read())!,entry=envelope.entries[0];
  await expect(resolveConflict(store,envelope,entry,'mine',()=>{},async()=>{throw new Error('storage failed');},now)).rejects.toThrow('storage failed');
  await expect(resolveConflict(store,envelope,entry,'dismiss',()=>{throw new Error('account changed');},vi.fn(),now)).rejects.toThrow('account changed');
  await store.pages.update('a',{title:'Newer',_ts:{title:21}});
  await expect(resolveConflict(store,envelope,entry,'mine',()=>{},vi.fn(),now)).rejects.toThrow('field changed');
  expect(await read()).toBeDefined();
});
it('records conflicts in Protocol 3 and rolls back recovery together with a failed feed commit', async () => {
  const uid=userId,manifest=manifestFor(uid);await installManifest(store,uid,manifest,0);await page(store,uid,[record('a')]);
  await ack();const feed=await feedOf(store,uid),req=requestFor(feed),row={...record('a','pages',remote.data,101),field_ts:remote.field_ts};
  const reply={...replyFor(req,[row]),highWater:101,cursor:101};
  await expect(applyFeedPage(store,uid,feed,req,reply,{beforeCommit:()=>{throw new Error('interrupted');}})).rejects.toThrow('interrupted');
  expect(await read()).toBeUndefined();expect(await store.meta.get('sync-candidates:a')).toBeDefined();
  await applyFeedPage(store,uid,feed,req,reply);expect((await read())!.entries[0].mine).toBe('My work');
});
it.each(['removed','viewer'] as const)('clears acknowledged and conflict payloads when access is %s', async change => {
  const uid=userId,manifest=manifestFor(uid);await installManifest(store,uid,manifest,0);await page(store,uid,[record('a')]);
  await ack();await observe();await ack('a',30);
  const next={...manifest,etag:'changed-etag',spaces:change==='removed'?[]:[{...manifest.spaces[0],role:'viewer' as const}]};
  await installManifest(store,uid,next,(await feedOf(store,uid)).version);
  expect(await read()).toBeUndefined();expect(await store.meta.get('sync-candidates:a')).toBeUndefined();
});

it('keeps an oversized guarded source available for manual recovery', async () => {
  const theirs='x'.repeat(70000);await ack();await observeConflicts(store,'pages','a',{data:{title:theirs},field_ts:{title:20}},[],now);await store.pages.put({id:'a',title:theirs,_ts:{title:20}});
  const envelope=(await read())!,entry=envelope.entries[0],write=vi.fn();
  await expect(resolveConflict(store,envelope,entry,'mine',()=>{},write,now)).rejects.toThrow('too large for guarded recovery');expect(write).not.toHaveBeenCalled();expect(await read()).toBeDefined();
});
