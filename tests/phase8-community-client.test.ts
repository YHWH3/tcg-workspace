import 'fake-indexeddb/auto';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import {LocalDB} from '../src/core/db';
import {readLocalEventOps} from '../src/core/eventOpsLocal';
import {eventOpsConfigSchema} from '../shared/eventOpsConfig';
let db:LocalDB;
const config=eventOpsConfigSchema.parse({databaseId:'events'}),now=Date.parse('2026-10-31T12:00Z'),fields=[{id:'f_start',type:'date',name:'Start'},{id:'f_capacity',type:'number',name:'Capacity'},...['facilitators','volunteers','participants'].map(role=>({id:'f_'+role,type:'relation',name:role,relation:{target:'people',primary:true}}))];
beforeEach(async()=>{db=new LocalDB('workspace-community-'+crypto.randomUUID());await db.open();});
afterEach(async()=>{vi.restoreAllMocks();db.close();await db.delete();});
it('uses indexed current-account metadata and exposes device incompleteness without fetching bodies or bytes',async()=>{
 await db.boards.bulkPut([{id:'events',_ts:{},fields},{id:'people',_ts:{}}]);await db.tasks.bulkPut([{id:'e1',_ts:{},boardId:'events',title:'Event',p_f_start:'2026-11-01',p_f_capacity:1},{id:'p1',_ts:{},boardId:'people',title:'Synthetic person',p_email:'NEVER_COPY_EMAIL',description:'NEVER_COPY_BIO'}]);await db.links.put({id:'l1',_ts:{},kind:'relation',fromId:'e1',toId:'p1',fieldId:'f_participants',createdAt:now-1});
 const scan=vi.spyOn(db.tasks,'toArray'),bytes=vi.spyOn(db.blobs,'get'),page=await readLocalEventOps(db,config,'2026-10-31',now);
 expect(page).toMatchObject({status:'ready',partial:true,partialSources:['device_snapshot'],events:[{coverage:{participants:1,remaining:0},recentParticipants:[{id:'p1'}]}]});expect(JSON.stringify(page)).not.toContain('NEVER_COPY');expect(scan).not.toHaveBeenCalled();expect(bytes).not.toHaveBeenCalled();
 await db.tasks.update('p1',{deleted:true});expect((await readLocalEventOps(db,config,'2026-10-31',now)).events[0].coverage.participants).toBe(0);
});
it('distinguishes missing source, field drift and an empty valid source on device',async()=>{
 expect((await readLocalEventOps(db,config,'2026-10-31',now)).status).toBe('source_unavailable');await db.boards.put({id:'events',_ts:{},fields:[]});expect((await readLocalEventOps(db,config,'2026-10-31',now)).status).toBe('configuration_required');await db.boards.update('events',{fields});expect(await readLocalEventOps(db,config,'2026-10-31',now)).toMatchObject({status:'ready',events:[]});
});
it('does not include unrelated, deleted or nested Events in the upcoming overview, but supports an explicitly selected child',async()=>{
 await db.boards.put({id:'events',_ts:{},fields});await db.tasks.bulkPut([{id:'other',_ts:{},boardId:'other',p_f_start:'2026-11-01'},{id:'deleted',_ts:{},boardId:'events',deleted:true,p_f_start:'2026-11-01'},{id:'child',_ts:{},boardId:'events',parentId:'parent',p_f_start:'2026-11-01'}]);expect((await readLocalEventOps(db,config,'2026-10-31',now)).events).toEqual([]);expect((await readLocalEventOps(db,{...config,eventId:'child'},'2026-10-31',now)).events.map(event=>event.id)).toEqual(['child']);
});
