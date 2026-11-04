import {it,expect} from 'vitest';
import {aiDeskLink,previewState,type PreviewSummary} from '../shared/aiReviewDesk';
import {createCurrentRead,type CurrentRead} from '../src/core/aiReviewRead';
const row:PreviewSummary={id:'p',tool:'meeting_to_actions',status:'pending',created_at:100,expires_at:61000,workflow_id:null,changeset_id:'c'};
it('labels expiration and recovery without granting execution authority',()=>{
 expect(previewState(row,1000)).toMatchObject({active:true,expired:false,label:'Expires in 1m 0s',action:'Review proposed changes'});
 expect(previewState({...row,status:'executing'},2000).action).toBe('Resume / Review');
 expect(previewState({...row,status:'approved'},61000)).toMatchObject({expired:true,label:'Expired',action:'Review expired proposal'});
 expect(previewState({...row,status:'cancelled'},2000).active).toBe(false);
 expect(previewState({...row,expires_at:NaN},2000).expired).toBe(true);
 expect(aiDeskLink('suggestion','a/# 👩🏽‍💻')).toBe('/ai?view=review#suggestion-a%2F%23%20%F0%9F%91%A9%F0%9F%8F%BD%E2%80%8D%F0%9F%92%BB');
});
const deferred=()=>{let resolve!:(value:string)=>void;const promise=new Promise<string>(r=>resolve=r);return {promise,resolve};};
it('discards late reads on access/session/account change or unmount',async()=>{
 for(const mode of ['context','dispose']){let current=true;const pending=deferred(),states:CurrentRead<string>[]=[];const read=createCurrentRead({current:()=>current,request:()=>pending.promise,publish:s=>states.push(s)});const work=read.load();if(mode==='context')current=false;else read.dispose();pending.resolve('PRIVATE');await work;expect(states).toEqual([{value:null,loading:true,error:false}]);}
});
it('supersedes earlier reads and clears old content on refresh/failure',async()=>{
 const old=deferred(),fresh=deferred(),states:CurrentRead<string>[]=[];let n=0;
 const read=createCurrentRead({current:()=>true,request:()=>++n===1?old.promise:n===2?fresh.promise:Promise.reject(new Error('outage')),publish:s=>states.push(s)});
 const first=read.load(),second=read.load();fresh.resolve('current');await second;old.resolve('old');await first;expect(states.at(-1)).toEqual({value:'current',loading:false,error:false});
 await read.load();expect(states.slice(-2)).toEqual([{value:null,loading:true,error:false},{value:null,loading:false,error:true}]);
});
