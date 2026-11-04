import 'fake-indexeddb/auto';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import {LocalDB} from '../src/core/db';
import {readLocalCommitments} from '../src/core/commitmentsLocal';
import {commitmentsConfigSchema} from '../shared/commitmentsConfig';
import {planCommitmentEdit} from '../shared/commitmentActions';
import {mutationGuardMatches} from '../shared/mutationGuard';
let db:LocalDB;const config=commitmentsConfigSchema.parse({databaseId:'meetings'}),now=Date.parse('2026-11-03T12:00Z'),fields=[{id:'f_date',name:'Date',type:'date'},{id:'f_actions',name:'Actions',type:'relation',relation:{target:'tasks',primary:true}},{id:'f_decisions',name:'Decisions',type:'relation',relation:{target:'decisions',primary:true}}];
beforeEach(async()=>{db=new LocalDB('workspace-commitments-'+crypto.randomUUID());await db.open();});afterEach(async()=>{vi.restoreAllMocks();db.close();await db.delete();});
it('reads bounded indexed metadata and labels the device snapshot without materializing file bytes',async()=>{
 await db.boards.bulkPut([{id:'meetings',_ts:{},fields},{id:'tasks',_ts:{},columns:[{id:'open'},{id:'done'}]},{id:'decisions',_ts:{},columns:[{id:'open'},{id:'decided'}],fields:[{id:'f_decider',name:'Decision maker',type:'person'}]}]);await db.tasks.bulkPut([{id:'m',_ts:{},boardId:'meetings',p_f_date:'2026-11-02',description:'NEVER_COPY_NOTES'},{id:'t',_ts:{},boardId:'tasks',title:'Action',status:'open',dueDate:'2026-11-01',description:'NEVER_COPY_BODY'}]);await db.links.put({id:'a',_ts:{},kind:'relation',fieldId:'f_actions',fromId:'m',toId:'t'});
 const scan=vi.spyOn(db.tasks,'toArray'),bytes=vi.spyOn(db.blobs,'get'),page=await readLocalCommitments(db,config,'2026-11-03',now);expect(page).toMatchObject({status:'ready',partial:true,partialSources:['device_snapshot'],meetings:[{overdue:[{id:'t'}]}]});expect(JSON.stringify(page)).not.toContain('NEVER_COPY');expect(scan).not.toHaveBeenCalled();expect(bytes).not.toHaveBeenCalled();
 await db.tasks.update('t',{deleted:true});expect((await readLocalCommitments(db,config,'2026-11-03',now)).meetings[0].actions).toEqual([]);
});
it('distinguishes an unavailable database from configuration drift and an empty valid device source',async()=>{
 expect((await readLocalCommitments(db,config,'2026-11-03',now)).status).toBe('source_unavailable');await db.boards.put({id:'meetings',_ts:{},fields:[]});expect((await readLocalCommitments(db,config,'2026-11-03',now)).status).toBe('configuration_required');await db.boards.update('meetings',{fields});expect((await readLocalCommitments(db,config,'2026-11-03',now))).toMatchObject({status:'ready',meetings:[]});
});
it('guards current ownership, date, status, scope and deletion while making no-op edits harmless',()=>{
 const row={id:'t',boardId:'tasks',status:'open',assigneeId:null,dueDate:null},board={id:'tasks',columns:[{id:'open'},{id:'done'}]},plan=planCommitmentEdit(row,board,{ownerId:'alice',date:'2026-11-04'});expect(plan.patch).toEqual({assigneeId:'alice',dueDate:'2026-11-04'});expect(mutationGuardMatches(plan.guard,row)).toBe(true);
 for(const changed of [{assigneeId:'bob'},{dueDate:'2026-11-05'},{status:'done'},{deleted:true},{boardId:'other'}])expect(mutationGuardMatches(plan.guard,{...row,...changed})).toBe(false);
 expect(planCommitmentEdit(row,board,{ownerId:null,date:null}).patch).toEqual({});expect(()=>planCommitmentEdit({...row,status:'done'},board,{ownerId:'alice',date:null})).toThrow();expect(()=>planCommitmentEdit(row,board,{ownerId:null,date:'invalid'})).toThrow();
});
