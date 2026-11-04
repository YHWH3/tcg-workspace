import {fieldsOf} from './fields';
import {parseDateOnly} from './dates';
import {recordHref} from './recordRoutes';
import {captureEvidenceSchema,type FieldEvidenceConfig} from './fieldEvidenceConfig';
import {groupSessions,type FieldLogEntry,type FieldGap} from './fieldSessions';
import {measurementSeries} from './measurements';
export type FieldEvidenceRecord={id:string;deleted?:unknown;archived?:unknown}&Record<string,unknown>;
export interface FieldEvidenceLink {id:string;kind:string;fieldId:string;fromId:string;toId:string;deleted?:boolean;archived?:boolean}
export interface FieldEvidenceFile {id:string;parentId:string;kind:string;deleted?:boolean;archived?:boolean}
export interface FieldEvidenceSnapshot {logs:FieldEvidenceRecord[];targets:FieldEvidenceRecord[];boards:FieldEvidenceRecord[];links:FieldEvidenceLink[];files:FieldEvidenceFile[];partialSources:string[];observationPresence?:Map<string,Record<string,boolean>>}
/** Untyped record fields are normalized once here. Neither UI nor MCP treats
 * visitor/user text as instructions or interprets observations through AI. */
export function fieldEvidencePage(config:FieldEvidenceConfig,snapshot:FieldEvidenceSnapshot,now:number){
 const active=(r:{deleted?:unknown;archived?:unknown})=>!r.deleted&&!r.archived,boards=new Map(snapshot.boards.filter(active).map(b=>[b.id,b])),board=boards.get(config.databaseId),fields=fieldsOf({fields:board?.fields});
 const text=(v:unknown)=>typeof v==='string'?v.trim():'',targets=new Map(snapshot.targets.filter(active).map(r=>[r.id,r]));
 const scalarKeys=[config.dateKey,config.measurementKey,config.unitKey,config.observationKey,config.photoKey],relationKeys=[config.placeKey,config.experimentKey,config.projectKey];
 const valid=!!board&&scalarKeys.every((key,i)=>fields.some(f=>`p_${f.id}`===key&&f.type===['date','number','text','text','url'][i]))&&relationKeys.every(key=>fields.some(f=>`rel_${f.id}`===key&&f.type==='relation'&&!!f.relation));
 const partialSources=new Set(snapshot.partialSources);if(!valid)partialSources.add('field_configuration');
 const entries:FieldLogEntry[]=valid?snapshot.logs.filter(active).filter(r=>r.boardId===config.databaseId&&!r.parentId).map(log=>{
  const issues:string[]=[],relations=relationKeys.map(key=>{
   const field=fields.find(f=>`rel_${f.id}`===key)!,relation=field.relation!,reverse=relation.primary!==true&&!!relation.pairedFieldId,fieldId=reverse?relation.pairedFieldId!:field.id;
   const ids=[...new Set(snapshot.links.filter(l=>active(l)&&l.kind==='relation'&&l.fieldId===fieldId&&(reverse?l.toId===log.id:l.fromId===log.id)).map(l=>reverse?l.fromId:l.toId))];
   return ids.filter(id=>{const target=targets.get(id);if(!target||target.boardId!==relation.target){issues.push('context_unavailable');return false;}return true;}).sort();
  });
  const date=parseDateOnly(log[config.dateKey])?String(log[config.dateKey]):null,raw=log[config.measurementKey],measurement=typeof raw==='number'&&Number.isFinite(raw)?raw:null,unitRaw=log[config.unitKey],unitValue=text(unitRaw),unitInvalid=typeof unitRaw==='string'&&(unitRaw.length>2048||unitValue.length>100),unit=unitInvalid?'':unitValue;
  if(unitInvalid)issues.push('unit_invalid');
  if(raw!==undefined&&raw!==null&&raw!==''&&measurement===null)issues.push('measurement_invalid');
  const provenance=captureEvidenceSchema.safeParse(log.captureEvidence),photoRaw=log[config.photoKey],photo=text(photoRaw),photoTooLong=typeof photoRaw==='string'&&photoRaw.length>2048,hasImage=snapshot.files.some(f=>active(f)&&f.parentId===log.id&&f.kind==='image');
  let hasUrl=false;
  if(photo&&!photoTooLong){try{const url=new URL(photo);hasUrl=['https:','http:'].includes(url.protocol)&&!!url.hostname;}catch{issues.push('photo_link_invalid');}}
  if((photo||photoTooLong)&&!hasUrl&&!issues.includes('photo_link_invalid'))issues.push('photo_link_invalid');
  const photoEvidence:FieldLogEntry['photoEvidence']=hasUrl||hasImage?'available':provenance.success?(provenance.data.photoCount>0?(snapshot.partialSources.includes('files')?'unknown':'unavailable'):'not_planned'):'unknown';
  if(log.captureEvidence!=null&&!provenance.success)issues.push('capture_provenance_invalid');
  const hasObservation=snapshot.observationPresence?.get(log.id)?.[config.observationKey]??!!text(log[config.observationKey]);
  const missing:FieldGap[]=[];if(!date)missing.push('date');if(!relations[0].length)missing.push('place');if(!relations[1].length&&!relations[2].length)missing.push('experiment_or_project');if(measurement!==null&&!unit)missing.push('unit');if(!hasObservation)missing.push('observation');if(photoEvidence==='unavailable')missing.push('photo');
  return {id:log.id,title:Array.from(text(log.title)).slice(0,300).join('')||'Untitled observation',databaseId:config.databaseId,url:recordHref(config.databaseId,undefined,log.id),date,measurement,unit,places:relations[0],experiments:relations[1],projects:relations[2],missing,photoIntent:provenance.success?(provenance.data.photoCount>0?'planned' as const:'not_planned' as const):'unknown' as const,photoEvidence,issues:[...new Set(issues)].sort()};
 }):[];
 const selected=entries.filter(r=>(!config.experimentId||r.experiments.includes(config.experimentId))&&(!config.placeId||r.places.includes(config.placeId))),allSessions=groupSessions(selected.filter(r=>!config.missingOnly||r.missing.length>0));
 if(allSessions.length>config.limit)partialSources.add('session_selection');
 const refs=new Set(selected.flatMap(r=>[...r.places,...r.experiments,...r.projects])),series=measurementSeries(selected,config);
 return {status:board?(valid?'ready' as const:'configuration_required' as const):'source_unavailable' as const,asOf:now,partial:partialSources.size>0||series.partial||selected.some(r=>r.issues.length>0),partialSources:[...partialSources].sort(),records:selected,sessions:allSessions.slice(0,config.limit),series,context:[...targets.values()].filter(r=>refs.has(r.id)).map(r=>({id:r.id,title:Array.from(text(r.title)).slice(0,300).join('')||'Untitled context',url:recordHref(String(r.boardId),undefined,r.id)})),trust:{untrusted:true as const,instructions:false as const},interpretation:'Observations are source data; no AI interpretation has been written.'};
}
export type FieldEvidencePage=ReturnType<typeof fieldEvidencePage>;
