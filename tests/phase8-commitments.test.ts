import {it,expect} from 'vitest';
import {commitmentsPage,type CommitmentsSnapshot} from '../shared/commitments';
import {commitmentsConfigSchema} from '../shared/commitmentsConfig';
const now=Date.parse('2026-11-03T12:00Z'),context={today:'2026-11-03',now},config=commitmentsConfigSchema.parse({databaseId:'meetings'});
const source=():CommitmentsSnapshot=>({boards:[{id:'meetings',fields:[{id:'f_date',name:'Date',type:'date'},{id:'f_actions',name:'Actions',type:'relation',relation:{target:'tasks',primary:true}},{id:'f_decisions',name:'Decisions',type:'relation',relation:{target:'decisions',primary:true}}]},{id:'tasks',columns:[{id:'open'},{id:'done'}]},{id:'decisions',columns:[{id:'open'},{id:'recommended'},{id:'decided'},{id:'superseded'}],fields:[{id:'f_decider',name:'Decision maker',type:'person'}]}],meetings:[{id:'m',boardId:'meetings',title:'Source meeting',p_f_date:'2026-11-02'}],records:[{id:'t',boardId:'tasks',title:'Follow up',status:'open',dueDate:'2026-11-01'},{id:'d',boardId:'decisions',title:'Decide next step',status:'recommended'}],links:[{id:'a',kind:'relation',fieldId:'f_actions',fromId:'m',toId:'t'},{id:'b',kind:'relation',fieldId:'f_decisions',fromId:'m',toId:'d'}],partialSources:[]});
it('keeps linked actions and unresolved decisions attached to their original meeting without inventing owners',()=>{
 const s=source(),before=structuredClone(s),page=commitmentsPage(config,s,context);expect(page).toMatchObject({status:'ready',partial:false,meetings:[{id:'m',overdue:[{id:'t',ownerId:null,date:'2026-11-01',meeting:{id:'m',url:'/boards/meetings/tasks/m'}}],decisions:[{id:'d',ownerId:null,meeting:{id:'m'}}]}]});expect(s).toEqual(before);
});
it('splits overdue, due today/upcoming and missing or invalid dates and excludes completed items',()=>{
 const s=source();for(const [id,date,status]of [['today','2026-11-03','open'],['later','2026-11-04','open'],['missing',null,'open'],['invalid',true,'open'],['done','2026-11-01','done']]as const){s.records.push({id,boardId:'tasks',status,dueDate:date});s.links.push({id,kind:'relation',fieldId:'f_actions',fromId:'m',toId:id});}
 s.records.push({id:'decided',boardId:'decisions',status:'decided'});s.links.push({id:'decided',kind:'relation',fieldId:'f_decisions',fromId:'m',toId:'decided'});
 const meeting=commitmentsPage(config,s,context).meetings[0];expect(meeting.overdue.map(r=>r.id)).toEqual(['t']);expect(meeting.upcoming.map(r=>r.id)).toEqual(['today','later']);expect(meeting.undated.map(r=>r.id)).toEqual(['invalid','missing']);expect(meeting.undated[0].invalidDate).toBe(true);expect(meeting.decisions.map(r=>r.id)).toEqual(['d']);
});
it('supports reverse fields, deduplicates links and ignores wrong databases, unrelated and deleted links',()=>{
 const s=source();s.boards[0].fields=[{id:'f_date',name:'Date',type:'date'},{id:'f_actions',name:'Actions',type:'relation',relation:{target:'tasks',primary:false,pairedFieldId:'meeting'}},{id:'f_decisions',name:'Decisions',type:'relation',relation:{target:'decisions',primary:true}}];s.links[0]={id:'a',kind:'relation',fieldId:'meeting',fromId:'t',toId:'m'};s.links.push({...s.links[0],id:'dupe'});expect(commitmentsPage(config,s,context).meetings[0].actions).toHaveLength(1);s.records[0].boardId='other';expect(commitmentsPage(config,s,context).meetings[0]).toMatchObject({actions:[],unavailable:true});
});
it('omits deleted and archived peers and meetings, and never leaks unavailable peer names',()=>{
 for(const flag of ['deleted','archived']){const s=source();s.records[0][flag]=true;const page=commitmentsPage(config,s,context);expect(page.meetings[0].actions).toEqual([]);expect(JSON.stringify(page)).not.toContain('Follow up');expect(page.partial).toBe(true);s.meetings[0][flag]=true;expect(commitmentsPage({...config,meetingId:'m'},s,context).status).toBe('meeting_unavailable');}
});
it('uses inclusive date-only recent windows, reports undated sources and supports explicit historical selection',()=>{
 const s=source();s.meetings.push({id:'old',boardId:'meetings',p_f_date:'2026-10-03'},{id:'edge',boardId:'meetings',p_f_date:'2026-10-04'},{id:'future',boardId:'meetings',p_f_date:'2026-11-04'},{id:'unknown',boardId:'meetings'});
 expect(commitmentsPage(config,s,context)).toMatchObject({meetings:[{id:'m'},{id:'edge'}],undatedCount:1,partialSources:['meeting_dates']});expect(commitmentsPage({...config,meetingId:'old'},s,context).meetings.map(r=>r.id)).toEqual(['old']);
});
it('separates empty, unavailable, field drift and bounded partial selections',()=>{
 const s=source();s.meetings=[];expect(commitmentsPage(config,s,context)).toMatchObject({status:'ready',meetings:[]});s.boards[0].deleted=true;expect(commitmentsPage(config,s,context).status).toBe('source_unavailable');delete s.boards[0].deleted;s.boards[0].fields=[];expect(commitmentsPage(config,s,context).status).toBe('configuration_required');
 const full=source();full.partialSources=['relations'];full.meetings.push({...full.meetings[0],id:'m2'});expect(commitmentsPage({...config,limit:1},full,context)).toMatchObject({partial:true,partialSources:['meeting_selection','relations']});
});
it('bounds configuration and rejects colliding relation fields',()=>{
 for(const value of [{},{databaseId:'meetings',days:0},{databaseId:'meetings',days:3651},{databaseId:'meetings',limit:21},{databaseId:'meetings',actionsKey:'rel_f_decisions'},{databaseId:'meetings',dateKey:'title'}])expect(commitmentsConfigSchema.safeParse(value).success).toBe(false);
});

it('uses the database first stage for an unknown stored decision stage, matching the record UI',()=>{const s=source();s.records[1].status='unknown';expect(commitmentsPage(config,s,context).meetings[0].decisions.map(row=>row.id)).toEqual(['d']);});

it('reports an unavailable owner field without mislabelling an unresolved decision as unassigned',()=>{const s=source();s.boards[2].fields=[];expect(commitmentsPage(config,s,context)).toMatchObject({partial:true,partialSources:['decision_owner_configuration'],meetings:[{decisions:[{id:'d',ownerId:null,ownerFieldAvailable:false}]}]});});
