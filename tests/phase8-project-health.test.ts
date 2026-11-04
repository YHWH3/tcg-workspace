import {describe,it,expect} from 'vitest';
import {projectHealth,healthRecordDone,defaultProjectHealthBlock,type ProjectHealthContext,type HealthRecord} from '../shared/projectHealth';
const now=Date.parse('2026-10-29T12:00Z'),project:HealthRecord={id:'p',boardId:'projects',status:'active',p_f_owner:'alice',p_f_start:'2026-10-01',p_f_end:'2026-11-01',createdAt:now};
function context(extra:Partial<ProjectHealthContext>={}):ProjectHealthContext{return {today:'2026-10-29',now,records:[project,{id:'task',boardId:'tasks',status:'todo',dueDate:'2026-11-01'}],boards:[{id:'projects',kind:'records',templateDbKey:'projects',columns:[{id:'active',name:'Active'},{id:'blocked',name:'Blocked'},{id:'completed',name:'Completed'},{id:'cancelled',name:'Cancelled'}]},{id:'tasks',kind:'tasks',columns:[{id:'todo',name:'To do'},{id:'done',name:'Done'}]},{id:'decisions',kind:'records',templateDbKey:'decisions',columns:[{id:'open',name:'Open'},{id:'decided',name:'Decided'},{id:'superseded',name:'Superseded'}]}],links:[{id:'rel',kind:'relation',fromId:'task',toId:'p'}],activity:[],approvals:[],partialSources:[],...extra};}
const rules=(p=project,c=context())=>projectHealth(p,c).signals.map(s=>s.rule);
describe('project health transparent rules',()=>{
 it('reports complete current evidence as on track',()=>expect(projectHealth(project,context())).toMatchObject({status:'on_track',signals:[],recordIds:['p','task']}));
 it('recognizes blocked project and linked task stages',()=>{
  expect(projectHealth({...project,status:'blocked'},context()).status).toBe('blocked');
  const c=context();c.records[1]!.status='blocked';expect(projectHealth(project,c).signals.find(s=>s.rule==='blocked_stage')?.sourceIds).toEqual(['task']);
 });
 it('uses only incoming unfinished dependency edges and exact blocker ids',()=>{
  const c=context();c.records.push({id:'blocker',boardId:'tasks',status:'todo'},{id:'finished',boardId:'tasks',status:'done'},{id:'outgoing',boardId:'tasks',status:'todo'});c.links.push({id:'a',kind:'blocks',fromId:'blocker',toId:'task'},{id:'b',kind:'blocks',fromId:'finished',toId:'p'},{id:'c',kind:'blocks',fromId:'p',toId:'outgoing'});
  const h=projectHealth(project,c);expect(h.status).toBe('blocked');expect(h.signals.find(s=>s.rule==='dependency_blocked')?.sourceIds).toEqual(['blocker']);
 });
 it('explains missing ownership and invalid or missing dates',()=>{
  expect(rules({...project,p_f_owner:null,p_f_end:'2026-02-30'})).toEqual(['owner_missing','dates_missing']);expect(projectHealth({...project,p_f_start:null},context()).status).toBe('at_risk');
 });
 it('supports configured field keys after schema changes',()=>expect(rules({...project,p_custom_owner:'bob',p_custom_start:'2026-10-01',p_custom_end:'2026-11-01'},context({ownerKey:'p_custom_owner',startKey:'p_custom_start',endKey:'p_custom_end'}))).toEqual([]));
 it('counts overdue open linked tasks including child tasks, but not today or completed work',()=>{
  const c=context();c.records[1]!.dueDate='2026-10-28';c.records.push({id:'child',boardId:'tasks',parentId:'task',status:'todo',dueDate:'2026-10-20'},{id:'done',boardId:'tasks',parentId:'task',status:'done',dueDate:'2026-10-20'},{id:'today',boardId:'tasks',parentId:'task',status:'todo',dueDate:'2026-10-29'});
  const h=projectHealth(project,c);expect(h.status).toBe('at_risk');expect(h.signals.find(s=>s.rule==='overdue_tasks')).toMatchObject({count:2,sourceIds:['child','task']});
 });
 it('finds decisions through either relation direction and named terminal stages',()=>{
  const c=context();c.records.push({id:'open',boardId:'decisions',status:'open'},{id:'decided',boardId:'decisions',status:'decided'});c.links.push({id:'a',kind:'relation',fromId:'p',toId:'open'},{id:'b',kind:'relation',fromId:'decided',toId:'p'});
  expect(projectHealth(project,c).signals.find(s=>s.rule==='open_decisions')?.sourceIds).toEqual(['open']);expect(healthRecordDone({...project,status:'completed'},c.boards[0]!)).toBe(true);
 });
 it('keeps server approval ids separate from record source ids',()=>{
  const c=context({approvals:[{id:'approval',targetId:'task',status:'pending'},{id:'old',targetId:'p',status:'approved'},{id:'unrelated',targetId:'other',status:'pending'}]});
  expect(projectHealth(project,c).signals.find(s=>s.rule==='pending_approvals')).toMatchObject({sourceIds:['task'],approvalIds:['approval'],count:1});
 });
 it('uses activity over the project tree and explicit stale threshold',()=>{
  const old={...project,createdAt:now-20*86400000};expect(rules(old)).toContain('no_recent_activity');expect(rules(old,context({activity:[{id:'activity',targetId:'task',at:now}]}))).not.toContain('no_recent_activity');expect(rules({...project,createdAt:now-14*86400000})).toContain('no_recent_activity');
 });
 it('makes incomplete evidence unknown while preserving observed signals',()=>{
  expect(projectHealth({...project,status:'blocked'},context({partialSources:['approvals']}))).toMatchObject({status:'unknown',partialSources:['approvals']});expect(projectHealth({...project,createdAt:undefined},context()).partialSources).toContain('activity_age_unavailable');
 });
 it('does not invent completion for a missing dependency or disclose its id as a source',()=>{
  const c=context();c.links.push({id:'l',kind:'blocks',fromId:'unavailable',toId:'p'});const h=projectHealth(project,c);expect(h.status).toBe('unknown');expect(h.recordIds).not.toContain('unavailable');expect(h.partialSources).toContain('dependency_source_unavailable');
 });
 it('excludes deleted/archived sources and keeps malformed parent cycles bounded',()=>{
  const c=context();c.records.push({id:'deleted',boardId:'tasks',deleted:true,status:'blocked'},{id:'archived',boardId:'tasks',archived:true,status:'blocked'},{id:'cycle',boardId:'tasks',parentId:'task',status:'todo'});c.records[1]!.parentId='cycle';
  expect(projectHealth(project,c).recordIds).toEqual(['cycle','p','task']);expect(projectHealth({...project,deleted:true},c).status).toBe('unknown');
 });
 it('returns unknown for missing project database or date context',()=>{expect(projectHealth(project,context({boards:[]})).status).toBe('unknown');expect(projectHealth(project,context({today:'invalid'})).status).toBe('unknown');});
 it('derives self health in a Project record body without modifying its records',()=>{
  const board=context().boards[0]!,before=JSON.stringify([project,board]);expect(defaultProjectHealthBlock(project,board,[])).toMatchObject({projectId:'self',pageId:'p',parentType:'record',databaseId:'projects'});expect(JSON.stringify([project,board])).toBe(before);
 });
 it('respects saved or deleted health block reservations and non-project sources',()=>{
  expect(defaultProjectHealthBlock(project,context().boards[0]!,['projecthealth'])).toBeNull();expect(defaultProjectHealthBlock(project,{id:'other'},[])).toBeNull();expect(defaultProjectHealthBlock({...project,archived:true},context().boards[0]!,[])).toBeNull();
 });
});
