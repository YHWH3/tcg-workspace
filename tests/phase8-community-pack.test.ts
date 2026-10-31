import {it,expect} from 'vitest';
import raw from '../templates/tcg-pack.json';
import {fieldsOf} from '../shared/fields';
import {toBundled,planPackUpgrade,type AuthorTemplate} from '../shared/bundled';
import {planTemplateInstantiation,boardRefsOf,installRecordId} from '../shared/templates';
import {applyView,type ViewConfig} from '../shared/views';
import {parseFormConfig,planSubmissionChanges} from '../worker/forms';
const pack=toBundled('tcg-pack',raw as unknown as AuthorTemplate);
it('keeps an Event registration starter disabled until an Event is configured',()=>{
 const form=raw.forms.find(f=>f.id==='form_event_registration')!;
 expect(form.createRelations?.[0].toId).toBe(null);expect(form.enabled).toBe(false);
});
it('adds typed ownership and conversation dates to both relationship databases without admin triage',()=>{
 expect(pack.version).toBeGreaterThanOrEqual(7);
 for(const key of ['db_people','db_orgs']){
  const board=pack.snapshot.boards[key];expect(board,key).toBeDefined();
  expect(board.fields).toEqual(expect.arrayContaining([expect.objectContaining({id:'f_relationship_owner',name:'Relationship owner',type:'person'}),expect.objectContaining({id:'f_next_conversation',name:'Next conversation',type:'date'})]));
  expect(board.attention).toMatchObject({enabled:true,personKey:'p_f_relationship_owner',dateKey:'p_f_next_conversation',triage:false});
 }
});
it('includes a multi-membership Person in each corresponding named view',()=>{
 const views=Object.values(pack.snapshot.views!).filter(view=>String(view.templateItemKey??'').startsWith('v_people_relationship_')||String(view.name).startsWith('Membership:'));
 const authored=raw.databases.find(board=>board.id==='db_people')!,membership=fieldsOf({fields:authored.fields}).find(field=>field.id==='f_membership')!;
 expect(views).toHaveLength(7);const chosen=membership.options!.slice(0,2).map(option=>option.id),person={id:'member',p_f_membership:chosen};
 const matches=views.filter(view=>applyView([person],view.config as ViewConfig).rows.length>0);expect(matches).toHaveLength(2);
});
it('preserves upcoming date semantics and live Event references when copying the desk',()=>{
 expect(pack.snapshot.views!.v_events_upcoming.config).toMatchObject({filters:expect.arrayContaining([{key:'p_f_start',op:'on_or_after',value:'today'}]),sorts:[{key:'p_f_start',dir:'asc'}]});
 const block=pack.snapshot.blocks!.events_role_coverage;expect(block).toMatchObject({type:'eventops',databaseId:'db_events',upcomingOnly:true,limit:10});expect(boardRefsOf(block)).toEqual([]);
 const plan=planTemplateInstantiation({...pack.snapshot,blocks:{events_role_coverage:block}},{templateId:'pg_events'},{id:()=>crypto.randomUUID(),now:1})!;
 expect(plan.writes.filter(write=>write.collection==='boards'||write.collection==='tasks')).toEqual([]);
 expect(plan.writes.find(write=>write.patch.type==='eventops')?.patch).toMatchObject({databaseId:'db_events',upcomingOnly:true,limit:10});
});
it('adds v7 fields but preserves edited attention, enabled form mappings and deleted reservations',()=>{
 const plan=planTemplateInstantiation(pack.snapshot,{templateId:pack.root,templateKey:pack.key,packInstall:true,stableIds:true},{id:()=>crypto.randomUUID(),now:1})!;
 const rows=plan.writes.map(write=>({id:write.id,collection:write.collection,data:{...write.patch}})),people=rows.find(row=>row.data.templateDbKey==='people')!,form=rows.find(row=>row.id===installRecordId(pack.key,'forms','form_event_registration'))!,coverage=rows.find(row=>row.data.templateItemKey==='events_role_coverage')!;
 people.data.fields=(people.data.fields as {id:string}[]).filter(field=>!['f_relationship_owner','f_next_conversation'].includes(field.id));people.data.attention={enabled:false};form.data.enabled=true;form.data.createRelations=[{fieldId:'f_ev_participating',toId:'team-event'}];coverage.data.deleted=true;coverage.data.heading='Team role review';rows.find(row=>row.data.templateKey==='tcg-pack')!.data.templateVersion=6;
 const upgrade=planPackUpgrade(pack,rows),change=upgrade.writes.find(write=>write.id===people.id)!;
 expect(change.patch.fields).toEqual(expect.arrayContaining([expect.objectContaining({id:'f_relationship_owner'}),expect.objectContaining({id:'f_next_conversation'})]));expect(change.patch).not.toHaveProperty('attention');expect(upgrade.writes.some(write=>write.id===form.id||write.id===coverage.id)).toBe(false);
});
it('a configured registration form writes the canonical participant relationship and remapping leaves earlier links intact',()=>{
 const starter=raw.forms.find(form=>form.id==='form_event_registration')!,board=pack.snapshot.boards.db_people;
 expect(parseFormConfig(starter)).toBeNull();
 const form=parseFormConfig({...starter,enabled:true,createRelations:[{fieldId:'f_ev_participating',toId:'event-a'}]})!;expect(form).not.toBeNull();
 const args={form,formId:'registration',boardData:board,coerced:{title:'Synthetic participant'},submissionId:'s1',lastOrder:undefined,personMatch:{kind:'email' as const,personId:'person1',personTitle:'Synthetic participant'},pendingFileIds:[],at:10};
 const first=planSubmissionChanges(args),replay=planSubmissionChanges(args);expect(replay).toEqual(first);expect(first.filter(write=>write.collection==='tasks')).toEqual([]);
 expect(first.find(write=>write.collection==='links')?.patch).toMatchObject({fieldId:'f_participants',fromId:'event-a',toId:'person1',createdAt:10});
 const next=planSubmissionChanges({...args,form:{...form,createRelations:[{fieldId:'f_ev_participating',toId:'event-b'}]},submissionId:'s2',at:20});
 expect(next.find(write=>write.collection==='links')?.patch).toMatchObject({fromId:'event-b',toId:'person1'});expect(first.find(write=>write.collection==='links')?.patch.fromId).toBe('event-a');
});
