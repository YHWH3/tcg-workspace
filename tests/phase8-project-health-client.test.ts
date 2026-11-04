import 'fake-indexeddb/auto';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import {LocalDB} from '../src/core/db';
import {readLocalProjectHealth} from '../src/core/projectHealthLocal';
import {projectHealthConfigSchema} from '../shared/projectHealthConfig';
import {planProjectHealthEdit} from '../shared/projectHealthActions';
import {mutationGuardMatches} from '../shared/mutationGuard';
let store:LocalDB;
const now=Date.parse('2026-10-29T12:00Z'),config=projectHealthConfigSchema.parse({databaseId:'projects'});
const board={id:'projects',_ts:{},kind:'records',templateDbKey:'projects',fields:[{id:'f_owner',type:'person',name:'Owner'},{id:'f_start',type:'date',name:'Start'},{id:'f_end',type:'date',name:'End'}]};
const project={id:'project',_ts:{},boardId:'projects',title:'Current project',p_f_owner:'alice',p_f_start:'2026-10-01',p_f_end:'2026-11-01',createdAt:now};
beforeEach(async()=>{store=new LocalDB('workspace-health-'+crypto.randomUUID());await store.open();await store.boards.put(board);await store.tasks.put(project);});
afterEach(async()=>{vi.restoreAllMocks();store.close();await store.delete();});
const read=()=>readLocalProjectHealth(store,config,{userId:'alice',today:'2026-10-29',timeZone:'Asia/Kolkata',now});
it('reads targeted local sources with the same rules, retaining explicit offline uncertainty',async()=>{
 await store.boards.put({id:'tasks',_ts:{},kind:'tasks',columns:[{id:'todo',name:'Todo'},{id:'done',name:'Done'}]});
 await store.tasks.bulkPut([{id:'task',_ts:{},boardId:'tasks',title:'Linked task',status:'todo',dueDate:'2026-10-28'},{id:'blocker',_ts:{},boardId:'tasks',title:'Blocking task',status:'todo'}]);
 await store.links.bulkPut([{id:'rel',_ts:{},kind:'relation',fromId:'task',toId:'project',fieldId:'f_project'},{id:'dep',_ts:{},kind:'blocks',fromId:'blocker',toId:'task'}]);
 const scan=vi.spyOn(store.tasks,'toArray');const blobs=vi.spyOn(store.blobs,'get');
 const page=await read();expect(page.projects[0].health).toMatchObject({status:'unknown',partialSources:['device_snapshot','offline_approvals']});expect(page.projects[0].health.signals.map(s=>s.rule)).toEqual(['dependency_blocked','overdue_tasks']);expect(page.records.map(r=>r.id).sort()).toEqual(['blocker','project','task']);expect(scan).not.toHaveBeenCalled();expect(blobs).not.toHaveBeenCalled();
});
it('distinguishes empty sources from missing or archived sources',async()=>{
 await store.tasks.delete('project');expect(await read()).toMatchObject({status:'ready',projects:[]});await store.boards.update('projects',{archived:true});expect(await read()).toMatchObject({status:'source_unavailable',projects:[]});
});
it('guards edits against owner/date/scope changes while preserving unrelated edits',()=>{
 const plan=planProjectHealthEdit(project,board,config,{ownerId:'bob',start:'2026-10-02',end:'2026-11-02'});
 expect(plan.patch).toEqual({p_f_owner:'bob',p_f_start:'2026-10-02',p_f_end:'2026-11-02'});
 expect(mutationGuardMatches(plan.guard,{...project,title:'Edited by a teammate'})).toBe(true);
 for(const patch of [{p_f_owner:'carol'},{p_f_start:'2026-10-03'},{boardId:'other'},{deleted:true},{archived:true},{parentId:'other'}])expect(mutationGuardMatches(plan.guard,{...project,...patch})).toBe(false);
 expect(mutationGuardMatches(plan.undoGuard,{...project,...plan.patch})).toBe(true);expect(mutationGuardMatches(plan.undoGuard,{...project,...plan.patch,p_f_end:'2026-11-04'})).toBe(false);
});
it('rejects invalid ranges and changed field schemas before editing',()=>{
 expect(()=>planProjectHealthEdit(project,board,config,{ownerId:'alice',start:'2026-11-02',end:'2026-11-01'})).toThrow('End date');
 expect(()=>planProjectHealthEdit(project,{...board,fields:[]},config,{ownerId:'alice',start:null,end:null})).toThrow('fields changed');
 expect(()=>planProjectHealthEdit(project,board,{...config,endKey:config.startKey},{ownerId:'alice',start:null,end:null})).toThrow('fields changed');
 expect(()=>planProjectHealthEdit(project,board,config,{ownerId:'alice',start:'2026-02-30',end:null})).toThrow('valid');
});
it('does not modify unchanged legacy dates during an owner-only correction',()=>{
 const row={...project,p_f_start:'legacy invalid'};const plan=planProjectHealthEdit(row,board,config,{ownerId:'bob',start:'legacy invalid',end:'2026-11-01'});expect(plan.patch).toEqual({p_f_owner:'bob'});
});
it('keeps changed or deleted configured fields explicit instead of claiming healthy evidence',async()=>{
 await store.boards.update('projects',{fields:[]});const page=await read();expect(page.projects[0].health.partialSources).toContain('field_configuration');
});
