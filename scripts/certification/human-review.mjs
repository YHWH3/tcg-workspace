/** Legacy certification journeys now include their disposable human's review.
 * App code never imports this. New Phase 6 security journeys use the raw client. */
import assert from 'node:assert/strict';
import {localOrigin} from '../certification-report.mjs';
export function enableFixtureHuman(client,base,{username='admin',password='password123'}={}){
 base=localOrigin(base);const original=client.callTool.bind(client);let session;
 client.callTool=async (request,...rest)=>{
  const result=await original(request,...rest);let data;try{data=JSON.parse(result.content?.[0]?.text??'');}catch{return result;}
  if(request.arguments?.dryRun===true||result.isError||!data.humanUndoRequired&&(!data.humanApprovalRequired||!data.previewId))return result;
  session??=fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})}).then(async r=>{assert.equal(r.status,200,'Disposable human login');return (await r.json()).token;});
  const token=await session;
  if(data.humanUndoRequired){const r=await fetch(base+'/api/changes/'+data.changesetId+'/undo',{method:'POST',headers:{Authorization:'Bearer '+token}});const out=await r.json();return {content:[{type:'text',text:JSON.stringify({...out,undone:data.changesetId})}],isError:!r.ok};}
  const approved=await fetch(base+`/api/ai/previews/${data.previewId}/decision`,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({decision:'approve',argsHash:data.argsHash})});
  assert.ok([200,409].includes(approved.status),'Disposable human approval');
  let execution;for(let i=0;i<50;i++){
   execution=await original({name:'execute_preview',arguments:{previewId:data.previewId,argsHash:data.argsHash}});const current=JSON.parse(execution.content[0].text);
   if(execution.isError||current.completed)return execution;
  }
  throw new Error('Approved fixture operation did not converge');
 };
}
