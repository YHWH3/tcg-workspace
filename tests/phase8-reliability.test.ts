import {it,expect} from 'vitest';
import {deriveReliability,pendingEnqueuedAt,type ReliabilityInput} from '../shared/reliability';
const base:ReliabilityInput={pending:0,rejected:0,held:0,pendingUploads:0,failedUploads:0,uploading:0,oldestPendingAt:null,unknownPendingAge:false,observations:null,connected:false,online:true};
it('does not infer a server acknowledgement from an empty local queue',()=>{expect(deriveReliability(base,1000000)).toMatchObject({lastPushAt:null,lastPullAt:null,attention:false,state:'up_to_date'});});
it('separates runtime uploading from pending/failed and alerts only for aged or failed work',()=>{
 expect(deriveReliability({...base,pending:1,pendingUploads:3,uploading:2,oldestPendingAt:900000},1000000)).toMatchObject({pending:1,pendingUploads:1,uploading:2,attention:false});
 expect(deriveReliability({...base,pending:1,oldestPendingAt:880000},1000000).attention).toBe(true);
 for(const key of ['failedUploads','held','rejected'])expect(deriveReliability({...base,[key]:1},1000000)).toMatchObject({state:'needs_review',attention:true});
 expect(deriveReliability({...base,pendingUploads:1,unknownPendingAge:true},1000000).attention).toBe(true);
});
it('keeps offline state and actual observations distinct from pending work',()=>{
 expect(deriveReliability({...base,online:false,observations:{userId:'u',lastPushAt:123,lastPullAt:456}},1000000)).toMatchObject({state:'offline',lastPushAt:123,lastPullAt:456});
 expect(deriveReliability({...base,observations:{userId:'u',lastPushAt:2000000,lastPullAt:NaN}},1000000)).toMatchObject({lastPushAt:null,lastPullAt:null});
});
it('uses real enqueue time before a logical edit timestamp and never invents an age',()=>{expect(pendingEnqueuedAt({enqueuedAt:500,ts:999},1000)).toBe(500);expect(pendingEnqueuedAt({ts:999},1000)).toBe(999);for(const ts of [NaN,Infinity,-1,0,1001,'123'])expect(pendingEnqueuedAt({ts},1000)).toBeNull();});
