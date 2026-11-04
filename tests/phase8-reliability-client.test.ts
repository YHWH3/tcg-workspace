import 'fake-indexeddb/auto';
import {afterEach,beforeEach,it,expect} from 'vitest';
import {LocalDB} from '../src/core/db';
import {readReliability,retryFailedUploads} from '../src/core/reliabilityData';
import {recordSyncObservation,SYNC_OBSERVATIONS_KEY} from '../src/core/sync/observations';
let store:LocalDB,uid:string;
const now=1000000;
beforeEach(async()=>{uid='rel-'+crypto.randomUUID();store=new LocalDB('workspace-'+uid);await store.open();});
afterEach(async()=>{store.close();await store.delete();});
const read=()=>readReliability(store,uid,now,{uploading:['p'],connected:true,online:false},()=>{});
it('derives state from actual Dexie rows without exposing edit/held payloads or file bytes',async()=>{
 await store.outbox.bulkAdd([{id:'a',collection:'pages',patch:{title:'PRIVATE DRAFT'},ts:now-1,enqueuedAt:now-130000},{id:'b',collection:'pages',patch:{title:'PRIVATE REJECTED'},ts:123,state:'rejected'}]);
 await store.accessQuarantineInfo.add({id:'held',kind:'outbox',reason:'revoked',autoId:1,generation:1,quarantinedAt:123});
 await store.blobs.bulkPut([{id:'p',state:'pending',uploadedChunks:1,blob:new Blob(['PRIVATE BYTES'])},{id:'f',state:'failed',uploadedChunks:0,blob:new Blob(['PRIVATE BYTES'])}]);
 await store.files.bulkPut([{id:'p',_ts:{},name:'Current upload',size:13,createdAt:now-140000},{id:'f',_ts:{},name:'Failed upload',size:13,createdAt:now-140000}]);
 await recordSyncObservation(store,uid,'push',123,()=>{});await recordSyncObservation(store,uid,'pull',456,()=>{});
 const result=await read();expect(result).toMatchObject({pending:1,rejected:1,held:1,pendingUploads:0,uploading:1,failedUploads:1,lastPushAt:123,lastPullAt:456,online:false,attention:true,oldestAgeMs:140000});expect(result.uploads.map(u=>u.state)).toEqual(['failed','uploading']);expect(JSON.stringify(result)).not.toMatch(/PRIVATE|blob|patch|payload|_ts/);
});
it('bounds displayed upload metadata while retaining exact counts',async()=>{
 await store.blobs.bulkPut(Array.from({length:25},(_,i)=>({id:'f'+i,state:'failed' as const,uploadedChunks:0,blob:new Blob(['x'])})));
 expect(await read()).toMatchObject({failedUploads:25,uploadsPartial:true});expect((await read()).uploads).toHaveLength(20);
});
it('does not read blob bytes for the reliability snapshot',async()=>{
 await store.blobs.put({id:'p',state:'pending',uploadedChunks:0,blob:new Blob(['retained bytes'])});
 const original=store.blobs.get.bind(store.blobs);store.blobs.get=(()=>{throw new Error('Snapshot must use primary keys, not bytes');}) as typeof store.blobs.get;
 expect(await read()).toMatchObject({pendingUploads:0,uploading:1});store.blobs.get=original;
});
it('retains monotonic per-account observations and rolls back after an authority change',async()=>{
 await recordSyncObservation(store,uid,'push',500,()=>{});await recordSyncObservation(store,uid,'push',400,()=>{});await recordSyncObservation(store,uid,'pull',600,()=>{});
 expect((await store.meta.get(SYNC_OBSERVATIONS_KEY))?.value).toEqual({userId:uid,lastPushAt:500,lastPullAt:600});
 let checks=0;await expect(recordSyncObservation(store,uid,'push',700,()=>{if(++checks===4)throw new Error('switched');})).rejects.toThrow('switched');expect((await store.meta.get(SYNC_OBSERVATIONS_KEY))?.value).toEqual({userId:uid,lastPushAt:500,lastPullAt:600});
 await expect(recordSyncObservation(store,'other','push',800,()=>{})).rejects.toThrow('account_changed');
});
it('keeps the observed push timestamp atomic with removal of acknowledged entries',async()=>{
 const id=await store.outbox.add({id:'p',collection:'pages',patch:{},ts:123});
 await expect(store.transaction('rw',store.outbox,store.meta,async()=>{await store.outbox.delete(id);await recordSyncObservation(store,uid,'push',700,()=>{});throw new Error('commit aborted');})).rejects.toThrow();
 expect(await store.outbox.count()).toBe(1);expect(await store.meta.get(SYNC_OBSERVATIONS_KEY)).toBeUndefined();
});
it('ignores observation copies from another account and refuses stale read context',async()=>{
 await store.meta.put({key:SYNC_OBSERVATIONS_KEY,value:{userId:'other',lastPushAt:123,lastPullAt:456}});expect(await read()).toMatchObject({lastPushAt:null,lastPullAt:null});
 let checks=0;await expect(readReliability(store,uid,now,{uploading:[],connected:false,online:true},()=>{if(++checks===3)throw new Error('access_changed');})).rejects.toThrow('access_changed');
});
it('retries retained failed bytes with chunk progress, but never retries missing originals or tombstones',async()=>{
 const rows=[{id:'valid',name:'Valid',size:5},{id:'missing',name:'Missing',size:99},{id:'deleted',name:'Deleted',size:5,deleted:true}];
 await store.files.bulkPut(rows.map(r=>({...r,_ts:{}})));await store.blobs.bulkPut(rows.map(r=>({id:r.id,state:'failed' as const,blob:new Blob(['hello']),uploadedChunks:1,error:'507'})));
 expect(await retryFailedUploads(store,uid,()=>{})).toEqual({retried:1,unavailable:2,more:false});expect(await store.blobs.get('valid')).toMatchObject({state:'pending',uploadedChunks:1});expect(await store.blobs.get('missing')).toMatchObject({state:'failed'});expect(await store.blobs.get('deleted')).toMatchObject({state:'failed'});
});
it('bounds retries to twenty and rolls back a late identity failure',async()=>{
 await store.files.bulkPut(Array.from({length:25},(_,i)=>({id:'f'+i,_ts:{},size:1})));await store.blobs.bulkPut(Array.from({length:25},(_,i)=>({id:'f'+i,state:'failed' as const,blob:new Blob(['x']),uploadedChunks:0})));
 expect(await retryFailedUploads(store,uid,()=>{})).toEqual({retried:20,unavailable:0,more:true});expect(await store.blobs.where('state').equals('pending').count()).toBe(20);
 let checks=0;await expect(retryFailedUploads(store,uid,()=>{if(++checks===4)throw new Error('switched');})).rejects.toThrow('switched');expect(await store.blobs.where('state').equals('failed').count()).toBe(5);
});
