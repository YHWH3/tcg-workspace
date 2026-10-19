/** Compatibility journeys now include the fixture human's approval step. This
 * calls the production authenticated decision route; it never writes approval
 * state directly. Security tests call handlers without this convenience helper. */
import {beforeEach} from 'vitest';
import type {Env} from '../worker/auth';
import {aiPreviewApi,executePreview,PreviewError} from '../worker/aiPreviews';
import {sha256Hex} from '../worker/password';
import {changesApi} from '../worker/changesets';
import {argsHash} from '../shared/stablejson';
type Result={content:{type?:'text';text:string}[];isError?:boolean};
const pending=new Map<string,{previewId:string;argsHash:string;argumentsHash:string;completed:boolean;metadata:Record<string,unknown>}>();
beforeEach(()=>pending.clear());
export async function fixtureHumanStep(env:Env,userId:string,name:string,args:Record<string,unknown>,result:Result):Promise<Result>{
 const data=JSON.parse(result.content[0].text) as Record<string,unknown>,key=String(args.requestId??'')+':'+userId+':'+name,hash=await argsHash(args);
 if(data.humanUndoRequired&&!result.isError&&!args.dryRun){const token='fixture-human-'+userId;await env.DB.prepare('INSERT OR IGNORE INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').bind(await sha256Hex(token),userId,Date.now()+86400000,Date.now()).run();const response=await changesApi.request(`http://localhost/${data.changesetId}/undo`,{method:'POST',headers:{authorization:'Bearer '+token}},env,{waitUntil:()=>{}} as unknown as ExecutionContext);return {isError:!response.ok,content:[{type:'text',text:JSON.stringify({...await response.json() as object,undone:data.changesetId})}]};}
 let proposal=typeof data.previewId==='string'&&data.humanApprovalRequired?{previewId:data.previewId,argsHash:String(data.argsHash),argumentsHash:hash,completed:false,metadata:{}}:pending.get(key);
 if(args.dryRun===true||result.isError||!proposal||proposal.argumentsHash!==hash)return result;
 if(proposal.completed&&data.resultRedacted)return result;
 if(proposal.completed)return {content:[{type:'text',text:JSON.stringify({...proposal.metadata,replayed:true})}]};
 pending.set(key,proposal);
 const token='fixture-human-'+userId,tokenHash=await sha256Hex(token);
 await env.DB.prepare('INSERT OR IGNORE INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').bind(tokenHash,userId,Date.now()+86400000,Date.now()).run();
 const response=await aiPreviewApi.request(`http://localhost/${proposal.previewId}/decision`,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({decision:'approve',argsHash:proposal.argsHash})},env,{waitUntil:()=>{}} as unknown as ExecutionContext);
 if(response.status!==200&&response.status!==409)throw new Error('Fixture human approval refused: '+await response.text());
 try {
  let execution=await executePreview(env,userId,proposal.previewId,proposal.argsHash);
  for(let step=0;!execution.completed&&step<40;step++)execution=await executePreview(env,userId,proposal.previewId,proposal.argsHash);
  if(!execution.completed)throw new Error('Fixture execution did not converge');
  proposal.completed=true;proposal.metadata=execution;
  return {content:[{type:'text',text:JSON.stringify(execution)}]};
 }catch(e){const row=await env.DB.prepare('SELECT changeset_id FROM ai_previews WHERE id=? AND user_id=?').bind(proposal.previewId,userId).first<{changeset_id:string}>();return {isError:true,content:[{type:'text',text:JSON.stringify({error:e instanceof PreviewError?e.code:e instanceof Error?e.message:'interrupted',changesetId:row?.changeset_id,previewId:proposal.previewId})}]};}
}
