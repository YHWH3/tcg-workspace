// A real Worker request pauses between two content reads. Another HTTP request
// commits revocation, then releases it. No mocked gate / timing-dependent sleeps.
import {afterEach,expect,it} from 'vitest';
import {build} from 'esbuild';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {openAuditFixture,type AuditFixture} from './audit-fixture';
let f:AuditFixture;afterEach(async()=>f?.dispose());
it('R02 ENABLED real Worker: concurrent revocation before resumed authorization withholds bytes',async()=>{
 const baseline=process.env.P5_REVIEW_BASELINE==='1';
 const bundle=await build({stdin:{contents:`import {createReadGate} from './worker/readAccess';
 let stage='idle';
 export default {async fetch(request,env){const path=new URL(request.url).pathname;
 if(path==='/state')return Response.json({stage});
 if(path==='/revoke'){await env.DB.prepare("DELETE FROM space_members WHERE user_id='bob' AND space_id='private'").run();return Response.json({ok:true});}
 const gate=createReadGate(env.DB,'bob');
 const row=async()=>{const r=await env.DB.prepare("SELECT id,data,seq rev FROM records WHERE id='secret'").first();return(await gate.filter([r]))[0];};
 if(!await row())throw Error('fixture must initially be authorized');
 stage='paused';while(await env.DB.prepare("SELECT 1 FROM space_members WHERE user_id='bob' AND space_id='private'").first())await new Promise(r=>setTimeout(r,10));
 const result=await row();return Response.json({result:result??null});
 }};`,resolveDir:process.cwd(),sourcefile:'review-race-entry.ts'},bundle:true,write:false,format:'esm',platform:'browser',plugins:baseline?[{name:'exact-reviewed-gate',setup(b){b.onLoad({filter:/worker\/readAccess\.ts$/},()=>({contents:execFileSync('git',['show','fcfc5e0:worker/readAccess.ts'],{encoding:'utf8'}),loader:'ts',resolveDir:resolve('worker')}));}}]:[]});
 f=await openAuditFixture(undefined,{},bundle.outputFiles[0].text);
 await f.db.batch([f.db.prepare('UPDATE access_state SET enabled=1'),f.db.prepare("INSERT INTO spaces(id,name,created_at) VALUES('private','Private',1)"),f.db.prepare("INSERT INTO space_members(space_id,user_id,role) VALUES('private','bob','viewer')"),f.db.prepare(`INSERT INTO records(id,collection,data,field_ts,seq,space_id) VALUES('secret','pages','{"title":"CONFIDENTIAL_WORKER"}','{}',1,'private')`)]);
 const pending=f.mf.dispatchFetch('http://worker.local/read');
 let paused=false;for(let i=0;i<1000;i++){const state=await(await f.mf.dispatchFetch('http://worker.local/state')).json() as {stage:string};if(state.stage==='paused'){paused=true;break;}await new Promise(r=>setTimeout(r,5));}
 expect(paused).toBe(true);await f.mf.dispatchFetch('http://worker.local/revoke');
 const response=await pending;const text=await response.text();expect(text).not.toContain('CONFIDENTIAL_WORKER');expect(JSON.parse(text).result).toBeNull();
},30000);
