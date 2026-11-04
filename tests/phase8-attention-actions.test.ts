import {describe,it,expect} from 'vitest';
import {planAttentionAction} from '../shared/attentionActions';
import {attentionDoneStage,type AttentionItem} from '../shared/attention';
import {mutationGuardMatches} from '../shared/mutationGuard';
const board={id:'b',columns:[{id:'open'},{id:'done'}],attention:{enabled:true,personKey:'assigneeId',dateKey:'dueDate',triage:true}};
const rec={id:'r',boardId:'b',status:'open',assigneeId:null,dueDate:'2026-10-27'};
const item:AttentionItem={key:'record_unassigned:r',targetType:'record',targetId:'r',kind:'record_unassigned',title:'r',url:'/boards/b/tasks/r',databaseId:'b',personKey:'assigneeId',severity:0,actions:['assign_me']};
describe('attention actions use the current record and guarded mutation path',()=>{
 it('assigns only the configured person key, with a stale-source guard',()=>{
  const plan=planAttentionAction(item,'assign_me',rec,board,'me','2026-10-27');expect(plan.patch).toEqual({assigneeId:'me'});expect(mutationGuardMatches(plan.guard,rec)).toBe(true);expect(mutationGuardMatches(plan.guard,{...rec,assigneeId:'someone'})).toBe(false);expect(mutationGuardMatches(plan.guard,{...rec,deleted:true})).toBe(false);
 });
 it('uses a current custom person field rather than trusting a cached arbitrary field',()=>{
  const b={...board,fields:[{id:'owner',type:'person'}],attention:{...board.attention,personKey:'p_owner'}};const i={...item,personKey:'p_owner' as const};
  expect(planAttentionAction(i,'assign_me',{...rec,p_owner:null},b,'me','2026-10-27').patch).toEqual({p_owner:'me'});
  expect(()=>planAttentionAction(item,'assign_me',rec,b,'me','2026-10-27')).toThrow();
 });
 it.each([{...rec,assigneeId:'other'},{...rec,deleted:true},{...rec,archived:true},{...rec,status:'done'},{...rec,boardId:'another'}])('refuses a changed or unusable record',r=>{expect(()=>planAttentionAction(item,'assign_me',r,board,'me','2026-10-27')).toThrow();});
 it('completes currently assigned dated work and reports its approval gate',()=>{
  const r={...rec,assigneeId:'me'},i={...item,kind:'record_due_today' as const,actions:['mark_done' as const]};
  const plan=planAttentionAction(i,'mark_done',r,{...board,approvalGate:{stageId:'done'}},'me','2026-10-27');expect(plan.patch).toEqual({status:'done'});expect(plan.gateStage).toBe('done');expect(mutationGuardMatches(plan.guard,{...r,dueDate:'2026-11-01'})).toBe(false);
  expect(()=>planAttentionAction(i,'mark_done',{...r,assigneeId:'other'},board,'me','2026-10-27')).toThrow();expect(()=>planAttentionAction(i,'mark_done',r,board,'me','2026-10-28')).toThrow();
 });
 it('does not offer completion without record stages, and retains task defaults',()=>{expect(attentionDoneStage({kind:'records'})).toBeNull();expect(attentionDoneStage({kind:'tasks'})).toBe('done');expect(attentionDoneStage(board)).toBe('done');});
 it('refuses a restricted or actionless snapshot and changed database settings',()=>{
  for(const i of [{...item,restricted:true as const},{...item,actions:[]},{...item,databaseId:'wrong'}])expect(()=>planAttentionAction(i,'assign_me',rec,board,'me','2026-10-27')).toThrow();
  expect(()=>planAttentionAction(item,'assign_me',rec,{...board,attention:{...board.attention,enabled:false}},'me','2026-10-27')).toThrow();
 });
});
