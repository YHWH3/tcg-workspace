import {expect,it} from 'vitest';
import {fieldEvidencePage,type FieldEvidenceSnapshot} from '../shared/fieldEvidence';
import {fieldEvidenceConfigSchema} from '../shared/fieldEvidenceConfig';
import {groupSessions,type FieldLogEntry} from '../shared/fieldSessions';
import {measurementSeries} from '../shared/measurements';
const config=fieldEvidenceConfigSchema.parse({databaseId:'logs'}),fields=[{id:'f_date',name:'Date',type:'date'},{id:'f_measurement',name:'Measurement',type:'number'},{id:'f_unit',name:'Unit',type:'text'},{id:'f_observation',name:'Observation',type:'text'},{id:'f_photos',name:'Photos',type:'url'},...['place','experiment','project'].map(k=>({id:'f_'+k,name:k,type:'relation',relation:{target:k,primary:true}}))];
const log=(id:string,extra:Record<string,unknown>={})=>({id,boardId:'logs',title:'Field '+id,p_f_date:'2026-10-29',p_f_measurement:0,p_f_unit:' kg ',p_f_observation:'Observed, not interpreted',...extra});
const snapshot=(logs=[log('a')]):FieldEvidenceSnapshot=>({logs,boards:[{id:'logs',fields}],targets:[{id:'place1',boardId:'place',title:'Place'},{id:'experiment1',boardId:'experiment',title:'Experiment'}],links:logs.flatMap(r=>['place','experiment'].map(k=>({id:r.id+k,kind:'relation',fieldId:'f_'+k,fromId:r.id,toId:k+'1'}))),files:[],partialSources:[]});
const entry=(id:string,extra:Partial<FieldLogEntry>={}):FieldLogEntry=>({id,title:id,databaseId:'logs',url:'/record/'+id,date:'2026-10-29',measurement:1,unit:'kg',places:['place1'],experiments:['experiment1'],projects:[],missing:[],photoIntent:'unknown',photoEvidence:'unknown',issues:[],...extra});
it('groups visits by date/place/experiment and sorts records without changing sources',()=>{
 const logs=[entry('z'),entry('a'),entry('b',{date:'2026-10-28'}),entry('c',{places:['other']}),entry('u',{date:null,missing:['date']})],before=structuredClone(logs),sessions=groupSessions(logs);
 expect(sessions).toHaveLength(4);expect(sessions.find(s=>s.recordIds.includes('z'))).toMatchObject({recordIds:['a','z'],missingCount:0,unknownPhotoCount:2});expect(sessions.at(-1)?.date).toBe(null);expect(logs).toEqual(before);
});
it('normalizes relation order and uses exact tuple keys, not delimiter concatenation',()=>{
 expect(groupSessions([entry('a',{places:['a,b','c']}),entry('b',{places:['c','a,b']}),entry('c',{places:['a','b,c']})]).map(s=>s.recordIds)).toEqual([['c'],['a','b']]);
});
it('keeps zero/negative measurements, normalizes units and sorts same-date points by id',()=>{
 expect(measurementSeries([entry('z',{measurement:-2,unit:' KG '}),entry('a',{measurement:0}),entry('b',{date:'2026-10-28'})],{})).toMatchObject({unit:'kg',units:['kg'],partial:false,points:[{recordId:'b',value:1},{recordId:'a',value:0},{recordId:'z',value:-2}]});
});
it('refuses mixed units and only filters a unit after explicit selection, without converting',()=>{
 const logs=[entry('a'),entry('b',{unit:'cm',measurement:100})];expect(measurementSeries(logs,{})).toMatchObject({error:'mixed_units',units:['cm','kg'],points:[],partial:true});
 expect(measurementSeries(logs,{unit:' KG '})).toMatchObject({unit:'kg',points:[{recordId:'a',value:1}],excludedByUnit:1,partial:false});
 expect(measurementSeries(logs,{unit:'m'})).toMatchObject({unit:'m',points:[],excludedByUnit:2});
});
it('keeps invalid dates and absent units out of points with explicit omissions',()=>{
 expect(measurementSeries([entry('a',{date:null}),entry('b',{unit:' '}),entry('c',{measurement:null})],{})).toMatchObject({points:[],partial:true,omitted:[{recordId:'a',reason:'date'},{recordId:'b',reason:'unit'}]});
});
it('filters measurement contexts through authorized relation ids',()=>{
 expect(measurementSeries([entry('a'),entry('b',{experiments:['other']}),entry('c',{places:['other']})],{experimentId:'experiment1',placeId:'place1'}).points.map(p=>p.recordId)).toEqual(['a']);
});
it('normalizes actual fields and preserves unknown historical photo intent',()=>{
 const source=snapshot(),before=structuredClone(source),page=fieldEvidencePage(config,source,10);
 expect(page).toMatchObject({status:'ready',asOf:10,partial:false,records:[{measurement:0,unit:'kg',missing:[],photoIntent:'unknown',photoEvidence:'unknown'}],series:{points:[{value:0}]}});expect(source).toEqual(before);expect(page.interpretation).toContain('no AI');expect(page.trust).toEqual({untrusted:true,instructions:false});
});
it('finds missing context, measurement unit, observation and planned photo evidence',()=>{
 const source=snapshot([log('a',{p_f_unit:' ',p_f_observation:' ',captureEvidence:{v:1,photoCount:2}})]);source.links=[];
 expect(fieldEvidencePage(config,source,0).records[0]).toMatchObject({missing:['place','experiment_or_project','unit','observation','photo'],photoEvidence:'unavailable'});
 source.files=[{id:'image',parentId:'a',kind:'image'}];expect(fieldEvidencePage(config,source,0).records[0].missing).not.toContain('photo');
 source.files[0].deleted=true;expect(fieldEvidencePage(config,source,0).records[0].missing).toContain('photo');
});
it('accepts Project context when Experiment is absent and excludes unrelated links',()=>{
 const source=snapshot();source.links=source.links.filter(l=>l.fieldId!=='f_experiment');source.targets.push({id:'project1',boardId:'project'});source.links.push({id:'p',kind:'relation',fieldId:'f_project',fromId:'a',toId:'project1'},{id:'unrelated',kind:'related',fieldId:'f_experiment',fromId:'a',toId:'experiment1'});
 expect(fieldEvidencePage(config,source,0).records[0]).toMatchObject({experiments:[],projects:['project1'],missing:[]});
});
it('redacts deleted/wrong-database targets and never turns generic related context into Place',()=>{
 const source=snapshot();source.targets[0].deleted=true;source.targets[1].boardId='other';source.links.push({id:'generic',kind:'related',fieldId:'f_place',fromId:'a',toId:'place1'});
 const page=fieldEvidencePage(config,source,0);expect(page.records[0]).toMatchObject({places:[],experiments:[],missing:['place','experiment_or_project'],issues:['context_unavailable']});expect(page.context).toEqual([]);expect(page.partial).toBe(true);
});
it('honors reverse relation direction and deduplicates context',()=>{
 const source=snapshot();source.boards[0].fields=fields.map(f=>f.id==='f_place'?{...f,relation:{target:'place',primary:false,pairedFieldId:'observations'}}:f);source.links[0]={id:'r',kind:'relation',fieldId:'observations',fromId:'place1',toId:'a'};source.links.push({...source.links[0],id:'r2'});
 expect(fieldEvidencePage(config,source,0).records[0].places).toEqual(['place1']);
});
it('reports malformed values and schema drift rather than manufacturing trustworthy observations',()=>{
 const source=snapshot([log('a',{p_f_measurement:'5',p_f_date:'2026-02-30',captureEvidence:{v:9,photoCount:4}})]),page=fieldEvidencePage(config,source,0);
 expect(page.records[0]).toMatchObject({measurement:null,date:null,missing:['date'],photoEvidence:'unknown',issues:['capture_provenance_invalid','measurement_invalid']});expect(page.partial).toBe(true);
 source.boards[0].fields=[];expect(fieldEvidencePage(config,source,0)).toMatchObject({status:'configuration_required',partial:true,records:[]});source.boards=[];expect(fieldEvidencePage(config,source,0).status).toBe('source_unavailable');
});
it('keeps capped file evidence unknown and distinguishes a new capture without planned photos',()=>{
 const source=snapshot([log('a',{captureEvidence:{v:1,photoCount:1}})]);source.partialSources=['files'];expect(fieldEvidencePage(config,source,0).records[0]).toMatchObject({photoIntent:'planned',photoEvidence:'unknown',missing:[]});
 source.logs[0].captureEvidence={v:1,photoCount:0};expect(fieldEvidencePage(config,source,0).records[0].photoEvidence).toBe('not_planned');
});
it('keeps session limits/missing-only/context filters explicit and excludes deleted logs',()=>{
 const source=snapshot([log('a'),log('b',{p_f_date:'2026-10-28',p_f_observation:''}),log('c',{deleted:true})]);
 const page=fieldEvidencePage({...config,limit:1},source,0);expect(page.records).toHaveLength(2);expect(page.sessions).toHaveLength(1);expect(page.partialSources).toContain('session_selection');
 expect(fieldEvidencePage({...config,missingOnly:true},source,0).sessions[0].recordIds).toEqual(['b']);expect(fieldEvidencePage({...config,placeId:'other'},source,0).records).toEqual([]);
});
it('validates stored/HTTP/MCP configuration limits at one boundary',()=>{
 for(const value of [{},{databaseId:'logs',limit:0},{databaseId:'logs',limit:51},{databaseId:'logs',unit:'x'.repeat(101)},{databaseId:'logs',dateKey:'description'},{databaseId:'logs',placeKey:'f_place'}])expect(fieldEvidenceConfigSchema.safeParse(value).success).toBe(false);
});
it('requires a valid web photo link and reports unsupported schemes as missing evidence',()=>{
 for(const value of ['https://[','javascript:alert(1)','file:///private/photo.png']){
  const page=fieldEvidencePage(config,snapshot([log('a',{p_f_photos:value,captureEvidence:{v:1,photoCount:1}})]),0);
  expect(page.records[0]).toMatchObject({photoEvidence:'unavailable',missing:['photo'],issues:['photo_link_invalid']});
 }
 expect(fieldEvidencePage(config,snapshot([log('a',{p_f_photos:'https://example.org/photos',captureEvidence:{v:1,photoCount:1}})]),0).records[0]).toMatchObject({photoEvidence:'available',missing:[]});
});

it('treats absent and explicitly cleared historical capture intent consistently',()=>{
 for(const captureEvidence of [undefined,null]){
  const page=fieldEvidencePage(config,snapshot([log('a',{captureEvidence})]),0);
  expect(page.records[0]).toMatchObject({photoIntent:'unknown',photoEvidence:'unknown',issues:[],missing:[]});expect(page.partial).toBe(false);
 }
});
