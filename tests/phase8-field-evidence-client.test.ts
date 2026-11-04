import 'fake-indexeddb/auto';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import {LocalDB} from '../src/core/db';
import {readLocalFieldEvidence} from '../src/core/fieldEvidenceLocal';
import {fieldEvidenceConfigSchema} from '../shared/fieldEvidenceConfig';
import {measurementLayout} from '../shared/measurementLayout';
let db:LocalDB;
beforeEach(async()=>{db=new LocalDB('workspace-field-'+crypto.randomUUID());await db.open();});
afterEach(async()=>{vi.restoreAllMocks();db.close();await db.delete();});
const config=fieldEvidenceConfigSchema.parse({databaseId:'logs'}),fields=[{id:'f_date',name:'Date',type:'date'},{id:'f_measurement',name:'Measurement',type:'number'},{id:'f_unit',name:'Unit',type:'text'},{id:'f_observation',name:'Observation',type:'text'},{id:'f_photos',name:'Photos',type:'url'},...['place','experiment','project'].map(k=>({id:'f_'+k,name:k,type:'relation',relation:{target:k,primary:true}}))];
it('uses targeted account-local indexes and metadata with an explicit partial snapshot',async()=>{
 await db.boards.put({id:'logs',_ts:{},fields});await db.tasks.bulkPut([{id:'observation',_ts:{},boardId:'logs',p_f_date:'2026-10-29',p_f_measurement:0,p_f_unit:'kg',p_f_observation:'Source',captureEvidence:{v:1,photoCount:1}},{id:'place1',_ts:{},boardId:'place',title:'Place'}]);
 await db.links.put({id:'link',_ts:{},kind:'relation',fromId:'observation',toId:'place1',fieldId:'f_place'});await db.files.put({id:'photo',_ts:{},kind:'image',parentId:'observation',parentType:'task'});
 const scan=vi.spyOn(db.tasks,'toArray'),bytes=vi.spyOn(db.blobs,'get'),result=await readLocalFieldEvidence(db,config,1);
 expect(result).toMatchObject({partial:true,partialSources:['device_snapshot'],records:[{places:['place1'],photoEvidence:'available',missing:['experiment_or_project']}],series:{points:[{value:0}]}});expect(scan).not.toHaveBeenCalled();expect(bytes).not.toHaveBeenCalled();
 await db.files.update('photo',{deleted:true});expect((await readLocalFieldEvidence(db,config,2)).records[0].missing).toContain('photo');
});
it('distinguishes missing database, drift and an empty configured source',async()=>{
 expect(await readLocalFieldEvidence(db,config,0)).toMatchObject({status:'source_unavailable',records:[]});await db.boards.put({id:'logs',_ts:{},fields:[]});expect((await readLocalFieldEvidence(db,config,0)).status).toBe('configuration_required');await db.boards.update('logs',{fields});expect(await readLocalFieldEvidence(db,config,0)).toMatchObject({status:'ready',records:[],sessions:[]});
});
it('does not retain deleted or unrelated source rows',async()=>{
 await db.boards.put({id:'logs',_ts:{},fields});await db.tasks.bulkPut([{id:'deleted',_ts:{},boardId:'logs',deleted:true},{id:'other',_ts:{},boardId:'unrelated'},{id:'child',_ts:{},boardId:'logs',parentId:'parent'}]);expect((await readLocalFieldEvidence(db,config,0)).records).toEqual([]);
});
it('plots extreme signed values without infinite geometry and keeps same-day sources distinct',()=>{
 const points=[{date:'2026-10-29',value:-1e308,recordId:'a'},{date:'2026-10-29',value:1e308,recordId:'b'}],result=measurementLayout(points);expect(result.points.map(p=>p.x)).toEqual([320,320]);expect(result.points.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y))).toBe(true);expect(result.min).toBe(-1e308);expect(result.max).toBe(1e308);expect(result.path).not.toMatch(/Infinity|NaN/);
});
it('handles empty, single, zero and irregular date spacing without inventing values',()=>{
 expect(measurementLayout([])).toMatchObject({points:[],min:null,max:null});expect(measurementLayout([{date:'2026-01-01',value:0,recordId:'a'}]).points[0]).toMatchObject({x:320,y:120,value:0});
 const result=measurementLayout([{date:'2026-01-01',value:1,recordId:'a'},{date:'2026-01-02',value:1,recordId:'b'},{date:'2026-01-11',value:1,recordId:'c'}]);expect(result.points[1].x-result.points[0].x).toBeCloseTo((result.points[2].x-result.points[0].x)/10);expect(result.points.every(p=>p.y===120)).toBe(true);
});
