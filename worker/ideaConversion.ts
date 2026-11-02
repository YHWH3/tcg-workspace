/** Deterministic browser conversion proposal. Execution remains in the session approval flow. */
import {Hono} from 'hono';
import {z} from 'zod';
import {requireAuth,type Env,type AuthUser} from './auth';
import {withReadGate} from './readAccess';
import {getRec,listBy} from './records';
import {fieldsOf} from '../shared/fields';
import {planConversion} from '../shared/conversion';
import {argsHash} from '../shared/stablejson';
import {proposePreview,PreviewError,type PreviewOp} from './aiPreviews';
import {planningEnv} from './planningEnv';
import {applyChanges} from './sync';
import {withIdempotency} from './idempotency';
const input=z.object({requestId:z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),expectedFields:z.record(z.string().max(100),z.number().finite().nonnegative()).refine(value=>Object.keys(value).length<=1000)});
export const ideaConversionApi=new Hono<{Bindings:Env;Variables:{user:AuthUser}}>();
ideaConversionApi.use('*',requireAuth);
ideaConversionApi.onError((error,c)=>{if(error instanceof PreviewError)return c.json({error:error.code},error.status);throw error;});
ideaConversionApi.post('/:id/conversion',async c=>{
 const parsed=input.safeParse(await c.req.json().catch(()=>null));
 if(!parsed.success||c.req.param('id').length>64)return c.json({error:'invalid_conversion_request'},400);
 const {requestId,expectedFields}=parsed.data,userId=c.get('user').id,ideaId=c.req.param('id'),env=withReadGate(c.env,userId);
 const src=await getRec(env,ideaId);
 if(!src||src.collection!=='tasks'||src.data.deleted||src.data.archived)throw new PreviewError('idea_unavailable',404);
 const args={ideaId,expectedFields},hash=await argsHash(args),tool='idea_conversion';
 // A retained preview survives transport cleanup and an acknowledgement loss.
 // Its opaque ID grants nothing: the review endpoint rechecks current authority.
 const retained=await env.DB.prepare('SELECT id,tool,args_hash,status,expires_at FROM ai_previews WHERE user_id=? AND request_id=?').bind(userId,requestId).first<{id:string;tool:string;args_hash:string;status:string;expires_at:number}>();
 if(retained){if(retained.tool!==tool||retained.args_hash!==hash)throw new PreviewError('request_identity_conflict');return c.json({previewId:retained.id,status:retained.status,expiresAt:retained.expires_at,replayed:true});}
 if(await argsHash(src.fieldTs)!==await argsHash(expectedFields))throw new PreviewError('idea_changed_sync_and_retry');
 const source=await getRec(env,String(src.data.boardId));
 const field=fieldsOf(source?.data).find(f=>f.id==='f_converted_project');
 if(!source||source.collection!=='boards'||source.data.deleted||source.data.archived||source.data.templateDbKey!=='ideas'||field?.type!=='relation'||field.relation?.primary!==true)throw new PreviewError('idea_conversion_configuration_unavailable',404);
 const target=await getRec(env,field.relation.target);
 if(!target||target.collection!=='boards'||target.data.deleted||target.data.archived||target.data.templateDbKey!=='projects')throw new PreviewError('project_database_unavailable',404);
 // Exact source marker lookup, never a scan of every Project. Older conversions
 // keep their existing record; missing historical canonical links are not guessed.
 const prior=(await listBy(env,'tasks','convertedFrom',ideaId)).find(row=>row.data.boardId===target.id&&!row.data.archived);
 if(prior)return c.json({alreadyConverted:true,databaseId:target.id,recordId:prior.id});
 if(src.data.status==='converted')throw new PreviewError('converted_idea_requires_relationship_review');
 const plan=planConversion({src:{id:src.id,data:src.data},srcBoard:{id:source.id,data:source.data},destBoard:{id:target.id,data:target.data},sourceStage:'converted',sourceRelationFieldId:field.id,actorId:userId},{id:()=>crypto.randomUUID(),now:Date.now()});
 if('error' in plan)throw new PreviewError('conversion_configuration_changed');
 const ops:PreviewOp[]=[],revisions=new Map<string,number>(),planned=planningEnv(env,ops,revisions);
 const result=await applyChanges(planned,userId,plan.ops.map(op=>({...op,ts:Date.now()})),{serverTs:true,atomic:true,expect:new Map([[src.id,src.rev]])});
 if(result.rejected||result.conflicts?.length)throw new PreviewError('conversion_not_authorized_or_stale',403);
 revisions.set(source.id,source.rev);revisions.set(target.id,target.rev);
 const outcome=await withIdempotency(env,userId,tool,requestId,args,async()=>{
  const preview=await proposePreview(env,userId,tool,args,ops,undefined,[source.id,target.id],requestId,{destId:plan.destId,srcId:src.id,warnings:plan.warnings},revisions);
  return {text:JSON.stringify({previewId:preview.previewId,status:preview.status,expiresAt:preview.expiresAt}),isError:false};
 });
 if(outcome.failed)throw new PreviewError('conversion_proposal_failed_retry_same_request');
 return c.json(JSON.parse(outcome.text));
});
