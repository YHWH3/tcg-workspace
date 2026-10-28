import {describe,expect,it} from 'vitest';
import {websiteDashboard,websiteDigest,responseAge,responseBands,responseConfig,ownerQueues,targetBreaches,websiteQueue} from '../shared/websiteStats';
import {planWebsiteChange} from '../shared/websiteActions';
import {mutationGuardMatches} from '../shared/mutationGuard';

describe('Website response desk date basis (N09)',()=>{
 it('uses the received calendar date for oldest unanswered, matching first-reply latency',()=>{
  const records=[{id:'open',status:'new',createdAt:Date.parse('2026-10-27T23:00:00Z'),p_wi_received:'2026-10-20'},
   {id:'replied',status:'replied',createdAt:Date.parse('2026-10-27T23:00:00Z'),p_wi_received:'2026-10-20',p_wi_replied:'2026-10-28'}];
  const result=websiteDashboard(records,Date.parse('2026-10-28T12:00:00Z'));
  expect(result.medianFirstReplyDays).toBe(8);
  expect(result.oldestUnanswered[0]?.ageDays).toBe(8);
 });
});

describe('Website response queues',()=>{
 const row=(id:string,days:number,extra:Record<string,unknown>={})=>({id,boardId:'board-website-inbox',status:'new',p_wi_received:`2026-10-${String(28-days).padStart(2,'0')}`,...extra});
 it('uses workspace midnight for missing dates and keeps unknown dates explicit',()=>{
  const r={id:'fallback',status:'new',createdAt:Date.parse('2026-10-27T20:00:00Z')};
  expect(responseAge(r,'2026-10-28','Asia/Kolkata')).toBe(0);
  expect(responseAge(r,'2026-10-28','America/Los_Angeles')).toBe(1);
  expect(responseAge({id:'unknown',status:'new'},'2026-10-28')).toBeNull();
  expect(responseAge({id:'bad',createdAt:NaN,p_wi_received:'2026-02-30'},'2026-10-28')).toBeNull();
  expect(responseAge({id:'future',p_wi_received:'2026-10-29'},'2026-10-28')).toBe(0);
 });
 it('counts exact band boundaries, excludes replied/deleted/archived/subrecords and reports unknown',()=>{
  const rows=[row('zero',0),row('two',2),row('three',3),row('seven',7),row('eight',8),row('done',8,{status:'done'}),row('replied',8,{p_wi_replied:'2026-10-28'}),row('archived',8,{archived:true}),row('deleted',8,{deleted:true}),row('child',8,{parentId:'eight'}),{id:'unknown',status:'new'}];
  const result=responseBands(rows,'2026-10-28');
  expect(result.bands.map(g=>g.ids)).toEqual([['zero','two'],['three','seven'],['eight']]);expect(result.unknownIds).toEqual(['unknown']);
  expect(targetBreaches(rows,'2026-10-28',3).map(r=>r.id)).toEqual(['seven','eight']);
  expect(responseConfig({responseBands:[7,2],responseTargetDays:-2})).toEqual({bands:[2,7],targetDays:3});
  expect(responseBands(rows,'2026-10-28',[0,3]).bands.map(g=>g.count)).toEqual([1,2,2]);
 });
 it('uses active open owners and follow-up date equality independently of machine timezone',()=>{
  const rows=[row('unassigned',0),row('mine',4,{assigneeId:'alice',dueDate:'2026-10-28'}),row('other',5,{assigneeId:'bob',dueDate:'2026-10-27'}),row('future',6,{dueDate:'2026-10-29'}),row('bad',7,{dueDate:'2026-02-30'}),row('done',4,{status:'done',dueDate:'2026-10-27'})];
  expect(websiteQueue(rows,'mine','alice','2026-10-28').map(r=>r.id)).toEqual(['mine']);
  expect(websiteQueue(rows,'followup_due','alice','2026-10-28').map(r=>r.id)).toEqual(['mine','other']);
  expect(ownerQueues(rows).find(q=>q.ownerId===null)?.count).toBe(3);
 });
 it('shares date ordering and exact linked counts between dashboard and digest',()=>{
  const rows=[row('old',8,{createdAt:Date.parse('2026-10-28T10:00Z')}),row('new',1,{createdAt:Date.parse('2026-10-20T10:00Z')})],now=Date.parse('2026-10-28T12:00Z');
  const digest=websiteDigest(rows,null,{since:0,now,today:'2026-10-28',timeZone:'Asia/Kolkata'});
  expect(digest.oldestOpen[0]).toMatchObject({recordId:'old',ageDays:8});expect(digest.targetBreaches.recordIds).toEqual(['old']);
  expect(digest.responseBands.map(g=>g.count)).toEqual([1,0,1]);
 });
 it('restricts local changes and makes undo refuse later field changes',()=>{
  const source=row('a',8,{assigneeId:null}),plan=planWebsiteChange(source,{assigneeId:'alice',dueDate:'2026-10-29'});
  expect(mutationGuardMatches(plan.guard,source)).toBe(true);
  expect(mutationGuardMatches(plan.guard,{...source,assigneeId:'bob'})).toBe(false);
  expect(mutationGuardMatches(plan.undoGuard,{...source,...plan.patch})).toBe(true);
  expect(mutationGuardMatches(plan.undoGuard,{...source,...plan.patch,dueDate:'2026-10-30'})).toBe(false);
  expect(()=>planWebsiteChange(source,{dueDate:'2026-02-30'})).toThrow();
  expect(()=>planWebsiteChange(source,{p_wi_replied:'2026-10-28'})).toThrow();
  expect(()=>planWebsiteChange({...source,deleted:true},{status:'done'})).toThrow();
 });
});
