import {it,expect} from 'vitest';
import {roleCoverage,eventOpsPage,type EventOpsSnapshot,type EventRoleLink} from '../shared/eventOps';
import {eventOpsConfigSchema} from '../shared/eventOpsConfig';
const now=Date.parse('2026-10-31T12:00Z'),config=eventOpsConfigSchema.parse({databaseId:'events'}),fields=[{id:'f_start',type:'date',name:'Start'},{id:'f_capacity',type:'number',name:'Capacity'},...['facilitators','volunteers','participants'].map(role=>({id:'f_'+role,type:'relation',name:role,relation:{target:'people',primary:true}}))];
const snapshot=():EventOpsSnapshot=>({events:[{id:'e1',boardId:'events',title:'Event',p_f_start:'2026-11-01',p_f_capacity:1}],boards:[{id:'events',templateDbKey:'events',fields},{id:'people'}],people:[{id:'p1',boardId:'people',title:'Person One'},{id:'p2',boardId:'people',title:'Person Two'}],links:[{id:'a',kind:'relation',fieldId:'f_participants',fromId:'e1',toId:'p1',createdAt:now-2000}],partialSources:[]});
it('counts distinct people per role and keeps capacity display-only',()=>{
 const links:EventRoleLink[]=[{eventId:'e1',personId:'p1',role:'participants',linkedAt:null},{eventId:'e1',personId:'p1',role:'participants',linkedAt:null},{eventId:'e1',personId:'p1',role:'facilitators',linkedAt:null},{eventId:'other',personId:'p2',role:'volunteers',linkedAt:null}],before=structuredClone(links);
 expect(roleCoverage({id:'e1',capacity:0},links)).toMatchObject({facilitators:1,volunteers:0,participants:1,capacity:0,remaining:-1,overCapacity:true});expect(links).toEqual(before);expect(roleCoverage({id:'e1',capacity:null},links).remaining).toBe(null);
});
it('returns source links and recent unique participant relationships, not receipt counts',()=>{
 const source=snapshot();source.links.push({...source.links[0],id:'b',createdAt:now-1000},{id:'c',kind:'relation',fieldId:'f_participants',fromId:'e1',toId:'p2'});const page=eventOpsPage(config,source,{today:'2026-10-31',now});
 expect(page.events[0]).toMatchObject({coverage:{participants:2,remaining:-1,overCapacity:true},registrationSource:'participant_relations',formsUrl:'/forms/people',recentParticipants:[{id:'p1',linkedAt:now-1000},{id:'p2',linkedAt:null}]});expect(page.registrationNote).toContain('not submission receipts');expect(page.events[0].url).toBe('/boards/events/tasks/e1');expect(page.records).toHaveLength(2);
});
it('excludes deleted, archived, private-missing and wrong-database identities without leaking them',()=>{
 const source=snapshot();source.people[0].deleted=true;source.people[1].boardId='other';source.links.push({...source.links[0],id:'b',toId:'p2'},{...source.links[0],id:'c',toId:'unreadable'});const page=eventOpsPage(config,source,{today:'2026-10-31',now});expect(page.events[0]).toMatchObject({coverage:{participants:0},recentParticipants:[],issues:['person_unavailable']});expect(page.records).toEqual([]);expect(page.partial).toBe(true);expect(JSON.stringify(page)).not.toContain('unreadable');
});
it('normalizes reverse participant relations and ignores unrelated relation fields',()=>{
 const source=snapshot();source.boards[0].fields=fields.map(field=>field.id==='f_participants'?{...field,relation:{target:'people',primary:false,pairedFieldId:'f_events'}}:field);source.links=[{id:'r',kind:'relation',fieldId:'f_events',fromId:'p1',toId:'e1'},{id:'noise',kind:'related',fieldId:'f_events',fromId:'p2',toId:'e1'}];expect(eventOpsPage(config,source,{today:'2026-10-31',now}).events[0].coverage.participants).toBe(1);
});
it('refuses invalid capacities instead of rounding or enforcing registration',()=>{
 for(const value of [-1,1.5,'3',true,Number.MAX_SAFE_INTEGER+1]){const source=snapshot();source.events[0].p_f_capacity=value;expect(eventOpsPage(config,source,{today:'2026-10-31',now}).events[0]).toMatchObject({coverage:{capacity:null,remaining:null},issues:['capacity_invalid']});}
});
it('keeps completed and past events out of upcoming lists and provides missing-date repair links',()=>{
 const source=snapshot();source.events.push({id:'done',boardId:'events',status:'done',p_f_start:'2026-11-01'},{id:'past',boardId:'events',p_f_start:'2026-10-01'},{id:'missing',boardId:'events',title:'Needs date'});const page=eventOpsPage(config,source,{today:'2026-10-31',now});expect(page.events.map(e=>e.id)).toEqual(['e1']);expect(page.undatedEvents).toEqual([{id:'missing',title:'Needs date',url:'/boards/events/tasks/missing?focusField=p_f_start'}]);expect(eventOpsPage({...config,eventId:'past'},source,{today:'2026-10-31',now}).events.map(e=>e.id)).toEqual(['past']);
});
it('distinguishes missing database, field drift and empty source',()=>{
 const source=snapshot();source.boards=[];expect(eventOpsPage(config,source,{today:'2026-10-31',now}).status).toBe('source_unavailable');source.boards=[{id:'events',fields:[]}];expect(eventOpsPage(config,source,{today:'2026-10-31',now}).status).toBe('configuration_required');
});
it('validates bounded configuration and requires independent role fields',()=>{
 for(const value of [{},{databaseId:'events',limit:21},{databaseId:'events',participantsKey:'rel_f_volunteers'},{databaseId:'events',capacityKey:'title'}])expect(eventOpsConfigSchema.safeParse(value).success).toBe(false);
});
